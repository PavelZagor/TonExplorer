-- Track when we last polled an upstream for a pool, separate from the
-- timestamp of the newest trade. On a quiet pool `newest_synced_ts` can
-- legitimately be many minutes old while we're still polling every 8s —
-- showing only that field in the UI made it look like the system was
-- broken when it was working as designed.

ALTER TABLE trading_sync_state ADD COLUMN last_checked_at INTEGER;
