CREATE TABLE IF NOT EXISTS checks (
  check_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL,
  query_json TEXT,
  result_json TEXT,
  cache_key TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id TEXT PRIMARY KEY,
  check_id TEXT,
  watch_id TEXT,
  registry TEXT,
  url TEXT,
  reader_input TEXT,
  content_sha256 TEXT,
  body TEXT,
  run_id TEXT,
  step_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keys (
  registry TEXT NOT NULL,
  licence_number TEXT NOT NULL,
  link_json TEXT,
  resolved_at TEXT,
  PRIMARY KEY (registry, licence_number)
);

CREATE TABLE IF NOT EXISTS watches (
  watch_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  registry TEXT,
  licence_number TEXT,
  name TEXT,
  monitor_id TEXT,
  caller_webhook TEXT,
  last_fields_json TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queue (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT,
  state TEXT NOT NULL,
  run_id TEXT,
  bucket TEXT,
  reserved_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS budgets (
  day TEXT NOT NULL,
  bucket TEXT NOT NULL,
  spent_cents INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, bucket)
);

CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  cents INTEGER NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_webhooks (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  body TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS canaries (
  registry TEXT NOT NULL,
  ran_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS feed_updates (
  id TEXT PRIMARY KEY,
  registry TEXT NOT NULL,
  run_id TEXT,
  added_lines INTEGER,
  created_at TEXT NOT NULL
);
