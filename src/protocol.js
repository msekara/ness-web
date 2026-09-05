'use strict';

/**
 * Ness D8x/D16x ASCII Serial Protocol
 *
 * Packet layout (all fields are ASCII hex characters):
 *
 *   [start][address][length][command][data][timestamp][checksum][CRLF]
 *     1B       1B      1B      1B      nB     12B (opt)   1B      2B
 *
 * All byte values are encoded as 2 ASCII hex characters except:
 *   - start/address/length/command/checksum = 1 byte = 2 hex chars
 *   - data = variable, each byte = 2 hex chars  (non-UI command path)
 *   - USER_INTERFACE commands send data as plain ASCII (half mode)
 *
 * Commands sent by the host (us) always use the USER_INTERFACE command type
 * (0x60) with start=0x83 and no address/timestamp fields.
 *
 * Events received from the panel are either:
 *   - SYSTEM_STATUS  (0x61) — real-time zone/arm/output events
 *   - USER_INTERFACE (0x60) — responses to our status-poll commands
 *
 * Checksum: two's complement of the sum of all preceding ASCII byte values.
 *   checksum = (256 - (sum_of_bytes & 0xFF)) % 256
 *
 * Reference: Ness D8-D16 ASCII Protocol spec (rev 13+), as implemented by
 * https://github.com/nickw444/nessclient (MIT licence, used for reference).
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const COMMAND_TYPE = {
  USER_INTERFACE: 0x60,
  SYSTEM_STATUS:  0x61,
};

// start byte for HOST → PANEL USER_INTERFACE commands (no address, no timestamp)
const START_USER_INTERFACE_REQ = 0x83;

// Status request IDs (data byte sent as "SXX" where XX is 2-digit hex)
const REQUEST_ID = {
  ZONE_1_16_UNSEALED:  0x00,
  ZONE_17_32_UNSEALED: 0x20,
  ARMING:              0x14,
  OUTPUTS:             0x15,
  AUXILIARY_OUTPUTS:   0x18,
  VIEW_STATE:          0x16,
  PANEL_VERSION:       0x17,
};

// System status event types (from SYSTEM_STATUS packets)
const EVENT_TYPE = {
  UNSEALED:            0x00,
  SEALED:              0x01,
  ALARM:               0x02,
  ALARM_RESTORE:       0x03,
  MANUAL_EXCLUDE:      0x04,
  MANUAL_INCLUDE:      0x05,
  AUTO_EXCLUDE:        0x06,
  AUTO_INCLUDE:        0x07,
  TAMPER_UNSEALED:     0x08,
  TAMPER_NORMAL:       0x09,
  POWER_FAILURE:       0x10,
  POWER_NORMAL:        0x11,
  BATTERY_FAILURE:     0x12,
  BATTERY_NORMAL:      0x13,
  ENTRY_DELAY_START:   0x20,
  ENTRY_DELAY_END:     0x21,
  EXIT_DELAY_START:    0x22,
  EXIT_DELAY_END:      0x23,
  ARMED_AWAY:          0x24,
  ARMED_HOME:          0x25,
  ARMED_DAY:           0x26,
  ARMED_NIGHT:         0x27,
  ARMED_VACATION:      0x28,
  ARMED_HIGHEST:       0x2E,
  DISARMED:            0x2F,
  OUTPUT_ON:           0x31,
  OUTPUT_OFF:          0x32,
};

// Arming status bit flags (from ARMING status update, bytes reversed from Ness docs)
const ARMING_FLAG = {
  AREA_1_ARMED:       0x0100,
  AREA_2_ARMED:       0x0200,
  AREA_1_FULLY_ARMED: 0x0400,
  AREA_2_FULLY_ARMED: 0x0800,
  MONITOR_ARMED:      0x1000,
  DAY_MODE_ARMED:     0x2000,
  ENTRY_DELAY_1_ON:   0x4000,
  ENTRY_DELAY_2_ON:   0x8000,
  MANUAL_EXCLUDE_MODE:0x0001,
  MEMORY_MODE:        0x0002,
};

// Zone bit positions in ZONE_1_16 updates (note: bytes are in little-endian pairs)
const ZONE_1_16_BITS = {
  1:  0x0100, 2:  0x0200, 3:  0x0400, 4:  0x0800,
  5:  0x1000, 6:  0x2000, 7:  0x4000, 8:  0x8000,
  9:  0x0001, 10: 0x0002, 11: 0x0004, 12: 0x0008,
  13: 0x0010, 14: 0x0020, 15: 0x0040, 16: 0x0080,
};

const ZONE_17_32_BITS = {
  17: 0x0100, 18: 0x0200, 19: 0x0400, 20: 0x0800,
  21: 0x1000, 22: 0x2000, 23: 0x4000, 24: 0x8000,
  25: 0x0001, 26: 0x0002, 27: 0x0004, 28: 0x0008,
  29: 0x0010, 30: 0x0020, 31: 0x0040, 32: 0x0080,
};

// Output bit flags (OUTPUTS status update)
const OUTPUT_FLAG = {
  SIREN_LOUD:            0x0100,
  SIREN_SOFT:            0x0200,
  SIREN_SOFT_MONITOR:    0x0400,
  SIREN_SOFT_FIRE:       0x0800,
  STROBE:                0x1000,
  RESET:                 0x2000,
  SONALART:              0x4000,
  KEYPAD_DISPLAY_ENABLE: 0x8000,
  AUX1:                  0x0001,
  AUX2:                  0x0002,
  AUX3:                  0x0004,
  AUX4:                  0x0008,
  MONITOR_OUT:           0x0010,
  POWER_FAIL:            0x0020,
  PANEL_BATT_FAIL:       0x0040,
  TAMPER_XPAND:          0x0080,
};

// AUX output bits (AUXILIARY_OUTPUTS status update)
const AUX_OUTPUT_BITS = {
  1: 0x0001, 2: 0x0002, 3: 0x0004, 4: 0x0008,
  5: 0x0010, 6: 0x0020, 7: 0x0040, 8: 0x0080,
};

// ─── Packet encoding ─────────────────────────────────────────────────────────

/**
 * Encode a USER_INTERFACE command packet (what the host sends to the panel).
 *
 * Packet structure for host→panel commands:
 *   start=0x83, NO address, length=len(data), command=0x60, data (ASCII), checksum, CRLF
 *
 * @param {string} commandData  e.g. "AE", "HE", "1234E", "S00", "11*", "11#"
 * @returns {string} ASCII-encoded packet ready to send (includes CRLF)
 */
function encodeCommand(commandData) {
  const start   = START_USER_INTERFACE_REQ; // 0x83
  const length  = commandData.length;       // plain ASCII length for UI packets
  const command = COMMAND_TYPE.USER_INTERFACE; // 0x60

  let packet = '';
  packet += hex2(start);
  packet += hex2(length);
  packet += hex2(command);
  packet += commandData;

  const checksum = calcChecksum(packet);
  packet += hex2(checksum).toUpperCase();
  packet += '\r\n';

  return packet;
}

/**
 * Calculate the Ness two's-complement checksum.
 * Sum all ASCII character codes in the packet so far, then:
 *   checksum = (256 - (sum & 0xFF)) % 256
 *
 * @param {string} packetStr  The packet string BEFORE appending the checksum
 * @returns {number}
 */
function calcChecksum(packetStr) {
  let sum = 0;
  for (let i = 0; i < packetStr.length; i++) {
    sum += packetStr.charCodeAt(i);
  }
  return (256 - (sum & 0xFF)) % 256;
}

/**
 * Format a number as a 2-character zero-padded hex string.
 * @param {number} n
 * @returns {string}
 */
function hex2(n) {
  return n.toString(16).padStart(2, '0');
}

// ─── Packet decoding ─────────────────────────────────────────────────────────

/**
 * Attempt to extract one complete packet from a raw ASCII buffer.
 * Packets end with \r\n.
 *
 * @param {string} buffer
 * @returns {{ packet: string, remaining: string } | null}
 *   Returns null if no complete packet is available yet.
 */
function extractPacket(buffer) {
  const end = buffer.indexOf('\n');
  if (end === -1) return null;

  const packet = buffer.slice(0, end + 1).replace(/\r?\n$/, '');
  const remaining = buffer.slice(end + 1);
  return { packet, remaining };
}

/**
 * Decode a raw ASCII packet string from the panel into a structured object.
 *
 * @param {string} raw  e.g. "8200036017000004..."
 * @returns {{ type: string, raw: string, ...fields } | null}
 */
function decodePacket(raw) {
  try {
    if (raw.length < 8) return null;

    let pos = 0;

    // start byte
    const start = parseInt(raw.slice(pos, pos + 2), 16);
    pos += 2;

    const hasAddress   = !!(start & 0x01) || (start === 0x82 && raw.length === 16);
    const hasTimestamp = !!(start & 0x04);
    const isUIResp     = start === 0x82;
    const isUIReq      = start === 0x83;

    // address (only in certain packets)
    let address = null;
    if (hasAddress) {
      if (isUIReq) {
        address = parseInt(raw.slice(pos, pos + 1), 16);
        pos += 1;
      } else {
        address = parseInt(raw.slice(pos, pos + 2), 16);
        pos += 2;
      }
    }

    // length + seq
    const lengthByte = parseInt(raw.slice(pos, pos + 2), 16);
    pos += 2;
    const seq        = lengthByte >> 7;
    const dataLength = lengthByte & 0x7F;

    // command type
    const commandByte = parseInt(raw.slice(pos, pos + 2), 16);
    pos += 2;

    // data field — number of ASCII chars depends on command type
    let dataChars;
    if (isUIResp || isUIReq) {
      // USER_INTERFACE: each data byte is 1 ASCII char (half mode)
      dataChars = dataLength;
    } else {
      // SYSTEM_STATUS: each data byte is 2 hex chars
      dataChars = dataLength * 2;
    }
    const data = raw.slice(pos, pos + dataChars);
    pos += dataChars;

    // optional timestamp (12 ASCII decimal digits: YYMMDDHHmmss)
    let timestamp = null;
    if (hasTimestamp) {
      const ts = raw.slice(pos, pos + 12);
      pos += 12;
      timestamp = decodeTimestamp(ts);
    }

    // checksum (last 2 chars before CRLF — just consume, not verified here)
    // const checksum = parseInt(raw.slice(pos, pos + 2), 16);

    if (commandByte === COMMAND_TYPE.SYSTEM_STATUS) {
      return decodeSystemStatusPacket(data, address, timestamp, raw);
    } else if (commandByte === COMMAND_TYPE.USER_INTERFACE) {
      return decodeUserInterfacePacket(data, address, timestamp, isUIResp, raw);
    }

    return { type: 'UNKNOWN', raw, commandByte, data };
  } catch (err) {
    return { type: 'DECODE_ERROR', raw, error: err.message };
  }
}

// ─── System status events ────────────────────────────────────────────────────

function decodeSystemStatusPacket(data, address, timestamp, raw) {
  if (data.length < 6) return { type: 'SYSTEM_STATUS_INCOMPLETE', raw, data };

  const eventTypeByte = parseInt(data.slice(0, 2), 16);
  const zone          = parseInt(data.slice(2, 4), 10); // decimal-encoded
  const area          = parseInt(data.slice(4, 6), 16);

  const eventName = Object.keys(EVENT_TYPE).find(k => EVENT_TYPE[k] === eventTypeByte)
    || `UNKNOWN_0x${hex2(eventTypeByte)}`;

  return {
    type:      'SYSTEM_STATUS',
    eventType: eventTypeByte,
    eventName,
    zone,
    area,
    address,
    timestamp,
    raw,
  };
}

// ─── User interface / status update events ───────────────────────────────────

function decodeUserInterfacePacket(data, address, timestamp, isResp, raw) {
  if (!isResp) {
    // Echoed command from us — generally ignore
    return { type: 'UI_ECHO', data, address, timestamp, raw };
  }

  if (data.length < 2) return { type: 'UI_RESP_SHORT', raw, data };

  const reqId = parseInt(data.slice(0, 2), 16);

  switch (reqId) {
    case REQUEST_ID.ZONE_1_16_UNSEALED:
      return decodeZoneUpdate(data, 'ZONE_1_16_UPDATE', ZONE_1_16_BITS, address, timestamp, raw);

    case REQUEST_ID.ZONE_17_32_UNSEALED:
      return decodeZoneUpdate(data, 'ZONE_17_32_UPDATE', ZONE_17_32_BITS, address, timestamp, raw);

    case REQUEST_ID.ARMING:
      return decodeArmingUpdate(data, address, timestamp, raw);

    case REQUEST_ID.OUTPUTS:
      return decodeOutputsUpdate(data, address, timestamp, raw);

    case REQUEST_ID.AUXILIARY_OUTPUTS:
      return decodeAuxOutputsUpdate(data, address, timestamp, raw);

    case REQUEST_ID.VIEW_STATE:
      return { type: 'VIEW_STATE_UPDATE', data, address, timestamp, raw };

    case REQUEST_ID.PANEL_VERSION:
      return { type: 'PANEL_VERSION_UPDATE', data, address, timestamp, raw };

    default:
      return { type: 'UI_RESP_UNKNOWN', reqId, data, address, timestamp, raw };
  }
}

/**
 * Decode an unsigned short (16-bit) bitmask from 4 hex chars in a UI response.
 * The panel sends data after the 2-char request ID.
 */
function decodeUnsignedShort(data) {
  // data is 4 ASCII hex chars representing 2 bytes
  return parseInt(data.slice(2, 6), 16);
}

function decodeZoneUpdate(data, type, zoneBits, address, timestamp, raw) {
  const mask = decodeUnsignedShort(data);
  const unsealedZones = [];

  for (const [zone, bit] of Object.entries(zoneBits)) {
    if (mask & bit) unsealedZones.push(parseInt(zone, 10));
  }

  return { type, unsealedZones, address, timestamp, raw };
}

function decodeArmingUpdate(data, address, timestamp, raw) {
  const mask   = decodeUnsignedShort(data);
  const status = {};

  for (const [name, bit] of Object.entries(ARMING_FLAG)) {
    status[name] = !!(mask & bit);
  }

  return { type: 'ARMING_UPDATE', status, address, timestamp, raw };
}

function decodeOutputsUpdate(data, address, timestamp, raw) {
  const mask    = decodeUnsignedShort(data);
  const outputs = {};

  for (const [name, bit] of Object.entries(OUTPUT_FLAG)) {
    outputs[name] = !!(mask & bit);
  }

  return {
    type:    'OUTPUTS_UPDATE',
    outputs,
    auxOn: [1, 2, 3, 4].filter(n => outputs[`AUX${n}`]),
    address,
    timestamp,
    raw,
  };
}

function decodeAuxOutputsUpdate(data, address, timestamp, raw) {
  const mask = decodeUnsignedShort(data);
  const on   = [];

  for (const [aux, bit] of Object.entries(AUX_OUTPUT_BITS)) {
    if (mask & bit) on.push(parseInt(aux, 10));
  }

  return { type: 'AUXILIARY_OUTPUTS_UPDATE', on, address, timestamp, raw };
}

// ─── Timestamp helper ────────────────────────────────────────────────────────

function decodeTimestamp(ts) {
  // YYMMDDHHmmss, decimal-encoded
  const year   = 2000 + parseInt(ts.slice(0, 2), 10);
  const month  = parseInt(ts.slice(2, 4), 10);
  const day    = parseInt(ts.slice(4, 6), 10);
  let   hour   = parseInt(ts.slice(6, 8), 10);
  let   minute = parseInt(ts.slice(8, 10), 10);
  const second = parseInt(ts.slice(10, 12), 10);

  // Known panel bug: minute can be 60 on-the-hour
  if (minute === 60) { minute = 0; hour += 1; }

  return new Date(year, month - 1, day, hour, minute, second).toISOString();
}

// ─── Convenience command builders ────────────────────────────────────────────

const commands = {
  /**
   * Arm away — equivalent to pressing [A][code][E] on the keypad.
   * @param {string} [code]  User code (omit for panels with no code required)
   */
  armAway:  (code = '') => encodeCommand(`A${code}E`),

  /**
   * Arm home / stay — equivalent to pressing [H][code][E].
   */
  armHome:  (code = '') => encodeCommand(`H${code}E`),

  /**
   * Arm night — send Night mode key sequence.
   * On most D8x/D16x panels Night is not a dedicated keypad key;
   * the command below sends the code followed by E which is what
   * most users program as the Night arming sequence.
   * Adjust if your panel is programmed differently.
   */
  armNight: (code = '') => encodeCommand(`N${code}E`),

  /**
   * Disarm — equivalent to typing [code][E].
   * @param {string} code  Required — user code
   */
  disarm:   (code)      => encodeCommand(`${code}E`),

  /**
   * Activate AUX output n (1–8) — sends "nn*"
   */
  auxOn:  (n)   => encodeCommand(`${n}${n}*`),

  /**
   * Deactivate AUX output n (1–8) — sends "nn#"
   */
  auxOff: (n)   => encodeCommand(`${n}${n}#`),

  /** Poll zone unsealed status (zones 1–16) */
  pollZones1_16:   () => encodeCommand('S00'),

  /** Poll zone unsealed status (zones 17–32) */
  pollZones17_32:  () => encodeCommand('S20'),

  /** Poll arming status */
  pollArming:      () => encodeCommand('S14'),

  /** Poll output status */
  pollOutputs:     () => encodeCommand('S15'),

  /** Poll auxiliary output status */
  pollAuxOutputs:  () => encodeCommand('S18'),

  /** Poll panel firmware version */
  pollVersion:     () => encodeCommand('S17'),
};

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  encodeCommand,
  calcChecksum,
  extractPacket,
  decodePacket,
  commands,
  COMMAND_TYPE,
  EVENT_TYPE,
  REQUEST_ID,
  ARMING_FLAG,
  ZONE_1_16_BITS,
  ZONE_17_32_BITS,
  OUTPUT_FLAG,
  AUX_OUTPUT_BITS,
};
