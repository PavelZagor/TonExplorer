'use strict';

const { toRaw, isValid } = require('../lib/address');
const { getDeveloper, listJettonsByDeployer } = require('../db');
const { buildDeveloperCard } = require('../analyzers/developer');

module.exports = function developerRoute({ db }) {
  return function developer(req, res) {
    const input = req.params.address;
    if (!isValid(input)) {
      return res.status(400).json({ ok: false, error: { code: 'bad_address', message: 'invalid TON address' } });
    }
    const raw = toRaw(input);
    const row = getDeveloper(db, raw);
    const jettons = listJettonsByDeployer(db, raw);
    if (!row && jettons.length === 0) {
      return res.status(404).json({ ok: false, error: { code: 'not_found', message: 'developer not in registry yet' } });
    }
    res.json({
      ok: true,
      data: {
        ...buildDeveloperCard(row || { address: raw, jettons_count: jettons.length, rugs_count: 0, alive_count: 0 }),
        jettons: jettons.map((j) => ({
          address: j.address,
          symbol: j.symbol,
          name: j.name,
          fate: j.fate,
          fate_reason: j.fate_reason,
          deployed_at: j.deployed_at,
        })),
      },
    });
  };
};
