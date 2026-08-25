'use strict';

/**
 * Simulated Ness panel for testing without hardware.
 * Listens on TCP (default :2401), answers status requests, and emits random
 * events. Point the server at it:
 *
 *   node test/sim-panel.js                 # terminal 1
 *   NESS_HOST=127.0.0.1 NESS_PORT=2401 node server.js   # terminal 2
 */

const net = require('net');
const PORT = Number(process.env.SIM_PORT || 2401);

// checksum such that the sum of decoded bytes has LSB 0 (spec output rule)
function frame(bytes) {
  const sum = bytes.reduce((a, b) => a + b, 0);
  const chk = (0x100 - (sum & 0xff)) & 0xff;
  return bytes.concat(chk).map((b) => b.toString(16).padStart(2, '0')).join('') + '\r\n';
}
// status response: START 82, ADDR, LEN 03, CMD 60, reqId, hi, lo
const statusMsg = (reqId, val) => frame([0x82, 0x00, 0x03, 0x60, reqId, (val >> 8) & 0xff, val & 0xff]);
// event: START 87, ADDR, LEN 03, CMD 61, event, id, area, + 6 decimal ts bytes
function eventMsg(event, id, area) {
  const d = new Date();
  const ts = [d.getFullYear() % 100, d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
  const head = [0x87, 0x00, 0x03, 0x61, event, id, area];
  const sum = head.reduce((a, b) => a + b, 0) + ts.reduce((a, b) => a + b, 0);
  const chk = (0x100 - (sum & 0xff)) & 0xff;
  const asHex = (arr) => arr.map((b) => b.toString(16).padStart(2, '0')).join('');
  const asDec = (arr) => arr.map((b) => String(b).padStart(2, '0')).join('');
  return asHex(head) + asDec(ts) + asHex([chk]) + '\r\n';
}

// mutable fake world
const world = { unsealed: 0x0000, alarm: 0x0000, excluded: 0x0000, arming: 0x0000, misc: 0x0000, outputs: 0x0000 };

function snapshot(sock) {
  sock.write(statusMsg(0, world.unsealed));
  sock.write(statusMsg(5, world.alarm));
  sock.write(statusMsg(6, world.excluded));
  sock.write(statusMsg(13, world.misc));
  sock.write(statusMsg(14, world.arming));
  sock.write(statusMsg(15, world.outputs));
  sock.write(statusMsg(16, 0xf000)); // view state: Normal
  sock.write(statusMsg(17, 0x0024)); // model D16X, fw 2.4
}

const server = net.createServer((sock) => {
  console.log('sim: client connected');
  snapshot(sock);
  // deterministic: push a zone-3 unseal event shortly after connect
  setTimeout(() => sock.write(eventMsg(0x00, 3, 0)), 300);

  sock.on('data', (buf) => {
    const text = buf.toString('latin1');
    for (const part of text.split('?')) {
      const s = part.replace(/[\r\n]/g, '').trim();
      if (!s) continue;
      console.log('sim rx:', s);
      // crude parse of a status request "83 0 03 60 S NN"
      const dataAscii = Buffer.from(s.slice(8, s.length - 2), 'hex').toString('latin1'); // not exact, but enough
      if (s.includes('53')) { // 'S' present -> status request; reply with a snapshot
        snapshot(sock);
      } else {
        // treat "A...E" as arm, bare "...E" as disarm - toggle arming for demo
        if (/41/i.test(s)) { world.arming = 0x0500; sock.write(eventMsg(0x24, 1, 1)); }
        else              { world.arming = 0x0000; sock.write(eventMsg(0x2f, 1, 1)); }
        snapshot(sock);
      }
    }
  });
  sock.on('close', () => console.log('sim: client gone'));
  sock.on('error', () => {});
});

// ambient activity: simulate someone walking past the zone-2 PIR every ~6s
// (a brief unseal event followed by a seal event, as P199E 6E would send).
setInterval(() => {
  const conns = server._conns; if (!conns || !conns.size) return;
  conns.forEach((c) => c.write(eventMsg(0x00, 2, 0)));          // zone 2 unsealed
  setTimeout(() => conns.forEach((c) => c.write(eventMsg(0x01, 2, 0))), 1800); // resealed
}, 6000);

server.on('connection', (c) => { (server._conns = server._conns || new Set()).add(c); c.on('close', () => server._conns.delete(c)); });
server.listen(PORT, () => console.log(`sim panel listening on tcp :${PORT}`));
