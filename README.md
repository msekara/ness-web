# Ness D8x / D16x Monitor

A small web application that talks to a Ness D8x/D16x alarm panel over its
RS232 ASCII serial interface (Doc 362S27 Rev 13), keeps a live picture of the
system, and lets you send commands from the browser.

```
 panel  <—RS232/TCP—>  Node server  <—WebSocket—>  browser dashboard
                       (decode/encode + state cache + polling)
```

The dashboard shows the overall system state (disarmed / armed / entry delay /
alarm), a 16-zone LED grid, arming status, alarms & warnings, output states,
firmware version, a live event log, and the raw serial stream. A keypad and
command bar let you arm, disarm, send keystrokes, and request specific status
forms.

## Requirements

- Node.js 18 or newer.
- A serial link to the panel — either:
  - a **serial-to-Ethernet adapter** (e.g. a Ness IP232 or any TCP serial
    bridge) — recommended, no native modules needed; or
  - a **local serial port** (USB-RS232 adapter) — needs the optional
    `serialport` module.
- On the panel, the ASCII bus must be enabled. Relevant program options
  (`P199E`): `1E` include address, `2E` include time stamp, `3E` alarms,
  `4E` warnings, `5E` access events, `6E` zone seal state. Serial is fixed at
  **9600 8N1**.

## Install & run

```bash
npm install
npm start
```

Then open http://localhost:3000

### Configuration (environment variables)

| Variable           | Default          | Meaning                                        |
|--------------------|------------------|------------------------------------------------|
| `NESS_CONN`        | `tcp`            | `tcp` or `serial`                              |
| `NESS_HOST`        | `192.168.1.50`   | panel adapter IP (tcp)                         |
| `NESS_PORT`        | `2401`           | panel adapter TCP port                         |
| `NESS_SERIAL_PATH` | `/dev/ttyUSB0`   | serial device (serial)                         |
| `NESS_BAUD`        | `9600`           | baud rate (serial)                             |
| `NESS_ADDRESS`    | `0`              | panel address nibble (last digit of P73E; 0 is always accepted) |
| `HTTP_PORT`        | `3000`           | dashboard port                                 |
| `NESS_ZONES`       | `8`              | zone count (D8x = 8, D16x = 16)                |
| `POLL_MS`          | `4000`           | full status-refresh interval (`0` disables)    |
| `ZONE_POLL_MS`     | `800`            | fast zone-refresh interval (`0` disables)      |

Examples:

```bash
# TCP adapter
NESS_HOST=192.168.1.42 NESS_PORT=2401 npm start

# Local USB serial
NESS_CONN=serial NESS_SERIAL_PATH=/dev/ttyUSB0 npm start
```

## Try it without hardware

A simulated panel is included:

```bash
npm run sim                                   # terminal 1  (TCP :2401)
NESS_HOST=127.0.0.1 NESS_PORT=2401 npm start  # terminal 2
```

## Model / firmware / view state stay blank

These three fields come **only** from status requests (ID 17 for model +
firmware, ID 16 for view state) — there's no event that reports them. Zones,
arming, alarms and outputs also arrive in the event stream, so they can update
even when status polling isn't answered; the three status-only fields can't.

If they're blank, the panel isn't returning those forms. Confirm from the
**Serial / system** tab: pick `17 — Version` in the status dropdown, click
**Request status**, and see whether any line comes back. Some D8x firmware
doesn't answer every form. Enabling **`P199E 7E`** makes the panel send a
periodic version message on its own, which will fill the model/firmware fields
even if on-demand requests aren't answered.

## Zones not reacting when you walk past a sensor?

A PIR only *unseals* its zone for a second or two per trip. The dashboard
reacts to this two ways:

1. **Pushed events (best).** Enable **`P199E 6E`** (Zone Seal State) on the
   panel so it sends unseal/seal events as they happen. The grid updates the
   instant an event arrives — no polling lag.
2. **Fast polling (fallback).** Even without `6E`, the server re-reads zone
   state every `ZONE_POLL_MS` (default 800 ms) so most trips are still caught.
   Lower it (e.g. `ZONE_POLL_MS=400`) if brief trips slip through.

If a zone still never changes: check the detector actually unseals the zone
(some are configured for entry/exit or 24 hr behaviour), confirm the panel
address, and watch the **Serial / system** tab — every line the panel sends
appears there, so you can see whether unseal messages are arriving at all.

## Test the protocol library

```bash
npm test
```

This checks the encoder/decoder against the worked examples in the spec
(the `S00`→`E9` and `A123E`→`7E` checksums, the FORM 4 zone examples, the
Duress event with its decimal timestamp, arming/output forms, and version).

## How commands map to the wire

Commands are built exactly as a keypad user would press them, wrapped in the
input frame `START 0x83 | address | length | CMD 0x60 | data | checksum | ?`:

| Dashboard action | Data sent | Notes                              |
|------------------|-----------|------------------------------------|
| Arm Away         | `A<code>E`| Arm key + user code + Enter        |
| Arm Home         | `H<code>E`| Home/Monitor key + code + Enter    |
| Disarm           | `<code>E` | user code + Enter                  |
| Send keys        | `<keys>E` | raw keystrokes                     |
| Request status   | `S<nn>`   | 2-digit status ID (0–18)           |
| Panic            | `P`       | keypad panic                       |

Aux outputs follow the keypad convention: `11*`…`44*` turn Aux 1–4 on and
`11#`…`44#` turn them off (requires `P141E 4E`…`P144E 4E`).

## Notes on the protocol implementation

A couple of things in Rev 13 are worth flagging, since they're handled here:

- **Timestamp fields are decimal, not hex.** In an event message the 6
  timestamp bytes are read as decimal from their two ASCII characters (so
  `43` means 43 minutes), while all other fields are hex. This is verified by
  the spec's own Duress example.
- **Status responses carry an address even though `START = 0x82`.** The
  START bit that flags "address included" is clear for `0x82`, yet the
  documented status message (`82 07 03 60 …`) still contains an address byte.
  The decoder resolves this by checking which layout yields a valid command
  byte and the exact message length, so both event and status frames parse
  correctly.
- **Received checksums are not enforced.** The spec's output-checksum worked
  examples don't self-verify cleanly (the decimal timestamp fields make "sum
  of bytes" ambiguous), so incoming messages are parsed leniently and anything
  unparseable is shown verbatim in the serial log. Outgoing command checksums
  *are* computed strictly and match the spec examples — that's the part the
  panel validates.
- **Zone seal messages** (`P199E 6E`, the abbreviated `83 02 00 …` form) are
  logged raw rather than decoded; enable and watch the serial tab if you need
  them and adjust `lib/protocol.js` to taste.

## Files

```
server.js            panel link (TCP/serial) + WebSocket + static host + polling
lib/protocol.js      ASCII protocol encode/decode + lookup tables (no deps)
public/index.html    single-file dashboard (vanilla JS + WebSocket)
test/protocol.test.js  unit tests against the spec examples
test/sim-panel.js    fake panel for hardware-free testing
```

## Security

This tool has no authentication and can arm/disarm the panel. Run it only on a
trusted local network, behind your own auth/reverse proxy if exposed.
