-- A visitor's own TinyFish key, held encrypted while their one lookup runs and deleted when it ends.
CREATE TABLE IF NOT EXISTS own_keys (
  check_id TEXT PRIMARY KEY,
  sealed TEXT NOT NULL,
  created_at TEXT NOT NULL
);
