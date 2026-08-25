'use strict';

/**
 * Ness D8x/D16x monitor server.
 *
 *  panel link  <->  protocol decode/encode  <->  WebSocket  <->  browser dashboard
 *
 * Connects to the panel over TCP (a serial-to-Ethernet adapter such as an
 * IP232) or a local serial port, keeps a live state cache by polling status
 * requests, decodes async events, and relays everything to connected browsers.
 * Commands from the browser (arm / disarm / keypad / status request) are
 * encoded and written back to the panel.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { WebSocketServer } = require('ws');
const proto = require('./lib/protocol');

// ---------------------------------------------------------------------------
// Config (env vars, with sensible defaults). See README.
// ---------------------------------------------------------------------------
const CFG = {
  conn:      process.env.NESS_CONN      || 'tcp',        // 'tcp' | 'serial'
  host:      process.env.NESS_HOST      || '10.1.1.10',
  port:      Number(process.env.NESS_PORT || 2401),
  serialPath:process.env.NESS_SERIAL_PATH || '/dev/ttyUSB0',
  baud:      Number(process.env.NESS_BAUD || 9600),
  address:   Number(process.env.NESS_ADDRESS || 0),
  httpPort:  Number(process.env.HTTP_PORT || 3000),
  pollMs:    Number(process.env.POLL_MS  || 4000),       // full status refresh
  zonePollMs:Number(process.env.ZONE_POLL_MS || 800),    // fast zone refresh (catches PIR trips)
  zones:     Number(process.env.NESS_ZONES || 8),        // D8x = 8, D16x = 16
};

// ---------------------------------------------------------------------------
// Live state cache (what the dashboard renders)
// ---------------------------------------------------------------------------
const state = {
  connected: false,
  link: CFG.conn === 'serial' ? `serial ${CFG.serialPath} @${CFG.baud}` : `tcp ${CFG.host}:${CFG.port}`,
  zoneCount: CFG.zones,
  updated: null,
  zones: { 0: [], 5: [], 6: [], 7: [] }, // 0 unsealed, 5 alarm, 6 manual excl, 7 auto excl
  arming: [],
  misc: [],
  outputs: [],
  aux: [],
  view: null,
  model: null,
  version: null,
  events: [],         // rolling log of decoded events (newest first)
};
const MAX_EVENTS = 200;

function touch() { state.updated = new Date().toISOString(); }

// mutate a zone list (state.zones[form]) by adding/removing a zone number
function setZone(form, zone, present) {
  if (zone < 1 || zone > 16) return;
  const list = state.zones[form] || (state.zones[form] = []);
  const has = list.includes(zone);
  if (present && !has) list.push(zone), list.sort((a, b) => a - b);
  else if (!present && has) state.zones[form] = list.filter((z) => z !== zone);
}

// Returns the event record if the message was an event (for incremental push).
function applyMessage(msg) {
  if (msg.type === 'status') {
    switch (msg.form) {
      case 'zones':   state.zones[msg.requestId] = msg.zones; break;
      case 'arming':  state.arming = msg.flags; break;
      case 'misc':    state.misc = msg.flags; break;
      case 'outputs': state.outputs = msg.flags; break;
      case 'aux':     state.aux = msg.flags; break;
      case 'view':    state.view = msg.state; break;
      case 'version': state.model = msg.model; state.version = msg.version; break;
    }
    touch();
    return null;
  }

  if (msg.type === 'event') {
    // Drive the zone grid straight from pushed events (needs P199E 6E for
    // seal/unseal in real time). For these events, msg.id is a zone number.
    const z = msg.id;
    switch (msg.event) {
      case 0x00: setZone(0, z, true);  break; // unsealed
      case 0x01: setZone(0, z, false); break; // sealed
      case 0x02: setZone(5, z, true);  break; // alarm
      case 0x03: setZone(5, z, false); break; // alarm restore
      case 0x04: setZone(6, z, true);  break; // manual exclude
      case 0x05: setZone(6, z, false); break; // manual include
      case 0x06: setZone(7, z, true);  break; // auto exclude
      case 0x07: setZone(7, z, false); break; // auto include
    }
    const rec = {
      at: (msg.timestamp && msg.timestamp.iso) || new Date().toISOString(),
      recvAt: new Date().toISOString(),
      event: msg.event, eventName: msg.eventName,
      id: msg.id, idName: msg.idName,
      area: msg.area, areaName: msg.areaName,
      description: msg.description, raw: msg.raw,
    };
    state.events.unshift(rec);
    state.events = state.events.slice(0, MAX_EVENTS);
    touch();
    return rec;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Panel link abstraction: exposes write(str) and emits decoded lines.
// ---------------------------------------------------------------------------
let panelWrite = () => {};
let rxBuffer = '';

function handleRaw(chunk) {
  rxBuffer += chunk.toString('latin1');
  let idx;
  while ((idx = rxBuffer.indexOf('\n')) >= 0) {
    const line = rxBuffer.slice(0, idx).replace(/\r/g, '').trim();
    rxBuffer = rxBuffer.slice(idx + 1);
    if (!line) continue;
    const msg = proto.decode(line);
    if (msg.type === 'unknown') {
      log(`rx (unparsed): ${line}`);
      continue;
    }
    const evt = applyMessage(msg);
    scheduleStateBroadcast();
    if (evt) {
      log(`event: ${msg.description}`);
      broadcast({ kind: 'event', event: evt });
    }
  }
}

// Coalesce state pushes so a burst of poll replies is one render.
let stateTimer = null;
function scheduleStateBroadcast() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => { stateTimer = null; broadcast({ kind: 'state', state }); }, 120);
}

function connectTcp() {
  const sock = new net.Socket();
  sock.setEncoding('latin1');
  const attempt = () => {
    log(`connecting tcp ${CFG.host}:${CFG.port} ...`);
    sock.connect(CFG.port, CFG.host);
  };
  sock.on('connect', () => { setConnected(true); kickstart(); pollZones(); });
  sock.on('data', handleRaw);
  sock.on('error', (e) => log(`tcp error: ${e.message}`));
  sock.on('close', () => { setConnected(false); setTimeout(attempt, 3000); });
  panelWrite = (s) => { try { sock.write(s, 'latin1'); } catch (e) { log('write fail: ' + e.message); } };
  attempt();
}

function connectSerial() {
  let SerialPort;
  try { ({ SerialPort } = require('serialport')); }
  catch { log('serialport module not installed - run: npm install serialport'); return; }
  const open = () => {
    log(`opening serial ${CFG.serialPath} @${CFG.baud} ...`);
    const port = new SerialPort({ path: CFG.serialPath, baudRate: CFG.baud }, (err) => {
      if (err) { log('serial open error: ' + err.message); setTimeout(open, 3000); }
    });
    port.on('open', () => { setConnected(true); kickstart(); pollZones(); });
    port.on('data', handleRaw);
    port.on('error', (e) => log('serial error: ' + e.message));
    port.on('close', () => { setConnected(false); setTimeout(open, 3000); });
    panelWrite = (s) => { try { port.write(s); } catch (e) { log('write fail: ' + e.message); } };
  };
  open();
}

function setConnected(v) {
  if (state.connected !== v) log(v ? 'panel link up' : 'panel link down');
  state.connected = v; touch();
  broadcast({ kind: 'state', state });
}

// ---------------------------------------------------------------------------
// Polling: keep the dashboard's status forms fresh.
// ---------------------------------------------------------------------------
// Full status refresh (all forms) - slower.
function poll() {
  if (!CFG.pollMs || !state.connected) return;
  proto.POLL_IDS.forEach((id, i) => {
    setTimeout(() => state.connected && panelWrite(proto.statusRequest(id, CFG.address)), i * 120);
  });
}
// Fast zone refresh - catches momentary PIR trips even without P199E 6E.
function pollZones() {
  if (!CFG.zonePollMs || !state.connected) return;
  panelWrite(proto.statusRequest(0, CFG.address)); // unsealed
  setTimeout(() => state.connected && panelWrite(proto.statusRequest(5, CFG.address)), 60); // alarm
}
if (CFG.pollMs) setInterval(poll, CFG.pollMs);
if (CFG.zonePollMs) setInterval(pollZones, CFG.zonePollMs);

// Re-request full status a few times right after connecting, so a reply that
// gets missed during the handshake (e.g. version/view) is retried quickly.
function kickstart() {
  [0, 800, 2000, 4000].forEach((t) => setTimeout(() => state.connected && poll(), t));
}

// ---------------------------------------------------------------------------
// Command handling from the browser
// ---------------------------------------------------------------------------
function runCommand(cmd) {
  const a = CFG.address;
  let raw;
  switch (cmd.action) {
    case 'status':  raw = proto.statusRequest(Number(cmd.id), a); break;
    case 'arm':     raw = proto.arm(String(cmd.code || ''), a); break;
    case 'home':    raw = proto.home(String(cmd.code || ''), a); break;
    case 'disarm':  raw = proto.disarm(String(cmd.code || ''), a); break;
    case 'keypad':  raw = proto.keypad(String(cmd.keys || ''), a); break;
    case 'panic':   raw = proto.panic(a); break;
    case 'fire':    raw = proto.fire(a); break;
    case 'medical': raw = proto.medical(a); break;
    case 'raw':     raw = String(cmd.raw || ''); break;
    case 'refresh': poll(); return;
    default: log('unknown command: ' + JSON.stringify(cmd)); return;
  }
  log(`tx ${cmd.action}: ${JSON.stringify(raw)}`);
  panelWrite(raw);
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  if (req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(state));
  }
  let file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const full = path.join(__dirname, 'public', path.normalize(file));
  if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ kind: 'state', state }));
  ws.send(JSON.stringify({ kind: 'events', events: state.events }));
  ws.on('message', (data) => {
    try { runCommand(JSON.parse(data.toString())); }
    catch (e) { log('bad ws message: ' + e.message); }
  });
  ws.on('close', () => clients.delete(ws));
});

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(s);
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  broadcast({ kind: 'log', line });
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------
server.listen(CFG.httpPort, () => {
  log(`dashboard on http://localhost:${CFG.httpPort}  (panel: ${state.link}, addr ${CFG.address})`);
  if (CFG.conn === 'serial') connectSerial(); else connectTcp();
});
