'use strict';

// WebSocket handler for /api/trading/:jetton/stream.
//
// Wire-up:
//   * One `ws.Server` instance per process, started with `noServer: true`.
//   * `attachWsUpgrade(server, ...)` hooks the HTTP server's `upgrade` event
//     and routes path-matching upgrades into the WS server.
//
// Client protocol:
//   client → (no messages expected; URL carries the address)
//   server → on connect:
//     { type: 'subscribed', jetton, pool, paired_with }    (success)
//     { type: 'error',      code, message }                (then close)
//   server → on each new trade:
//     { type: 'trade', data: <normalised trade row> }
//   server → every HEARTBEAT_MS:
//     { type: 'ping', ts }
//   client → optional `pong` text frame OK; ws lib also handles native ping/pong.

const WebSocket = require('ws');

const { toRaw, isValid } = require('../lib/address');
const { getTradingPool } = require('../db');

const HEARTBEAT_MS = 30_000;
const DEFAULT_MAX_CLIENTS = 100;

function makeTradingWs({ ctx, maxClients = DEFAULT_MAX_CLIENTS }) {
  const { db, dexDetection, tradeStream, logger, config } = ctx;
  if (!tradeStream) throw new Error('tradeStream is required on ctx');

  const wss = new WebSocket.Server({ noServer: true, clientTracking: true });

  // Per-WS state: pool, unsubscribe thunk, listener function (so we can off()).
  function attachClient(ws, { jettonRaw, poolRow }) {
    let alive = true;

    // Heartbeat: emit JSON ping every HEARTBEAT_MS; close on missed pongs.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const heartbeat = setInterval(() => {
      if (!ws.isAlive) {
        if (logger) logger.info('trading-ws heartbeat timeout, closing', { pool: poolRow.pool_address });
        try { ws.terminate(); } catch {}
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
      try { ws.send(JSON.stringify({ type: 'ping', ts: Math.floor(Date.now() / 1000) })); } catch {}
    }, HEARTBEAT_MS);
    if (heartbeat.unref) heartbeat.unref();

    const onTrade = ({ pool, data }) => {
      if (!alive) return;
      if (pool !== poolRow.pool_address) return;
      try { ws.send(JSON.stringify({ type: 'trade', data })); } catch {}
    };
    tradeStream.on('trade', onTrade);

    const unsubscribe = tradeStream.subscribe(poolRow.pool_address);

    const cleanup = () => {
      if (!alive) return;
      alive = false;
      clearInterval(heartbeat);
      tradeStream.off('trade', onTrade);
      try { unsubscribe(); } catch {}
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);

    // Greet the client immediately.
    try {
      ws.send(JSON.stringify({
        type: 'subscribed',
        jetton: jettonRaw,
        pool: poolRow.pool_address,
        paired_with: poolRow.paired_with,
      }));
    } catch {}
  }

  function sendErrorAndClose(ws, code, message) {
    try { ws.send(JSON.stringify({ type: 'error', code, message })); } catch {}
    try { ws.close(1011); } catch {}
  }

  // pathname is the request URL pathname AFTER the BASE_PATH prefix has been
  // matched off. Returns { jettonRaw } or null if it doesn't match.
  function matchStreamPath(pathname) {
    // expected: /api/trading/<jetton>/stream
    const m = /^\/api\/trading\/([^/]+)\/stream\/?$/.exec(pathname);
    if (!m) return null;
    const jetton = decodeURIComponent(m[1]);
    if (!isValid(jetton)) return null;
    return { jettonRaw: toRaw(jetton) };
  }

  wss.on('connection', async (ws, request, ctxFromUpgrade) => {
    const { jettonRaw } = ctxFromUpgrade;

    if (wss.clients.size > maxClients) {
      return sendErrorAndClose(ws, 'too_many_clients', `server at capacity (max ${maxClients})`);
    }

    let detection;
    try {
      detection = await dexDetection.detectDexes(jettonRaw);
    } catch (err) {
      if (logger) logger.warn('trading-ws detection failed', { jetton: jettonRaw, err: err.message });
      return sendErrorAndClose(ws, 'upstream_unavailable', 'dex registry unreachable');
    }
    if (!detection.primary) {
      return sendErrorAndClose(ws, 'not_listed', 'jetton is not on any tracked DEX');
    }

    const poolRow = getTradingPool(db, detection.primary.pool);
    if (!poolRow) {
      return sendErrorAndClose(ws, 'pool_not_found', 'primary pool not in registry — call /info first');
    }

    attachClient(ws, { jettonRaw, poolRow });
  });

  // attach the upgrade listener to a node http.Server. `basePath` is the
  // BASE_PATH prefix the rest of the app is mounted under.
  function attach(server, basePath = '') {
    server.on('upgrade', (request, socket, head) => {
      try {
        const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
        const pathname = url.pathname;
        if (!pathname.startsWith(basePath + '/')) return socket.destroy();
        const after = pathname.slice(basePath.length);
        const match = matchStreamPath(after);
        if (!match) return socket.destroy();
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request, match);
        });
      } catch (err) {
        if (logger) logger.warn('trading-ws upgrade error', { err: err.message });
        try { socket.destroy(); } catch {}
      }
    });
    if (logger) logger.info('trading-ws attached', { base_path: basePath, max_clients: maxClients });
  }

  function shutdown() {
    for (const client of wss.clients) {
      try { client.close(1001, 'server shutting down'); } catch {}
    }
    wss.close();
  }

  return { attach, shutdown, _wss: wss };
}

module.exports = { makeTradingWs };
