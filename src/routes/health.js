'use strict';

module.exports = function healthRoute({ config }) {
  return function health(req, res) {
    res.json({
      ok: true,
      data: {
        name: 'ton-explorer',
        version: config.version,
        uptime_seconds: Math.floor((Date.now() - config.startedAt) / 1000),
        network: config.network,
      },
    });
  };
};
