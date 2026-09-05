'use strict';

const net          = require('net');
const EventEmitter = require('events');
const { extractPacket, decodePacket } = require('./protocol');

/**
 * IP232Connection
 *
 * Manages a TCP connection to the Ness IP232 serial-over-ethernet adapter.
 * Handles:
 *   - Auto-reconnect with backoff on connection loss
 *   - Line-oriented packet framing (packets end with \r\n)
 *   - Emits 'packet' events with decoded packet objects
 *   - Emits 'connected' / 'disconnected' events
 *   - Read timeout watchdog (reconnects if no data received within window)
 *
 * Why disconnects happen:
 *   1. The IP232 has a configurable TCP idle timeout (often 60s by default).
 *      Sending a status poll every ~20s keeps both the TCP and serial sides
 *      alive (handled by NessClient keepalive).
 *   2. The IP232 firmware can close the session if the RS-232 side is idle —
 *      the keepalive poll sends bytes to the panel which sends bytes back,
 *      satisfying both directions.
 *   3. TCP keepalive alone is not enough because the IP232 tracks *application*
 *      idle time, not TCP-level keepalive probes.
 */
class IP232Connection extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}  opts.host              IP address of the IP232
   * @param {number}  opts.port              TCP port on the IP232
   * @param {number}  [opts.reconnectDelay]  ms to wait between reconnect attempts
   * @param {number}  [opts.readTimeout]     ms before considering the connection dead
   */
  constructor({ host, port, reconnectDelay = 5000, readTimeout = 90000 }) {
    super();
    this.host           = host;
    this.port           = port;
    this.reconnectDelay = reconnectDelay;
    this.readTimeout    = readTimeout;

    this._socket          = null;
    this._buffer          = '';
    this._connected       = false;
    this._closed          = false;     // set to true when close() is called deliberately
    this._disconnecting   = false;     // guard against double-disconnect
    this._reconnectTimer  = null;
    this._readWatchdog    = null;
    this._lastRecv        = null;
  }

  get connected() {
    return this._connected;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Establish the TCP connection (resolves when connected, rejects on error).
   * If called while already connected, resolves immediately.
   */
  connect() {
    if (this._connected) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this._socket = socket;

      const onConnect = () => {
        cleanup();
        this._onConnected();
        resolve();
      };

      const onError = (err) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        socket.removeListener('connect', onConnect);
        socket.removeListener('error',   onError);
      };

      socket.once('connect', onConnect);
      socket.once('error',   onError);

      socket.connect(this.port, this.host);
    });
  }

  /**
   * Send a raw ASCII packet string to the panel.
   * @param {string} raw  Fully encoded packet string (including CRLF)
   */
  write(raw) {
    return new Promise((resolve, reject) => {
      if (!this._connected || !this._socket) {
        return reject(new Error('Not connected'));
      }
      this._socket.write(raw, 'ascii', (err) => {
        if (err) reject(err);
        else     resolve();
      });
    });
  }

  /**
   * Gracefully close the connection and stop reconnect attempts.
   */
  close() {
    this._closed = true;
    this._clearWatchdog();
    this._clearReconnectTimer();
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
    this._connected     = false;
    this._disconnecting = false;
  }

  // ─── Internal connection lifecycle ─────────────────────────────────────────

  _onConnected() {
    console.log(`[IP232] Connected to ${this.host}:${this.port}`);
    this._connected     = true;
    this._disconnecting = false;
    this._buffer        = '';
    this._lastRecv      = Date.now();

    const socket = this._socket;

    socket.setEncoding('ascii');

    // TCP keepalive: probe after 10s idle, then every 5s, give up after 3 missed probes.
    // This ensures the OS detects a dead connection within ~25s rather than the
    // default ~11 minutes, complementing our application-level read watchdog.
    socket.setKeepAlive(true, 10000);

    // FIN_WAIT / half-open connections: if the remote sends FIN we want to know
    // immediately, not linger in a half-open state.
    socket.setTimeout(0); // disable socket-level idle timeout (we use our own watchdog)

    // NOTE: We do NOT listen to 'close' here.
    // Node fires: end → (optional) error → close, in that order.
    // Listening to both 'end' and 'close' causes _onDisconnect to be called twice
    // because 'close' always fires after 'end'/'error'. We rely on the _disconnecting
    // flag as a secondary guard, but not attaching 'close' is cleaner.
    socket.on('data',    (chunk) => this._onData(chunk));
    socket.on('end',     ()      => this._onDisconnect('end'));
    socket.on('error',   (err)   => this._onDisconnect('error', err));
    socket.on('timeout', ()      => this._onDisconnect('timeout'));

    this._startWatchdog();
    this.emit('connected');
  }

  _onData(chunk) {
    this._lastRecv = Date.now();
    this._buffer  += chunk;

    // Extract and process all complete packets in the buffer
    let extracted;
    while ((extracted = extractPacket(this._buffer)) !== null) {
      this._buffer = extracted.remaining;
      const raw    = extracted.packet.trim();
      if (!raw) continue;

      const decoded = decodePacket(raw);
      if (decoded) {
        this.emit('packet', decoded);
      }
    }
  }

  _onDisconnect(reason, err) {
    // Guard: only handle the first disconnect event; ignore subsequent ones
    // (e.g. 'error' followed by 'end', or double 'close').
    if (this._disconnecting || !this._connected) return;
    this._disconnecting = true;
    this._connected     = false;
    this._clearWatchdog();

    // Ensure the socket is fully torn down
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }

    if (err) {
      console.warn(`[IP232] Disconnected (${reason}): ${err.message}`);
    } else {
      console.log(`[IP232] Disconnected (${reason})`);
    }

    this.emit('disconnected', reason);

    if (!this._closed) {
      this._scheduleReconnect();
    }
  }

  // ─── Read watchdog ─────────────────────────────────────────────────────────

  /**
   * The read watchdog fires if we haven't received ANY data within readTimeout ms.
   *
   * This catches the case where the IP232 silently drops the TCP session without
   * sending a FIN/RST (e.g. power cycle, network blip, firmware idle timeout)
   * — situations where neither 'end' nor 'error' would ever fire.
   *
   * The watchdog interval is set to readTimeout/3 so we check frequently enough
   * to detect the timeout within one interval window of it expiring.
   */
  _startWatchdog() {
    this._clearWatchdog();
    const checkInterval = Math.max(5000, Math.floor(this.readTimeout / 3));
    this._readWatchdog = setInterval(() => {
      const elapsed = Date.now() - (this._lastRecv || 0);
      if (elapsed > this.readTimeout) {
        console.warn(`[IP232] Read timeout (${Math.round(elapsed / 1000)}s since last data) — reconnecting`);
        this._onDisconnect('read-timeout');
      }
    }, checkInterval);
  }

  _clearWatchdog() {
    if (this._readWatchdog) {
      clearInterval(this._readWatchdog);
      this._readWatchdog = null;
    }
  }

  // ─── Reconnect logic ───────────────────────────────────────────────────────

  _scheduleReconnect() {
    this._clearReconnectTimer();
    console.log(`[IP232] Reconnecting in ${this.reconnectDelay}ms…`);

    this._reconnectTimer = setTimeout(async () => {
      if (this._closed) return;
      this._disconnecting = false; // reset so the next connection attempt works

      try {
        await this.connect();
      } catch (err) {
        console.warn(`[IP232] Reconnect failed: ${err.message}`);
        // connect() rejects before _onConnected is called, so _onDisconnect
        // won't have fired. Schedule another attempt manually.
        if (!this._closed) {
          this._scheduleReconnect();
        }
      }
    }, this.reconnectDelay);
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }
}

module.exports = { IP232Connection };
