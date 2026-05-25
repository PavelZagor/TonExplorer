# 03 — Developer tracking

The core thesis of TonExplorer: **a token's risk is heavily a function of who deployed it**. We maintain a local registry of jetton deployers and grow it organically — every analysis writes back what it learned.

## Identity

A "developer" in our model is a single TON wallet address that deployed at least one jetton master we've observed. We canonicalize to **raw form** (`0:hex...`) so that bounceability flags / testnet flags don't fragment the key.

Caveats we acknowledge but accept for v1:

- One human ↔ many wallets. We're not doing clustering across wallets yet. (Phase 3+ — common-funding-source heuristics could let us merge.)
- "Deployer" ≠ "admin". The deployer sent the deploy message; the admin is whatever the contract currently reports. We track both.
- Admin can be renounced. A renounced jetton is **not** automatically safe — the deployer can still have made coordinated buys before renouncing.

## Schema (v0, SQLite)

```sql
CREATE TABLE IF NOT EXISTS developers (
  address       TEXT PRIMARY KEY,        -- raw form, 0:hex
  first_seen_at INTEGER NOT NULL,        -- unix seconds, when we first wrote them
  last_seen_at  INTEGER NOT NULL,
  jettons_count INTEGER NOT NULL DEFAULT 0,
  rugs_count    INTEGER NOT NULL DEFAULT 0,
  alive_count   INTEGER NOT NULL DEFAULT 0,
  notes         TEXT                     -- free-form, set via internal tooling only
);

CREATE TABLE IF NOT EXISTS jettons (
  address       TEXT PRIMARY KEY,        -- raw form
  deployer      TEXT,                    -- FK developers.address (nullable until derived)
  admin         TEXT,                    -- nullable (renounced = NULL)
  symbol        TEXT,
  name          TEXT,
  decimals      INTEGER,
  supply        TEXT,                    -- store as TEXT, jetton supplies can exceed 2^53
  deployed_at   INTEGER,                 -- unix seconds, from first inbound tx
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  fate          TEXT NOT NULL DEFAULT 'unknown',  -- alive | dead | rugged | unknown
  fate_reason   TEXT,                    -- short explanation set by the classifier
  FOREIGN KEY (deployer) REFERENCES developers(address)
);
CREATE INDEX IF NOT EXISTS idx_jettons_deployer ON jettons(deployer);

CREATE TABLE IF NOT EXISTS analyses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  jetton        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  score         INTEGER,                 -- 0-100 risk score, nullable until phase 1 ships
  verdict_json  TEXT NOT NULL,           -- full verdict snapshot, JSON blob
  FOREIGN KEY (jetton) REFERENCES jettons(address)
);
CREATE INDEX IF NOT EXISTS idx_analyses_jetton ON analyses(jetton);
CREATE INDEX IF NOT EXISTS idx_analyses_created ON analyses(created_at);
```

Migrations live in `src/db/migrations/`. Each migration is a numbered `.sql` file applied once and recorded in a `_migrations` table; never edit a shipped migration in place — add a new one.

## Fate classifier v0

`fate` is recomputed on every analysis. Heuristics (intentionally simple, easy to override later):

| Signal                                          | → fate     |
|-------------------------------------------------|------------|
| No transfers in 30+ days, holders < 50          | `dead`     |
| Top-1 holder > 70% AND mint still active        | `rugged` (heuristic — confirm in UI text) |
| Holders dropped > 90% from peak                 | `rugged`   |
| Last transfer < 7 days ago AND holders > 100    | `alive`    |
| Nothing else conclusive                         | `unknown`  |

We surface the **reason** in `fate_reason` so the UI can show *why* a token was classified that way. Heuristics will be wrong sometimes; transparency lets users discount appropriately.

## Reputation score v0

Per developer:

```
reputation_score = clamp(0, 100,
    50
  + 10 * alive_count
  - 25 * rugs_count
)
```

If `jettons_count < 2`, the score is shown but flagged "low-confidence". Single-launch developers don't have a track record yet.

This formula is deliberately crude — it's a placeholder that gives the UI something to render. Phase 1's exit criteria includes a real weighting pass once we have enough data.

## Manual overrides

Sometimes a developer is just known. A research team rugs five projects under different addresses but we recognize the pattern. For that we have `developers.notes` plus a (Phase 1) admin-only endpoint:

```
POST /admin/developers/{address}/note  { note: "...", tag: "rugger" | "trusted" | null }
```

Auth on this endpoint: bearer token from `.env` (`ADMIN_TOKEN`). Off by default; only on if `ADMIN_TOKEN` is set. **Never** expose this to public. The token lives in `.env` only.

## Walker

A background script (`tools/walk-developer.js <address>`) enumerates everything a known developer ever deployed and backfills our DB. Run on demand from CLI in Phase 1; promote to a cron in Phase 5.

Walking logic:
1. Fetch the developer's account history via TonAPI.
2. Filter for outbound messages where the destination is a jetton master (recognized by code hash or by message body containing jetton-deploy opcodes).
3. Upsert each discovered jetton with `deployer = <this address>`.
4. For each, classify fate.

Rate-limit budget: at most 1 walker per developer at a time; throttle to ~1 TonAPI request per 500ms to stay under free-tier limits.
