'use strict';

const EventEmitter    = require('events');
const { IP232Connection } = require('./connection');
const { AlarmState }      = require('./alarmState');
const { commands }        = require('./protocol');

/**
 * NessClient
 *
 * High-level client combining the IP232 TCP connection, Ness protocol layer,
 * and alarm state machine.
 *
 * Responsibilities:
 *  - Connect to IP232 and reconnect on drop
 *  - Feed received packets into AlarmState
 *  - Send keepalive polls on a configurable interval
 *  - Expose simple arm/disarm/output control methods
 *
 * Events re-emitted from AlarmState:
 *   'stateChange'  — arming state changed
 *   'zoneChange'   — zone opened/closed
 *   'outputChange' — AUX output toggled
 *   'systemEvent'  — raw system status event
 *   'connected'    — TCP connection established
 *   'disconnected' — TCP connection lost
 */
class NessClient extends EventEmitter {
  /**
   * @param {import('./config')} config
   */
  constructor(config) {
    super();

    this._config = config;

    this._connection = new IP232Connection({
      host:           config.ip232.host,
      port:           config.ip232.port,
      reconnectDelay: config.ip232.reconnectDelay,
      readTimeout:    config.ip232.readTimeout,
    });

    this._state = new AlarmState({
      zoneCount:   config.panel.zoneCount,
      zoneNames:   config.panel.zoneNames,
      outputCount: config.panel.outputCount,
    });

    this._keepaliveTimer = null;

    // Wire up connection events
    this._connection.on('packet',       (pkt) => this._onPacket(pkt));
    this._connection.on('connected',    ()    => this._onConnected());
    this._connection.on('disconnected', (r)   => this._onDisconnected(r));

    // Bubble up state events
    this._state.on('stateChange',  (e) => this.emit('stateChange',  e));
    this._state.on('zoneChange',   (e) => this.emit('zoneChange',   e));
    this._state.on('outputChange', (e) => this.emit('outputChange', e));
    this._state.on('systemEvent',  (e) => this.emit('systemEvent',  e));
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Start connecting. Resolves once the first connection is established. */
  async start() {
    await this._connection.connect();
  }

  /** Disconnect and stop keepalive. */
  stop() {
    this._stopKeepalive();
    this._connection.close();
  }

  /** Returns the current alarm state snapshot. */
  getState() {
    return this._state.getState();
  }

  // ─── Commands ──────────────────────────────────────────────────────────────

  /**
   * Arm away.
   * @param {string} [code]  User code (leave empty if not required by panel)
   */
  async armAway(code = '') {
    await this._send(commands.armAway(code));
  }

  /**
   * Arm home / stay.
   * @param {string} [code]
   */
  async armHome(code = '') {
    await this._send(commands.armHome(code));
  }

  /**
   * Arm night.
   * @param {string} [code]
   */
  async armNight(code = '') {
    await this._send(commands.armNight(code));
  }

  /**
   * Disarm.
   * @param {string} code  User code (required)
   */
  async disarm(code) {
    if (!code) throw new Error('Disarm requires a user code');
    await this._send(commands.disarm(code));
  }

  /**
   * Turn AUX output on.
   * @param {number} outputNumber  1–8
   */
  async auxOn(outputNumber) {
    this._validateOutput(outputNumber);
    await this._send(commands.auxOn(outputNumber));
  }

  /**
   * Turn AUX output off.
   * @param {number} outputNumber  1–8
   */
  async auxOff(outputNumber) {
    this._validateOutput(outputNumber);
    await this._send(commands.auxOff(outputNumber));
  }

  /**
   * Force a full state poll (zones + arming + outputs).
   * Normally run automatically on connect and by keepalive.
   */
  async poll() {
    await Promise.all([
      this._send(commands.pollZones1_16()),
      this._send(commands.pollArming()),
      this._send(commands.pollAuxOutputs()),
    ]);

    if (this._config.panel.zoneCount > 16) {
      await this._send(commands.pollZones17_32());
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  async _send(raw) {
    if (!this._connection.connected) {
      throw new Error('Not connected to panel');
    }
    await this._connection.write(raw);
  }

  _onPacket(decoded) {
    this._state.handlePacket(decoded);
    this.emit('packet', decoded);
  }

  _onConnected() {
    console.log('[NessClient] Connected — polling initial state');
    this.emit('connected');
    // Initial state poll
    this.poll().catch((err) => console.warn('[NessClient] Initial poll failed:', err.message));
    this._startKeepalive();
  }

  _onDisconnected(reason) {
    console.log(`[NessClient] Disconnected (${reason})`);
    this._stopKeepalive();
    this.emit('disconnected', reason);
  }

  _startKeepalive() {
    this._stopKeepalive();
    const interval = this._config.ip232.keepaliveInterval;
    console.log(`[NessClient] Keepalive every ${interval}ms`);
    this._keepaliveTimer = setInterval(() => {
      if (this._connection.connected) {
        this.poll().catch((err) =>
          console.warn('[NessClient] Keepalive poll failed:', err.message)
        );
      }
    }, interval);
  }

  _stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  _validateOutput(n) {
    const max = this._config.panel.outputCount;
    if (!Number.isInteger(n) || n < 1 || n > max) {
      throw new Error(`Output number must be between 1 and ${max}`);
    }
  }
}

module.exports = { NessClient };
