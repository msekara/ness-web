'use strict';

/**
 * Ness D8x / D16x ASCII Serial Protocol  (Doc 362S27 Rev 13)
 *
 * Implements:
 *   - decode()        : parse messages FROM the panel
 *                       (System Status events 0x61, Status responses 0x60)
 *   - encodeCommand() : build a raw command TO the panel
 *   - helper builders : statusRequest / arm / disarm / keypad / panic etc.
 *
 * Wire format: every logical byte is transmitted as two ASCII hex characters,
 * except the FINISH bytes (CR 0x0d, LF 0x0a) which are literal control chars.
 * Timestamp fields are the exception - they are read as *decimal* from their
 * two ASCII characters (e.g. "43" = 43 minutes, not 0x43).
 */

// ---------------------------------------------------------------------------
// Lookup tables (from the event/appendix tables in the spec)
// ---------------------------------------------------------------------------

const EVENTS = {
  0x00: 'Unsealed',            0x01: 'Sealed',
  0x02: 'Alarm',               0x03: 'Alarm Restore',
  0x04: 'Manual Exclude',      0x05: 'Manual Include',
  0x06: 'Auto Exclude',        0x07: 'Auto Include',
  0x08: 'Tamper Unsealed',     0x09: 'Tamper Normal',
  0x10: 'Power Failure',       0x11: 'Power Normal',
  0x12: 'Battery Failure',     0x13: 'Battery Normal',
  0x14: 'Report Failure',      0x15: 'Report Normal',
  0x16: 'Supervision Failure', 0x17: 'Supervision Normal',
  0x19: 'Real Time Clock',
  0x20: 'Entry Delay Start',   0x21: 'Entry Delay End',
  0x22: 'Exit Delay Start',    0x23: 'Exit Delay End',
  0x24: 'Armed Away',          0x25: 'Armed Home',
  0x26: 'Armed Day',           0x27: 'Armed Night',
  0x28: 'Armed Vacation',      0x2e: 'Armed Highest',
  0x2f: 'Disarmed',            0x30: 'Arming Delayed',
  0x31: 'Output On',           0x32: 'Output Off',
};

// AREA / qualifier byte meanings (Appendix A)
const AREAS = {
  0x00: 'No area',   0x01: 'Area 1', 0x02: 'Area 2', 0x03: 'Home', 0x04: 'Day',
  0x80: '24 hr',     0x81: 'Fire',   0x82: 'Panic',  0x83: 'Medical', 0x84: 'Duress',
  0x85: 'Door',      0x90: 'Radio Device', 0x91: 'Radio Detector', 0x92: 'Radio Pendant',
  0xa1: 'Door 1',    0xa2: 'Door 2', 0xa3: 'Door 3', 0xa4: 'Door 4', 0xa5: 'Door 5', 0xa6: 'Door 6',
  0xb0: 'Program area',
};

// ID byte meaning depends on the event, but 0xf0-0xfe are always keypads.
function describeId(id) {
  if (id === 0x00) return 'Main unit';
  if (id >= 0xf0 && id <= 0xfe) return `Keypad ${id - 0xef}`;
  return `#${id}`; // zone (1-16) or user (1-58), context dependent
}

// Status-request IDs -> the FORM they decode with (spec section "Status update")
const STATUS_FORMS = {
  0:  { name: 'Zone Input Unsealed',       form: 'zones' },
  1:  { name: 'Zone Radio Unsealed',       form: 'zones' },
  2:  { name: 'Zone CBus Unsealed',        form: 'zones' },
  3:  { name: 'Zone in Delay',             form: 'zones' },
  4:  { name: 'Zone in Double Trigger',    form: 'zones' },
  5:  { name: 'Zone in Alarm',             form: 'zones' },
  6:  { name: 'Zone Excluded',             form: 'zones' },
  7:  { name: 'Zone Auto Excluded',        form: 'zones' },
  8:  { name: 'Zone Supervision Fail Pending', form: 'zones' },
  9:  { name: 'Zone Supervision Fail',     form: 'zones' },
  10: { name: 'Zone Doors Open',           form: 'zones' },
  11: { name: 'Zone Detector Low Battery', form: 'zones' },
  12: { name: 'Zone Detector Tamper',      form: 'zones' },
  13: { name: 'Miscellaneous Alarms',      form: 'misc' },   // FORM 20
  14: { name: 'Arming',                    form: 'arming' }, // FORM 21
  15: { name: 'Outputs',                   form: 'outputs' },// FORM 22
  16: { name: 'View State',                form: 'view' },   // FORM 23
  17: { name: 'Version / SW',              form: 'version' },
  18: { name: 'Auxiliary Outputs',         form: 'aux' },    // FORM 24
};

// FORM 20 - Miscellaneous alarms (bit -> name)
const FORM_MISC = {
  0x0001: 'Duress',        0x0002: 'Panic',           0x0004: 'Medical',
  0x0008: 'Fire',          0x0010: 'Install End',     0x0020: 'External Tamper',
  0x0040: 'Panel Tamper',  0x0080: 'Keypad Tamper',   0x0100: 'Pendant Panic',
  0x0200: 'Panel Battery Low', 0x0400: 'Panel Battery Low 2', 0x0800: 'Mains Fail',
  0x1000: 'CBus Fail',
};

// FORM 21 - Arming status
const FORM_ARMING = {
  0x0100: 'Area 1 Armed',       0x0200: 'Area 2 Armed',
  0x0400: 'Area 1 Fully Armed', 0x0800: 'Area 2 Fully Armed',
  0x1000: 'Home Armed',         0x2000: 'Day Mode Armed',
  0x4000: 'Entry Delay 1 On',   0x8000: 'Entry Delay 2 On',
  0x0001: 'Manual Exclude Mode',0x0002: 'Memory Mode',
  0x0004: 'Day Zone Select',
};

// FORM 22 - Output states
const FORM_OUTPUTS = {
  0x0100: 'Siren Loud',  0x0200: 'Siren Soft',   0x0400: 'Siren Soft Home',
  0x0800: 'Siren Fire',  0x1000: 'Strobe',       0x2000: 'Reset',
  0x4000: 'Sonalert',    0x8000: 'Keypad Display Enable',
  0x0001: 'Aux 1',       0x0002: 'Aux 2',        0x0004: 'Aux 3',   0x0008: 'Aux 4',
  0x0010: 'Home Out',    0x0020: 'Power Fail',   0x0040: 'Panel Batt Fail',
  0x0080: 'Tamper Xpand',
};

// FORM 24 - Auxiliary outputs
const FORM_AUX = {
  0x0001: 'Aux 1', 0x0002: 'Aux 2', 0x0004: 'Aux 3', 0x0008: 'Aux 4',
  0x0010: 'Aux 5', 0x0020: 'Aux 6', 0x0040: 'Aux 7', 0x0080: 'Aux 8',
};

// FORM 23 - View state (whole-value lookup, top nibble)
const FORM_VIEW = {
  0xf000: 'Normal',          0xe000: 'Brief Day (Chime)', 0xd000: 'Home',
  0xc000: 'Memory',          0xb000: 'Brief Day Zone Select',
  0xa000: 'Exclude Select',  0x9000: 'User Program',      0x8000: 'Installer Program',
};

// FORM 4 - zone bit mask. Zones 1-8 live in the high byte, 9-16 in the low byte.
function zoneMask(n) {
  return n <= 8 ? (0x0100 << (n - 1)) : (0x0001 << (n - 9));
}
function decodeZones(value16) {
  const zones = [];
  for (let n = 1; n <= 16; n++) if (value16 & zoneMask(n)) zones.push(n);
  return zones;
}
function decodeBitField(value16, table) {
  const out = [];
  for (const bit of Object.keys(table)) {
    const b = Number(bit);
    if ((value16 & b) === b && b !== 0) out.push(table[b]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// DECODE  (messages received from the panel)
// ---------------------------------------------------------------------------

/**
 * @param {string} line - one ASCII-hex line from the panel, CR/LF already stripped.
 * @returns {object} parsed message, or {type:'unknown', raw} if it can't be parsed.
 */
function decode(line) {
  const raw = (line || '').trim();
  if (raw.length < 8 || raw.length % 2 !== 0 || /[^0-9a-fA-F]/.test(raw)) {
    return { type: 'unknown', raw };
  }

  const byteAt = (i) => parseInt(raw.substr(i * 2, 2), 16);
  const totalBytes = raw.length / 2;
  const start = byteAt(0);
  const hasTimestamp = (start & 0x04) !== 0; // reliable from the START byte

  // Address presence: bit0 says so for 0x83/0x87, but the STATUS response uses
  // START=0x82 (bit0 clear) and still carries an address. Resolve by checking
  // which layout produces a valid command byte and exact message length.
  let hasAddress;
  if (start & 0x01) {
    hasAddress = true;
  } else {
    hasAddress = [true, false].find((withAddr) => {
      const a = withAddr ? 1 : 0;
      const lenByte = byteAt(1 + a);
      const dLen = lenByte & 0x7f;
      const cmd = byteAt(2 + a);
      const expected = 1 + a + 1 + 1 + dLen + (hasTimestamp ? 6 : 0) + 1;
      return expected === totalBytes && (cmd === 0x60 || cmd === 0x61);
    });
    if (hasAddress === undefined) hasAddress = false; // fall back, log as unknown
  }

  let pos = 0;
  const hex = () => parseInt(raw.substr((pos += 2) - 2, 2), 16);
  const dec = () => parseInt(raw.substr((pos += 2) - 2, 2), 10);

  hex(); // consume START (already read)
  const address = hasAddress ? hex() : null;
  const lengthByte = hex();
  const seq = (lengthByte & 0x80) >> 7;
  const dataLen = lengthByte & 0x7f;
  const command = hex();

  const data = [];
  for (let i = 0; i < dataLen; i++) data.push(hex());

  let timestamp = null;
  if (hasTimestamp) {
    const yy = dec(), mo = dec(), dd = dec(), hh = dec(), mi = dec(), ss = dec();
    const year = 2000 + yy;
    timestamp = {
      year, month: mo, day: dd, hour: hh, minute: mi, second: ss,
      iso: `${year}-${p2(mo)}-${p2(dd)}T${p2(hh)}:${p2(mi)}:${p2(ss)}`,
    };
  }
  const checksum = hex();

  const base = { raw, start, address, seq, command, checksum,
                 timestamp, hasTimestamp, hasAddress };

  if (command === 0x61 && data.length >= 3) return decodeEvent(base, data);
  if (command === 0x60 && data.length >= 3) return decodeStatus(base, data);
  return { ...base, type: 'unknown', data };
}

function decodeEvent(base, [event, id, area]) {
  return {
    ...base,
    type: 'event',
    event, id, area,
    eventName: EVENTS[event] || `Event 0x${hexb(event)}`,
    idName: describeId(id),
    areaName: AREAS[area] || `0x${hexb(area)}`,
    description: `${EVENTS[event] || 'Event 0x' + hexb(event)} - ${describeId(id)}` +
                 (AREAS[area] && area !== 0 ? ` (${AREAS[area]})` : ''),
  };
}

function decodeStatus(base, [reqId, hi, lo]) {
  const value = (hi << 8) | lo;
  const meta = STATUS_FORMS[reqId] || { name: `Request ${reqId}`, form: 'raw' };
  const out = { ...base, type: 'status', requestId: reqId, name: meta.name,
                form: meta.form, value };

  switch (meta.form) {
    case 'zones':   out.zones = decodeZones(value); break;
    case 'misc':    out.flags = decodeBitField(value, FORM_MISC); break;
    case 'arming':  out.flags = decodeBitField(value, FORM_ARMING); break;
    case 'outputs': out.flags = decodeBitField(value, FORM_OUTPUTS); break;
    case 'aux':     out.flags = decodeBitField(value, FORM_AUX); break;
    case 'view':    out.state = FORM_VIEW[value & 0xf000] || `0x${value.toString(16)}`; break;
    case 'version': {
      const model = { 0x00: 'D16X', 0x04: 'D16X 3G' }[hi] || `model 0x${hexb(hi)}`;
      out.model = model;
      out.version = `${(lo >> 4) & 0xf}.${lo & 0xf}`;
      break;
    }
    default: out.flags = []; break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ENCODE  (commands sent to the panel)
// ---------------------------------------------------------------------------

/**
 * Build a raw command string terminated with '?' + CRLF.
 * Matches the spec's worked examples exactly:
 *   START 0x83 | 1-nibble ADDRESS | 2-hex LENGTH | CMD 0x60 | literal DATA | CHK | '?'
 * The checksum is summed over the ASCII characters of the pre-checksum string,
 * with CHK = (0x100 - (sum & 0xff)) & 0xff  (verified against doc examples E9 / 7E).
 *
 * @param {string} dataStr - literal ASCII payload, e.g. "A123E", "S00", "1", "P"
 * @param {number} address - panel address nibble (0 is always accepted)
 */
function encodeCommand(dataStr, address = 0) {
  const addrNibble = (address & 0x0f).toString(16).toUpperCase();
  const lenHex = dataStr.length.toString(16).toUpperCase().padStart(2, '0');
  const msg = '83' + addrNibble + lenHex + '60' + dataStr;

  let sum = 0;
  for (let i = 0; i < msg.length; i++) sum += msg.charCodeAt(i);
  const chk = ((0x100 - (sum & 0xff)) & 0xff).toString(16).toUpperCase().padStart(2, '0');

  return msg + chk + '?\r\n';
}

// Convenience builders --------------------------------------------------------

const statusRequest = (id, address = 0) =>
  encodeCommand('S' + String(id).padStart(2, '0'), address);

// Arm/disarm and keypad: send the exact key sequence a user would press.
const arm     = (code, address = 0) => encodeCommand('A' + code + 'E', address);
const home    = (code, address = 0) => encodeCommand('H' + code + 'E', address);
const disarm  = (code, address = 0) => encodeCommand(code + 'E', address);
const keypad  = (keys, address = 0) => encodeCommand(String(keys), address);
const panic   = (address = 0) => encodeCommand('P', address);
const fire    = (address = 0) => encodeCommand('F', address);
const medical = (address = 0) => encodeCommand('D', address);

// The status IDs worth polling to build a live dashboard.
const POLL_IDS = [0, 5, 6, 13, 14, 15, 16, 17, 18];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function p2(n) { return String(n).padStart(2, '0'); }
function hexb(n) { return (n & 0xff).toString(16).toUpperCase().padStart(2, '0'); }

module.exports = {
  decode, encodeCommand,
  statusRequest, arm, home, disarm, keypad, panic, fire, medical,
  POLL_IDS, STATUS_FORMS,
  // exported for tests
  _internals: { zoneMask, decodeZones, EVENTS, AREAS },
};
