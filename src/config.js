/**
 * Ness Alarm Server Configuration
 *
 * Copy this file to config.local.js to override settings locally,
 * or set environment variables.
 */

module.exports = {
  // ─── IP232 connection ────────────────────────────────────────────────────
  ip232: {
    // IP address of the IP232 module (set in its web interface)
    host: process.env.NESS_HOST || '10.1.1.125',
    // TCP port configured on the IP232 (default is 4196)
    port: parseInt(process.env.NESS_PORT || '2401', 10),
    // Reconnect delay in ms when connection drops
    reconnectDelay: parseInt(process.env.NESS_RECONNECT_DELAY || '5000', 10),
    // How often (ms) to send a keepalive status poll when idle
    keepaliveInterval: parseInt(process.env.NESS_KEEPALIVE_INTERVAL || '20000', 10),
    // Socket read timeout — reconnect if no data received within this window (ms)
    readTimeout: parseInt(process.env.NESS_READ_TIMEOUT || '90000', 10),
  },

  // ─── Panel configuration ─────────────────────────────────────────────────
  panel: {
    // Number of zones on your panel (8 or 16)
    zoneCount: parseInt(process.env.NESS_ZONE_COUNT || '8', 10),
    // Optional friendly names for zones (index 0 = zone 1, index 1 = zone 2, …)
    // To override via environment variable: NESS_ZONE_NAMES="Front door,Garage,Hallway"
    zoneNames: process.env.NESS_ZONE_NAMES
      ? process.env.NESS_ZONE_NAMES.split(',')
      : [
          'Zone 1',
          'Zone 2',
          'Zone 3',
          'Zone 4',
          'Zone 5',
          'Zone 6',
          'Zone 7',
          'Zone 8',
        ],
    // Number of AUX outputs (up to 8)
    outputCount: parseInt(process.env.NESS_OUTPUT_COUNT || '4', 10),
  },

  // ─── HTTP / WebSocket API ────────────────────────────────────────────────
  server: {
    port: parseInt(process.env.PORT || '5555', 10),
    // Set to '0.0.0.0' to listen on all interfaces, '127.0.0.1' for localhost only
    host: process.env.HOST || '0.0.0.0',
    // Optional static API key — if set, all requests must include
    // the header:  Authorization: Bearer <apiKey>
    // Leave blank to disable authentication (not recommended on a public network)
    apiKey: process.env.NESS_API_KEY || '',
  },
};
