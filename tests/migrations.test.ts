import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const db = env.DB;
const all = env.TEST_MIGRATIONS;

const EXPECTED_INDEXES: Record<string, string[]> = {
  idx_queue_state_priority_created: ['state', 'priority', 'created_at'],
  idx_queue_run_id: ['run_id'],
  idx_checks_cache_key_created: ['cache_key', 'created_at'],
  idx_watches_monitor_id: ['monitor_id'],
  idx_snapshots_watch_id: ['watch_id'],
  idx_snapshots_check_id: ['check_id'],
  idx_events_watch_created: ['watch_id', 'created_at'],
};

async function ourIndexes(): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

async function columnsOf(index: string): Promise<string[]> {
  const { results } = await db.prepare(`PRAGMA index_info(${index})`).all<{ seqno: number; name: string }>();
  return results.sort((a, b) => a.seqno - b.seqno).map((r) => r.name);
}

async function planFor(sql: string, ...binds: unknown[]): Promise<string> {
  const { results } = await db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...binds)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join(' | ');
}

describe('migration 0008 indexes', () => {
  it("is followed only by the table of visitors' keys", () => {
    expect(all.map((m) => m.name)).toEqual([
      '0001_init.sql',
      '0002_seen_runs.sql',
      '0003_queue_retry.sql',
      '0004_watch_owner.sql',
      '0005_watch_tier.sql',
      '0006_watch_recheck.sql',
      '0007_watch_complaints.sql',
      '0008_indexes.sql',
      '0009_own_keys.sql',
    ]);
  });

  it('applies after 0001 to 0007 on an empty database, and creates the seven indexes on the right columns', async () => {
    // Start from an empty database: no tables, no record of applied migrations.
    const { results: tables } = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      )
      .all<{ name: string }>();
    await db.batch(tables.map((t) => db.prepare(`DROP TABLE IF EXISTS ${t.name}`)));
    expect(await ourIndexes()).toEqual([]);

    await applyD1Migrations(db, all.slice(0, 7));
    expect(await ourIndexes()).toEqual([]);

    await applyD1Migrations(db, all);
    expect(await ourIndexes()).toEqual(Object.keys(EXPECTED_INDEXES).sort());
    for (const [index, columns] of Object.entries(EXPECTED_INDEXES)) {
      expect(await columnsOf(index), index).toEqual(columns);
    }
  });

  it('applies again without error, and keeps one copy of each index', async () => {
    await expect(applyD1Migrations(db, all)).resolves.toBeUndefined();
    await db.exec(all[7].queries.join('\n'));
    expect(await ourIndexes()).toEqual(Object.keys(EXPECTED_INDEXES).sort());
  });

  it('is used by the hot queries', async () => {
    expect(
      await planFor(
        "SELECT * FROM queue WHERE state = 'pending' AND (not_before IS NULL OR not_before <= ?) ORDER BY priority ASC, created_at ASC LIMIT 10",
        'x',
      ),
    ).toContain('idx_queue_state_priority_created');
    expect(await planFor('SELECT * FROM queue WHERE run_id = ? LIMIT 1', 'run_1')).toContain('idx_queue_run_id');
    expect(
      await planFor(
        'SELECT * FROM checks WHERE cache_key = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1',
        'k',
        'x',
      ),
    ).toContain('idx_checks_cache_key_created');
    expect(await planFor('SELECT * FROM watches WHERE monitor_id = ? AND deleted_at IS NULL', 'mon_1')).toContain(
      'idx_watches_monitor_id',
    );
    expect(await planFor('SELECT * FROM snapshots WHERE watch_id = ?', 'w_1')).toContain('idx_snapshots_watch_id');
    expect(await planFor('SELECT * FROM snapshots WHERE check_id = ?', 'chk_1')).toContain('idx_snapshots_check_id');
    expect(await planFor('SELECT * FROM events WHERE watch_id = ? ORDER BY created_at DESC', 'w_1')).toContain(
      'idx_events_watch_created',
    );
  });
});
