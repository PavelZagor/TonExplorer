'use strict';

const express = require('express');

const { toRaw, isValid } = require('../../lib/address');
const {
  getWallet,
  upsertWallet,
  listWalletLinks,
  upsertWalletLink,
  deleteWalletLink,
} = require('../../db');

// Whitelist of permitted link kinds. New ones can be added explicitly here;
// we don't want users to invent arbitrary kinds that the UI then has to ignore.
const LINK_KINDS = new Set(['funded_by', 'cluster_with', 'controls']);

function clean(s, maxLen) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

function cleanTags(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    const t = clean(raw, 24);
    if (!t) continue;
    const norm = t.toLowerCase().replace(/[^a-z0-9_\-]/g, '');
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= 8) break;
  }
  return out;
}

module.exports = function adminWalletRouter({ db }) {
  const r = express.Router();
  r.use(express.json({ limit: '16kb' }));

  // GET current wallet record (so the edit form can pre-fill).
  r.get('/wallet/:address', (req, res) => {
    if (!isValid(req.params.address)) {
      return res.status(400).json({ ok: false, error: { code: 'bad_address', message: 'invalid TON address' } });
    }
    const addr = toRaw(req.params.address);
    const row = getWallet(db, addr);
    res.json({
      ok: true,
      data: {
        address: addr,
        label: row?.label || null,
        notes: row?.notes || null,
        tags: row?.tags || [],
        links: listWalletLinks(db, addr),
        created_at: row?.created_at || null,
        updated_at: row?.updated_at || null,
      },
    });
  });

  // Upsert label/notes/tags.
  r.put('/wallet/:address', (req, res) => {
    if (!isValid(req.params.address)) {
      return res.status(400).json({ ok: false, error: { code: 'bad_address', message: 'invalid TON address' } });
    }
    const addr = toRaw(req.params.address);
    const body = req.body || {};
    const saved = upsertWallet(db, {
      address: addr,
      label: clean(body.label, 80),
      notes: clean(body.notes, 1000),
      tags:  cleanTags(body.tags),
    });
    res.json({ ok: true, data: saved });
  });

  // Add or upsert a link from this address.
  r.post('/wallet/:address/links', (req, res) => {
    if (!isValid(req.params.address)) {
      return res.status(400).json({ ok: false, error: { code: 'bad_address', message: 'invalid from address' } });
    }
    const from = toRaw(req.params.address);
    const body = req.body || {};
    if (!isValid(body.to_addr || '')) {
      return res.status(400).json({ ok: false, error: { code: 'bad_address', message: 'invalid to_addr' } });
    }
    const to = toRaw(body.to_addr);
    const kind = clean(body.kind, 24);
    if (!kind || !LINK_KINDS.has(kind)) {
      return res.status(400).json({
        ok: false,
        error: { code: 'bad_kind', message: `kind must be one of: ${[...LINK_KINDS].join(', ')}` },
      });
    }
    if (from === to) {
      return res.status(400).json({ ok: false, error: { code: 'self_link', message: 'self-links are not allowed' } });
    }
    const link = upsertWalletLink(db, { from_addr: from, to_addr: to, kind, notes: clean(body.notes, 500) });
    res.json({ ok: true, data: link });
  });

  // Delete a link by id.
  r.delete('/wallet/links/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: { code: 'bad_id', message: 'id must be a positive integer' } });
    }
    const ok = deleteWalletLink(db, id);
    if (!ok) return res.status(404).json({ ok: false, error: { code: 'not_found', message: 'link not found' } });
    res.json({ ok: true, data: { deleted: id } });
  });

  return r;
};
