'use strict';

// Single-line JSON logger. No deps, no config, no log levels filtering —
// everything ships to stdout/stderr and PM2 / journald / whatever takes it from there.
// Use `child(fields)` to attach context (e.g. req_id) that gets merged into every line.

function emit(level, msg, fields) {
  const line = { ts: new Date().toISOString(), level, msg, ...fields };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

function make(base) {
  return {
    info:  (msg, fields) => emit('info',  msg, { ...base, ...fields }),
    warn:  (msg, fields) => emit('warn',  msg, { ...base, ...fields }),
    error: (msg, fields) => emit('error', msg, { ...base, ...fields }),
    debug: (msg, fields) => emit('debug', msg, { ...base, ...fields }),
    child: (more) => make({ ...base, ...more }),
  };
}

const logger = make({ app: 'ton-explorer' });

// Express middleware: tag each request with a short id, log one line on finish.
function requestLogger(parent = logger) {
  let counter = 0;
  return function logEachRequest(req, res, next) {
    const reqId = (++counter).toString(36).padStart(3, '0') + '-' + Date.now().toString(36);
    const start = process.hrtime.bigint();
    req.log = parent.child({ req_id: reqId });
    res.on('finish', () => {
      const ns = Number(process.hrtime.bigint() - start);
      req.log.info('req', {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        duration_ms: Math.round(ns / 1e6),
      });
    });
    next();
  };
}

module.exports = { logger, requestLogger };
