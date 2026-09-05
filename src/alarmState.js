'use strict';

const EventEmitter = require('events');

/**
 * AlarmState
 *
 * Tracks and maintains the current state of the Ness D8x/D16x alarm panel
 * by processing decoded packet events from the protocol layer.
 *
 * Emits:
 *   'stateChange'  ({ previous, current, mode })     — arming state changed
 *   'zoneChange'   ({ zone, unsealed, name })         — zone opened/closed
 *   'outputChange' ({ output, on })                   — AUX output toggled
 *   'systemEvent'  (decodedPacket)                    — any system status event
 *
 * Public state is exposed via .getState() — returns a snapshot safe to
 * serialise as JSON.
 */
class AlarmState extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number}   opts.zoneCount   Number of zones to track (8 or 16)
   * @param {string[]} opts.zoneNames   Friendly names, index 0 = zone 1
   * @param {number}   opts.outputCount Number of AUX outputs
   */
  constructor({ zoneCount = 16, zoneNames = [], outputCount = 4 } = {}) {
    super();

    this.zoneCount   = zoneCount;
    this.zoneNames   = zoneNames;
    this.outputCount = outputCount;

    // Arming state
    this._armingState = 'DISARMED';  // 'DISARMED' | 'ARMED_AWAY' | 'ARMED_HOME' | 'ARMED_NIGHT' | 'ARMING' | 'ENTRY_DELAY' | 'ALARM'
    this._armingMode  = null;         // last known mode detail from ARMING_UPDATE

    // Zone state: zone number → boolean (true = unsealed/open)
    this._zones = {};
    for (let i = 1; i <= zoneCount; i++) {
      this._zones[i] = false;
    }

    // Output state: output number → boolean (true = on)
    this._outputs = {};
    for (let i = 1; i <= outputCount; i++) {
      this._outputs[i] = false;
    }

    // Extra system flags
    this._sirenOn      = false;
    this._strobeOn     = false;
    this._panelBattOk  = true;
    this._mainsPowerOk = true;
    this._lastUpdated  = null;
  }

  // ─── State snapshot ────────────────────────────────────────────────────────

  /**
   * Returns a plain-object snapshot of the current alarm state.
   * Safe to JSON.stringify().
   */
  getState() {
    const zones = {};
    for (let i = 1; i <= this.zoneCount; i++) {
      zones[i] = {
        unsealed: this._zones[i] || false,
        name:     this.zoneNames[i - 1] || `Zone ${i}`,
      };
    }

    const outputs = {};
    for (let i = 1; i <= this.outputCount; i++) {
      outputs[i] = { on: this._outputs[i] || false };
    }

    return {
      armingState:   this._armingState,
      armingMode:    this._armingMode,
      zones,
      outputs,
      siren:         this._sirenOn,
      strobe:        this._strobeOn,
      panelBattOk:   this._panelBattOk,
      mainsPowerOk:  this._mainsPowerOk,
      lastUpdated:   this._lastUpdated,
    };
  }

  // ─── Event processing ──────────────────────────────────────────────────────

  /**
   * Feed a decoded packet into the state machine.
   * Called by the client for every packet received from the panel.
   *
   * @param {object} decoded  Result of protocol.decodePacket()
   */
  handlePacket(decoded) {
    if (!decoded || decoded.type === 'DECODE_ERROR') return;

    this._lastUpdated = new Date().toISOString();

    switch (decoded.type) {
      case 'SYSTEM_STATUS':
        this._handleSystemStatus(decoded);
        break;

      case 'ZONE_1_16_UPDATE':
      case 'ZONE_17_32_UPDATE':
        this._handleZoneUpdate(decoded);
        break;

      case 'ARMING_UPDATE':
        this._handleArmingUpdate(decoded);
        break;

      case 'OUTPUTS_UPDATE':
        this._handleOutputsUpdate(decoded);
        break;

      case 'AUXILIARY_OUTPUTS_UPDATE':
        this._handleAuxOutputsUpdate(decoded);
        break;

      // Informational only
      case 'PANEL_VERSION_UPDATE':
      case 'VIEW_STATE_UPDATE':
      case 'UI_ECHO':
      case 'UI_RESP_UNKNOWN':
        break;

      default:
        break;
    }
  }

  // ─── System status events (real-time push from panel) ─────────────────────

  _handleSystemStatus(decoded) {
    const { eventType, eventName, zone } = decoded;

    // Emit raw event for anything that wants to listen
    this.emit('systemEvent', decoded);

    // Zone events
    if (eventType === 0x00 /* UNSEALED */) {
      this._setZone(zone, true);
    } else if (eventType === 0x01 /* SEALED */) {
      this._setZone(zone, false);
    } else if (eventType === 0x02 /* ALARM */) {
      this._setZone(zone, true);
      this._updateArmingState('ALARM');
    } else if (eventType === 0x03 /* ALARM_RESTORE */) {
      // Don't automatically clear ALARM state — let the ARMING poll do it
    }

    // Arming state transitions
    else if (eventType === 0x22 /* EXIT_DELAY_START */) {
      this._updateArmingState('ARMING');
    } else if (eventType === 0x20 /* ENTRY_DELAY_START */) {
      this._updateArmingState('ENTRY_DELAY');
    } else if (eventType === 0x24 /* ARMED_AWAY */) {
      this._updateArmingState('ARMED_AWAY');
    } else if (eventType === 0x25 /* ARMED_HOME */) {
      this._updateArmingState('ARMED_HOME');
    } else if (eventType === 0x26 /* ARMED_DAY */) {
      this._updateArmingState('ARMED_DAY');
    } else if (eventType === 0x27 /* ARMED_NIGHT */) {
      this._updateArmingState('ARMED_NIGHT');
    } else if (eventType === 0x2E /* ARMED_HIGHEST */) {
      this._updateArmingState('ARMED_AWAY');
    } else if (eventType === 0x2F /* DISARMED */) {
      this._updateArmingState('DISARMED');
    }

    // Output events
    else if (eventType === 0x31 /* OUTPUT_ON */) {
      if (zone >= 1 && zone <= this.outputCount) this._setOutput(zone, true);
    } else if (eventType === 0x32 /* OUTPUT_OFF */) {
      if (zone >= 1 && zone <= this.outputCount) this._setOutput(zone, false);
    }

    // Power / battery
    else if (eventType === 0x10 /* POWER_FAILURE */) {
      this._mainsPowerOk = false;
    } else if (eventType === 0x11 /* POWER_NORMAL */) {
      this._mainsPowerOk = true;
    } else if (eventType === 0x12 /* BATTERY_FAILURE */) {
      this._panelBattOk = false;
    } else if (eventType === 0x13 /* BATTERY_NORMAL */) {
      this._panelBattOk = true;
    }
  }

  // ─── Poll response handlers ────────────────────────────────────────────────

  _handleZoneUpdate(decoded) {
    const { unsealedZones } = decoded;
    const isZone1_16 = decoded.type === 'ZONE_1_16_UPDATE';

    const rangeStart = isZone1_16 ? 1  : 17;
    const rangeEnd   = isZone1_16 ? 16 : 32;

    for (let z = rangeStart; z <= Math.min(rangeEnd, this.zoneCount); z++) {
      const unsealed = unsealedZones.includes(z);
      this._setZone(z, unsealed);
    }
  }

  _handleArmingUpdate(decoded) {
    const { status } = decoded;
    this._armingMode = status;

    const area1Armed       = status.AREA_1_ARMED;
    const area1FullyArmed  = status.AREA_1_FULLY_ARMED;
    const monitorArmed     = status.MONITOR_ARMED;
    const dayMode          = status.DAY_MODE_ARMED;
    const entryDelay       = status.ENTRY_DELAY_1_ON || status.ENTRY_DELAY_2_ON;

    if (entryDelay && area1Armed) {
      this._updateArmingState('ENTRY_DELAY');
    } else if (area1FullyArmed) {
      // Fully armed = away
      this._updateArmingState('ARMED_AWAY');
    } else if (monitorArmed) {
      this._updateArmingState('ARMED_HOME');
    } else if (dayMode) {
      this._updateArmingState('ARMED_DAY');
    } else if (area1Armed) {
      // Armed but not fully — could be home/stay
      if (this._armingState !== 'ARMED_HOME' && this._armingState !== 'ARMING') {
        this._updateArmingState('ARMED_HOME');
      }
    } else {
      this._updateArmingState('DISARMED');
    }
  }

  _handleOutputsUpdate(decoded) {
    const { outputs } = decoded;

    this._sirenOn  = outputs.SIREN_LOUD || outputs.SIREN_SOFT || false;
    this._strobeOn = outputs.STROBE || false;

    // AUX outputs 1–4 are in the OUTPUTS bitmask
    for (let i = 1; i <= 4; i++) {
      const wasOn = this._outputs[i];
      const isOn  = outputs[`AUX${i}`] || false;
      if (wasOn !== isOn) this._setOutput(i, isOn);
    }
  }

  _handleAuxOutputsUpdate(decoded) {
    const { on } = decoded;
    for (let i = 1; i <= this.outputCount; i++) {
      this._setOutput(i, on.includes(i));
    }
  }

  // ─── Internal setters with change detection ─────────────────────────────

  _updateArmingState(newState) {
    if (this._armingState === newState) return;
    const previous = this._armingState;
    this._armingState = newState;
    this.emit('stateChange', { previous, current: newState, mode: this._armingMode });
  }

  _setZone(zone, unsealed) {
    if (zone < 1 || zone > this.zoneCount) return;
    const previous = this._zones[zone];
    if (previous === unsealed) return;
    this._zones[zone] = unsealed;
    this.emit('zoneChange', {
      zone,
      unsealed,
      name: this.zoneNames[zone - 1] || `Zone ${zone}`,
    });
  }

  _setOutput(output, on) {
    if (output < 1 || output > this.outputCount) return;
    const previous = this._outputs[output];
    if (previous === on) return;
    this._outputs[output] = on;
    this.emit('outputChange', { output, on });
  }
}

module.exports = { AlarmState };
