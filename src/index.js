'use strict';

// Config loading order (first found wins):
//   1. NESS_CONFIG env var — explicit path, e.g. /etc/ness-web/config.js
//   2. src/config.local.js — drop-in local override for development
//   3. src/config.js       — built-in defaults
let config;
const configEnvPath = process.env.NESS_CONFIG;
if (configEnvPath) {
  config = require(configEnvPath);
  console.log(`[boot] Using config from NESS_CONFIG: ${configEnvPath}`);
} else {
  try {
    config = require('./config.local');
    console.log('[boot] Using config.local.js');
  } catch {
    config = require('./config');
    console.log('[boot] Using default config.js — copy to src/config.local.js to customise');
  }
}

const { NessClient }  = require('./client');
const { createServer } = require('./server');

async function main() {
  console.log(`[boot] Ness alarm server starting`);
  console.log(`[boot] Panel at ${config.ip232.host}:${config.ip232.port}`);
  console.log(`[boot] HTTP/WS on ${config.server.host}:${config.server.port}`);

  const client = new NessClient(config);
  const server = createServer(client, config);

  // ─── Start HTTP server ──────────────────────────────────────────────────
  await new Promise((resolve) => {
    server.listen(config.server.port, config.server.host, resolve);
  });
  console.log(`[boot] Listening on http://${config.server.host}:${config.server.port}`);

  // ─── Connect to panel ───────────────────────────────────────────────────
  try {
    await client.start();
  } catch (err) {
    // Connection errors are handled internally with auto-reconnect.
    // Log here but don't crash — the reconnect loop will take over.
    console.warn(`[boot] Initial connection failed: ${err.message} — will retry`);
  }

  // ─── Graceful shutdown ──────────────────────────────────────────────────
  function shutdown(signal) {
    console.log(`\n[boot] Received ${signal} — shutting down`);
    client.stop();
    server.close(() => {
      console.log('[boot] HTTP server closed');
      process.exit(0);
    });
    // Force exit after 5s if something hangs
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    console.error('[boot] Uncaught exception:', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[boot] Unhandled rejection:', reason);
  });
}

main();
