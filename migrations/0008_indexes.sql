-- Indexes for the queries that run on every request or every minute.
-- The dispatcher reads pending jobs by state, priority and age; the webhook and the sweep find a job by run id.
CREATE INDEX IF NOT EXISTS idx_queue_state_priority_created ON queue (state, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_queue_run_id ON queue (run_id);
-- The cache lookup for an identical query.
CREATE INDEX IF NOT EXISTS idx_checks_cache_key_created ON checks (cache_key, created_at);
-- A Monitor webhook finds its watch by monitor id.
CREATE INDEX IF NOT EXISTS idx_watches_monitor_id ON watches (monitor_id);
-- Snapshots are found by the watch or the check they belong to, and purged by the same columns.
CREATE INDEX IF NOT EXISTS idx_snapshots_watch_id ON snapshots (watch_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_check_id ON snapshots (check_id);
-- A watch's history, newest first.
CREATE INDEX IF NOT EXISTS idx_events_watch_created ON events (watch_id, created_at);
