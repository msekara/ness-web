'use strict';

const path    = require('path');
const express = require('express');
const http    = require('http');
const { WebSocketServer } = require('ws');

/**
 * Create and start the HTTP + WebSocket API server.
 *
 * REST API:
 *
 *   GET  /state               — Full alarm state snapshot
 *   POST /arm/away            — Arm away          body: { "code": "1234" } (optional)
 *   POST /arm/home            — Arm home/stay      body: { "code": "1234" } (optional)
 *   POST /arm/night           — Arm night          body: { "code": "1234" } (optional)
 *   POST /disarm              — Disarm             body: { "code": "1234" } (required)
 *   POST /output/:n/on        — Turn AUX output n on
 *   POST /output/:n/off       — Turn AUX output n off
 *   GET  /health              — Health check (200 OK + connection status)
 *
 * WebSocket:
 *   Connect to ws://<host>:<port>/ws
 *   Receive JSON messages for every state change event:
 *     { "event": "stateChange",  "data": { previous, current, mode } }
 *     { "event": "zoneChange",   "data": { zone, unsealed, name } }
 *     { "event": "outputChange", "data": { output, on } }
 *     { "event": "systemEvent",  "data": { eventName, zone, area, timestamp, ... } }
 *     { "event": "connected"  }
 *     { "event": "disconnected" }
 *     { "event": "state",       "data": <full state snapshot> }  ← sent on WS connect
 *
 * @param {import('./client').NessClient} client
 * @param {import('./config')}            config
 * @returns {http.Server}
 */
function createServer(client, config) {
  const app = express();
  app.use(express.json());

  // ─── Auth middleware ─────────────────────────────────────────────────────

  const apiKey = config.server.apiKey;

  function authMiddleware(req, res, next) {
    if (!apiKey) return next(); // auth disabled

    const authHeader = req.headers['authorization'] || '';
    const token      = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : req.query.apiKey;

    if (token !== apiKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  }

  app.use(authMiddleware);

  // ─── REST routes ─────────────────────────────────────────────────────────

  // Health check — no auth (allows uptime monitors)
  app.get('/health', (_req, res) => {
    res.json({
      ok:        true,
      connected: client._connection.connected,
      uptime:    process.uptime(),
    });
  });

  // Full state snapshot
  app.get('/state', (_req, res) => {
    res.json(client.getState());
  });

  // Arm away
  app.post('/arm/away', async (req, res) => {
    try {
      const code = (req.body?.code || '').toString();
      await client.armAway(code);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Arm home / stay
  app.post('/arm/home', async (req, res) => {
    try {
      const code = (req.body?.code || '').toString();
      await client.armHome(code);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Arm night
  app.post('/arm/night', async (req, res) => {
    try {
      const code = (req.body?.code || '').toString();
      await client.armNight(code);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Disarm
  app.post('/disarm', async (req, res) => {
    const code = (req.body?.code || '').toString().trim();
    if (!code) {
      return res.status(400).json({ error: 'code is required to disarm' });
    }
    try {
      await client.disarm(code);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // AUX output control
  app.post('/output/:n/on', async (req, res) => {
    const n = parseInt(req.params.n, 10);
    try {
      await client.auxOn(n);
      res.json({ ok: true, output: n, on: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/output/:n/off', async (req, res) => {
    const n = parseInt(req.params.n, 10);
    try {
      await client.auxOff(n);
      res.json({ ok: true, output: n, on: false });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Dashboard — serve the HTML file at the root
  app.get('/', (_req, res) => {
    res.sendFile(path.resolve(__dirname, '..', 'dashboard.html'));
  });

  // 404 catch-all
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // ─── HTTP server + WebSocket ─────────────────────────────────────────────

  const server = http.createServer(app);

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (info) => {
      if (!apiKey) return true;
      // Allow key via ?apiKey=... query param on WebSocket URL
      const url    = new URL(info.req.url, 'http://localhost');
      const token  = url.searchParams.get('apiKey');
      const bearer = (info.req.headers['authorization'] || '').replace('Bearer ', '');
      return token === apiKey || bearer === apiKey;
    },
  });

  /** Broadcast a JSON message to all connected WebSocket clients. */
  function broadcast(event, data) {
    if (wss.clients.size === 0) return;
    const msg = JSON.stringify(data !== undefined ? { event, data } : { event });
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(msg);
      }
    }
  }

  // Send full state snapshot when a client connects
  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    console.log(`[WS] Client connected from ${ip} (${wss.clients.size} total)`);

    // Send current state immediately on connect
    ws.send(JSON.stringify({ event: 'state', data: client.getState() }));

    ws.on('close', () => {
      console.log(`[WS] Client disconnected from ${ip} (${wss.clients.size} remaining)`);
    });

    ws.on('error', (err) => {
      console.warn(`[WS] Client error from ${ip}: ${err.message}`);
    });
  });

  // Wire up alarm events → WebSocket broadcast
  client.on('stateChange',  (data) => broadcast('stateChange',  data));
  client.on('zoneChange',   (data) => broadcast('zoneChange',   data));
  client.on('outputChange', (data) => broadcast('outputChange', data));
  client.on('systemEvent',  (data) => {
    // Omit the raw packet string to keep payloads clean
    const { raw: _raw, ...clean } = data;
    broadcast('systemEvent', clean);
  });
  client.on('connected',    ()     => broadcast('connected'));
  client.on('disconnected', ()     => broadcast('disconnected'));

  return server;
}

module.exports = { createServer };
