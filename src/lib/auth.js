'use strict';

// Bearer-token auth for the /api/admin/* subtree.
// Token is read from `ADMIN_TOKEN` in the environment. If the env var is unset
// or empty, the entire admin subtree is disabled (503) — fail-closed.

function makeAdminAuth({ token }) {
  const configured = typeof token === 'string' && token.length > 0;
  return function adminAuth(req, res, next) {
    if (!configured) {
      return res.status(503).json({
        ok: false,
        error: { code: 'admin_disabled', message: 'ADMIN_TOKEN is not configured on this instance' },
      });
    }
    const header = req.get('authorization') || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m || m[1] !== token) {
      return res.status(401).json({
        ok: false,
        error: { code: 'unauthorized', message: 'valid Bearer token required' },
      });
    }
    next();
  };
}

module.exports = { makeAdminAuth };
