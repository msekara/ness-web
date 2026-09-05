# ness-web

Node.js server that controls a **Ness D8x / D16x** alarm panel via the
**Ness IP232** serial-over-ethernet module.

Exposes a simple REST + WebSocket API so you can integrate the alarm into
any home automation system, write your own UI, or just `curl` it from a script.

---

## Hardware setup

```
[Ness D8x/D16x] ←── RS-232 ──→ [IP232 module] ←── TCP/IP ──→ [This server]
```

On the IP232's web interface:
- Set **Baud rate** to `9600`
- Set **Data bits** to `8`, **Parity** to `None`, **Stop bits** to `1`
- Note the **TCP port** (default `2401`) and the module's **IP address**

---

## Installation

Requires Node.js 18+.

```bash
cd ness-web
npm install
```

### Configuration

Edit `src/config.js` or copy it to `src/config.local.js` and set your values:

```js
// src/config.local.js
const base = require('./config');
module.exports = {
  ...base,
  ip232: {
    ...base.ip232,
    host: '10.1.1.125',   // ← your IP232's IP
    port: 2401,
  },
  panel: {
    ...base.panel,
    zoneCount: 8,
    zoneNames: ['Front door', 'Garage', 'Hallway', 'Back yard', 'Lounge', 'Bedroom 1', 'Bedroom 2', 'Laundry'],
    outputCount: 2,
  },
  server: {
    ...base.server,
    port: 5555,
    apiKey: 'my-secret-key',  // optional — leave blank to disable auth
  },
};
```

Or use environment variables (see `.env.example`).

### Start

```bash
npm start
```

For development with auto-restart on file changes:

```bash
npm run dev
```

---

## REST API

All endpoints return JSON. If `apiKey` is configured, include it as:
```
Authorization: Bearer <apiKey>
```

### GET `/health`
No auth required. Returns server + connection status.

```json
{ "ok": true, "connected": true, "uptime": 3600 }
```

### GET `/state`
Full alarm state snapshot.

```json
{
  "armingState": "DISARMED",
  "armingMode": null,
  "zones": {
    "1": { "unsealed": false, "name": "Front door" },
    "2": { "unsealed": true,  "name": "Garage" }
  },
  "outputs": {
    "1": { "on": false },
    "2": { "on": false }
  },
  "siren": false,
  "strobe": false,
  "panelBattOk": true,
  "mainsPowerOk": true,
  "lastUpdated": "2026-09-04T13:30:00.000Z"
}
```

`armingState` values:
| Value | Meaning |
|---|---|
| `DISARMED` | Panel disarmed |
| `ARMING` | Exit delay in progress |
| `ARMED_AWAY` | Fully armed (away) |
| `ARMED_HOME` | Home / stay arm |
| `ARMED_DAY` | Day mode |
| `ARMED_NIGHT` | Night mode |
| `ENTRY_DELAY` | Entry delay active |
| `ALARM` | Alarm triggered |

### POST `/arm/away`
Arm away. Body (optional): `{ "code": "1234" }`

### POST `/arm/home`
Arm home / stay. Body (optional): `{ "code": "1234" }`

### POST `/arm/night`
Arm night. Body (optional): `{ "code": "1234" }`

### POST `/disarm`
Disarm. Body (required): `{ "code": "1234" }`

### POST `/output/:n/on`
Activate AUX output `n` (1–8).

### POST `/output/:n/off`
Deactivate AUX output `n`.

---

## WebSocket API

Connect to `ws://<host>:<port>/ws` (append `?apiKey=<key>` if auth is enabled).

On connection you immediately receive a `state` event with the full current state.
After that, events are pushed in real time as things change.

### Message format

```json
{ "event": "<eventName>", "data": { ... } }
```

### Events

| Event | Data |
|---|---|
| `state` | Full state snapshot (sent on connect) |
| `stateChange` | `{ previous, current, mode }` |
| `zoneChange` | `{ zone, unsealed, name }` |
| `outputChange` | `{ output, on }` |
| `systemEvent` | `{ eventName, zone, area, timestamp }` |
| `connected` | _(no data)_ |
| `disconnected` | _(no data)_ |

### JavaScript example

```js
const ws = new WebSocket('ws://192.168.1.10:5555/ws');

ws.onmessage = (msg) => {
  const { event, data } = JSON.parse(msg.data);

  if (event === 'stateChange') {
    console.log(`Alarm → ${data.current}`);
  }
  if (event === 'zoneChange') {
    console.log(`Zone ${data.zone} (${data.name}): ${data.unsealed ? 'OPEN' : 'closed'}`);
  }
};
```

---

## curl examples

```bash
# Get state
curl http://localhost:5555/state

# Arm away (no code)
curl -X POST http://localhost:5555/arm/away

# Arm away with code
curl -X POST http://localhost:5555/arm/away -H 'Content-Type: application/json' -d '{"code":"1234"}'

# Disarm
curl -X POST http://localhost:5555/disarm -H 'Content-Type: application/json' -d '{"code":"1234"}'

# Turn output 1 on
curl -X POST http://localhost:5555/output/1/on

# With API key
curl -H 'Authorization: Bearer my-secret-key' http://localhost:5555/state
```

---

## Running as a service (systemd)

```ini
# /etc/systemd/system/ness-web.service
[Unit]
Description=Ness Web Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ness-web
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=10
Environment=NESS_HOST=192.168.1.50
Environment=NESS_PORT=4196
Environment=PORT=5555
Environment=NESS_API_KEY=my-secret-key

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now ness-web
sudo journalctl -u ness-web -f
```

---

## Project structure

```
ness-web/
├── src/
│   ├── index.js        Entry point — wires everything together
│   ├── config.js       Default configuration (edit or override with config.local.js)
│   ├── protocol.js     Ness ASCII packet encode/decode, checksum, command builders
│   ├── connection.js   IP232 TCP socket client with auto-reconnect
│   ├── alarmState.js   State machine — tracks zones, arming state, outputs
│   ├── client.js       High-level client (connection + state + keepalive)
│   └── server.js       Express HTTP API + WebSocket server
├── dashboard.html
├── .env.example
├── package.json
└── README.md
```

---

## Protocol notes

- Baud rate: 9600, 8N1 (configured on the IP232 side)
- Command packets use ASCII encoding: `start(1B) + length(1B) + command(1B) + data + checksum(1B) + CRLF`
- Checksum: two's complement — `(256 - (sum_of_bytes & 0xFF)) % 256`
- Arm away: `A[code]E` | Arm home: `H[code]E` | Disarm: `[code]E`
- AUX on: `nn*` | AUX off: `nn#` (where `nn` is the two-digit output number)
- Status polls: `S00` (zones 1–16), `S14` (arming), `S18` (aux outputs)

Reference: [Ness D8-D16 ASCII Protocol](http://www.nesscorporation.com/Software/Ness_D8-D16_ASCII_protocol_rev13.pdf)
