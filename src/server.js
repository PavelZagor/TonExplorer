'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');

const { openDb, runMigrations } = require('./db');
const { makeTonApiClient } = require('./lib/tonapi');
const { makeRateLimiter } = require('./lib/rate-limit');
const { logger, requestLogger } = require('./lib/logger');
const { makeAdminAuth } = require('./lib/auth');
const { makeDedustClient } = require('./services/dedust-client');
const { makeStonfiClient } = require('./services/stonfi-client');
const { makeDexDetection } = require('./services/dex-detection');
const { makeTradeStream } = require('./services/trade-stream');
const buildRoutes = require('./routes');
const buildAdminWalletRouter = require('./routes/admin/wallet');
const { makeTradingWs } = require('./routes/trading-ws');

const PORT = Number(process.env.PORT || 3031);
const BASE_PATH = normalizeBasePath(process.env.BASE_PATH || '/explorer');
const TRUST_PROXY = process.env.TRUST_PROXY || 'loopback';
const NETWORK = (process.env.TON_NETWORK || 'mainnet').toLowerCase();
const SQLITE_PATH = process.env.SQLITE_PATH || 'data/explorer.sqlite';
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const pkg = require('../package.json');
const STARTED_AT = Date.now();

function normalizeBasePath(p) {
  if (!p || p === '/') return '';
  let out = p.startsWith('/') ? p : `/${p}`;
  if (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

async function main() {
  const db = openDb(path.resolve(__dirname, '..', SQLITE_PATH));
  runMigrations(db);

  const tonapi = makeTonApiClient({
    network: NETWORK,
    apiKey: process.env.TONAPI_KEY || '',
  });

  const dedust = makeDedustClient({
    baseURL: process.env.DEDUST_API_URL || undefined,
    cacheTtlSec: Number(process.env.DEDUST_CACHE_TTL_SECONDS || 300),
    logger,
  });

  const stonfi = makeStonfiClient({
    baseURL: process.env.STONFI_API_URL || undefined,
    cacheTtlSec: Number(process.env.STONFI_CACHE_TTL_SECONDS || 300),
    logger,
  });

  const dexDetection = makeDexDetection({ dedust, stonfi, logger });
  const tradeStream  = makeTradeStream({ dedust, db, logger, intervalMs: Number(process.env.TRADING_POLL_MS || 8_000) });

  const app = express();
  app.set('trust proxy', TRUST_PROXY);
  app.set('x-powered-by', false);

  app.use(requestLogger(logger));

  const ADMIN_PREFIX = `${BASE_PATH}/api/admin`;

  // Public API is read-only — GET/HEAD/OPTIONS only. The admin subtree under
  // /api/admin is exempt and gated by Bearer-token auth instead.
  app.use((req, res, next) => {
    if (req.path.startsWith(ADMIN_PREFIX + '/') || req.path === ADMIN_PREFIX) return next();
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    res.status(405).json({ ok: false, error: { code: 'method_not_allowed', message: 'GET only' } });
  });

  // Permissive CORS for GETs.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const rateLimit = makeRateLimiter({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
    max: Number(process.env.RATE_LIMIT_MAX || 60),
  });

  const ctx = {
    db,
    tonapi,
    dedust,
    dexDetection,
    tradeStream,
    logger,
    config: {
      version: pkg.version,
      network: NETWORK,
      basePath: BASE_PATH,
      publicOrigin: PUBLIC_ORIGIN,
      startedAt: STARTED_AT,
      tradingBackfillLimit:  Number(process.env.TRADING_BACKFILL_LIMIT  || 500),
      tradingIncrementLimit: Number(process.env.TRADING_INCREMENT_LIMIT || 200),
    },
  };

  // Admin mounted BEFORE the public router so its path takes precedence.
  // Auth middleware fail-closes when ADMIN_TOKEN is empty (503 admin_disabled).
  app.use(ADMIN_PREFIX, makeAdminAuth({ token: ADMIN_TOKEN }), buildAdminWalletRouter(ctx));

  const router = buildRoutes(ctx);
  app.use(`${BASE_PATH}/api`, rateLimit, router);

  // Static views — inject BASE_PATH into the HTML so the frontend uses the right prefix.
  // No-cache here because we ship templates without content hashes and want a
  // PM2 reload to be visible to clients without a manual hard refresh. The
  // ETag still saves bandwidth via conditional 304s.
  const htmlHeaders = (res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-cache, must-revalidate');
  };
  app.get([`${BASE_PATH}/`, `${BASE_PATH}`], (req, res) => {
    htmlHeaders(res);
    res.send(renderTemplate('index.html', BASE_PATH));
  });

  // Trading page. The :address segment is read on the client from location.pathname.
  app.get(`${BASE_PATH}/trading/:address`, (req, res) => {
    htmlHeaders(res);
    res.send(renderTemplate('trading.html', BASE_PATH));
  });

  app.use(`${BASE_PATH}/static`, express.static(path.join(__dirname, '..', 'views', 'static')));

  // Fallback 404 inside our basepath
  app.use(`${BASE_PATH}/api`, (req, res) => {
    res.status(404).json({ ok: false, error: { code: 'not_found', message: 'no such endpoint' } });
  });

  app.use((err, req, res, _next) => {
    (req.log || logger).error('unhandled', { err: err && err.stack ? err.stack : String(err) });
    res.status(500).json({ ok: false, error: { code: 'internal', message: 'internal error' } });
  });

  const server = app.listen(PORT, () => {
    logger.info('listening', {
      version: pkg.version,
      port: PORT,
      base_path: BASE_PATH || '/',
      network: NETWORK,
      admin_enabled: ADMIN_TOKEN ? true : false,
    });
    if (!ADMIN_TOKEN) {
      logger.warn('admin disabled', { reason: 'ADMIN_TOKEN is empty — /api/admin/* returns 503' });
    }
  });

  // WebSocket: live trade stream at ${BASE_PATH}/api/trading/:jetton/stream
  const tradingWs = makeTradingWs({ ctx, maxClients: Number(process.env.TRADING_MAX_WS_CLIENTS || 100) });
  tradingWs.attach(server, BASE_PATH);

  // Graceful shutdown — flush WS clients and stop poll timers.
  function shutdown(signal) {
    logger.info('shutdown', { signal });
    tradingWs.shutdown();
    tradeStream.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

function renderTemplate(name, basePath) {
  const fs = require('fs');
  const tmpl = fs.readFileSync(path.join(__dirname, '..', 'views', name), 'utf8');
  return tmpl.replace(/__BASE_PATH__/g, basePath);
}

main().catch((err) => {
  logger.error('fatal', { err: err && err.stack ? err.stack : String(err) });
  process.exit(1);
});
