'use strict';

function makeRateLimiter({ windowMs, max }) {
  const buckets = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      if (now - b.start > windowMs * 4) buckets.delete(k);
    }
  }, windowMs).unref();

  return function rateLimit(req, res, next) {
    const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.start > windowMs) {
      b = { start: now, count: 0 };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      const retryAfter = Math.ceil((b.start + windowMs - now) / 1000);
      res.set('Retry-After', String(Math.max(1, retryAfter)));
      return res
        .status(429)
        .json({ ok: false, error: { code: 'rate_limited', message: 'too many requests' } });
    }
    next();
  };
}

module.exports = { makeRateLimiter };
