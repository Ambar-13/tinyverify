/**
 * Canaries prove, every day, that each registry still reads correctly. A known public record is read live, both
 * parsers and the agreement check run on it, and the result is compared with values a person checked. A registry
 * whose latest canary failed is reported as degraded.
 */

import type { Env } from '../env';
import golden from '../golden.json';
import { lastCapture, readLatestHtml, TinyFish, TinyFishError, type RunResult } from '../tinyfish/client';
import { agree } from '../lookup/agree';
import { limitedRun } from '../queue/budget';
import { registries } from '../registries/catalog';
import { enqueue, registerContinuation } from '../queue/queue';
import { insertCanary, latestCanaries } from '../store';
import type { Fields, Reading, RegistryId } from '../types';
import { tryGetAdapter } from '../registries';
import type { Adapter } from '../registries/adapter';

/** The values a canary checks against. status_raw is the registry's own wording, which decides the status. */
type Expected = Pick<Fields, 'status' | 'status_raw' | 'licence_number' | 'expires'> & { status_raw: string };

interface GoldenRecord {
  registry: RegistryId;
  licence_number: string;
  link: string | null;
  expected?: Expected;
  pending?: boolean;
  note?: string;
}

interface GoldenFile {
  _note: string;
  records: GoldenRecord[];
}

const GOLDEN = golden as unknown as GoldenFile;

export type Health = 'ok' | 'degraded' | 'unknown';

/** A canary older than this no longer says anything about today, so health reports unknown. */
const STALE_MS = 48 * 3_600_000;

interface Verdict {
  ok: boolean;
  detail: string | null;
}

/** A registry's golden records that are ready to check. Pending records wait for a person to fill them in. */
function readyRecords(registry: RegistryId): GoldenRecord[] {
  return GOLDEN.records.filter((r) => r.registry === registry && r.pending !== true);
}

/**
 * Compares readings with the golden values. The registry's wording (status_raw) comes first: when
 * every reader reads the expected wording, the status is taken from that wording, so a status of
 * other (the catch-all for an unmapped wording) never fails the canary. On a failure the detail
 * lists the reader warnings first, so a missing label is named, then the wording, the disagreements
 * and the values that differ from the golden record.
 */
function judge(readings: Reading[], expected: Expected): Verdict {
  const result = agree(readings);
  const problems: string[] = [];
  let failed = false;
  const fail = (text: string): void => {
    failed = true;
    problems.push(text);
  };

  for (const r of readings) {
    for (const warning of r.warnings) problems.push(`${r.reader}: ${warning}`);
  }

  const wordingAgrees = readings.every((r) => r.fields.status_raw === expected.status_raw);
  if (!wordingAgrees) {
    for (const r of readings) {
      if (r.fields.status_raw !== expected.status_raw) {
        fail(
          `${r.reader} status_raw is ${JSON.stringify(r.fields.status_raw)}, expected ${JSON.stringify(expected.status_raw)}`,
        );
      }
    }
  }

  for (const d of result.differences) {
    // A disagreement on status is ignored only when the wording agrees and one reader says other.
    if (d.field === 'status' && wordingAgrees && Object.values(d.values).includes('other')) continue;
    const values = Object.entries(d.values)
      .map(([reader, value]) => `${reader} ${JSON.stringify(value)}`)
      .join(', ');
    fail(`${d.field} differs between readers (${values})`);
  }
  for (const w of result.warnings) fail(w);

  // Values are compared once, using the first reader's reading.
  const primary = readings[0].fields;
  if (primary.licence_number !== expected.licence_number) {
    fail(
      `licence_number is ${JSON.stringify(primary.licence_number)}, expected ${JSON.stringify(expected.licence_number)}`,
    );
  }
  if (primary.expires !== expected.expires) {
    fail(`expires is ${JSON.stringify(primary.expires)}, expected ${JSON.stringify(expected.expires)}`);
  }
  const statusMatches = primary.status === expected.status || (wordingAgrees && primary.status === 'other');
  if (!statusMatches) {
    fail(`status is ${JSON.stringify(primary.status)}, expected ${JSON.stringify(expected.status)}`);
  }

  if (!failed) return { ok: true, detail: null };
  return { ok: false, detail: problems.join('; ') };
}

/** Fetch registries: read each ready golden record now and combine the results into one canary row. */
async function checkFetched(client: TinyFish, registry: RegistryId, adapter: Adapter): Promise<Verdict | null> {
  const records = readyRecords(registry);
  if (records.length === 0) return null;

  const verdicts: string[] = [];
  let allOk = true;
  for (const record of records) {
    const expected = record.expected ?? null;
    const verdict = await checkOneFetched(client, adapter, record, expected);
    if (!verdict.ok) {
      allOk = false;
      verdicts.push(`${record.licence_number}: ${verdict.detail}`);
    }
  }
  return { ok: allOk, detail: allOk ? null : verdicts.join(' | ') };
}

async function checkOneFetched(
  client: TinyFish,
  adapter: Adapter,
  record: GoldenRecord,
  expected: Expected | null,
): Promise<Verdict> {
  if (expected === null) return { ok: false, detail: 'golden record has no expected values' };
  if (record.link === null) return { ok: false, detail: 'golden record has no link' };

  let html: string;
  try {
    const { results, errors } = await client.fetchPages([record.link], { format: 'html', ttl: 0 });
    if (errors.length > 0 || results.length === 0) {
      return { ok: false, detail: `fetch failed: ${errors[0]?.code ?? 'no result'}` };
    }
    html = results[0].text;
  } catch (err) {
    // Only a TinyFish error is a canary result. Anything else is a bug, so it is rethrown.
    if (!(err instanceof TinyFishError)) throw err;
    return { ok: false, detail: `fetch failed: ${err.code}` };
  }

  return judge([adapter.parseHtml(html), adapter.parseText(html)], expected);
}

/** Agent registries: queue one canary run for the first ready golden record. Only even UTC days. */
async function queueAgentCanary(env: Env, db: D1Database, registry: RegistryId, adapter: Adapter): Promise<void> {
  if (adapter.record.kind !== 'agent') return;
  const [record] = readyRecords(registry);
  if (!record) return;

  const { start_url, goal, output_schema, max_steps } = adapter.record;
  const limited = limitedRun(
    { url: start_url, goal: goal(record.licence_number), output_schema, capture_config: { html: true } },
    max_steps,
    env.AGENT_STEP_CAP,
  );
  await enqueue(db, {
    kind: 'canary',
    priority: 2,
    bucket: 'ops',
    reserved_cents: limited.reserved_cents,
    payload: { registry, request: limited.request },
  });
}

/**
 * Runs the daily canaries. Fetch registries are read now. Agent registries get a queued run on even
 * UTC days only, to halve their agent cost. A registry with no adapter gets no row, so its health is unknown.
 */
export async function runAll(env: Env, db: D1Database, client: TinyFish, now: Date = new Date()): Promise<void> {
  for (const info of registries) {
    const adapter = tryGetAdapter(info.id);
    if (!adapter) continue;

    if (info.read_route === 'fetch') {
      const verdict = await checkFetched(client, info.id, adapter);
      if (verdict) await insertCanary(db, info.id, verdict.ok, verdict.detail, now);
    } else if (now.getUTCDate() % 2 === 0) {
      await queueAgentCanary(env, db, info.id, adapter);
    }
  }
}

/** Reads a finished canary run: the captured page through both parsers, plus the agent's own output. */
export async function onRun(
  _env: Env,
  db: D1Database,
  client: TinyFish,
  registry: RegistryId,
  run: RunResult,
): Promise<void> {
  const adapter = tryGetAdapter(registry);
  const [record] = readyRecords(registry);
  if (!adapter || !record) return;
  const expected = record.expected ?? null;
  if (expected === null) {
    await insertCanary(db, registry, false, 'golden record has no expected values');
    return;
  }

  if (run.status !== 'COMPLETED') {
    const reason = run.error ? `${run.status} (${run.error.code})` : run.status;
    await insertCanary(db, registry, false, `agent run ended ${reason}`);
    return;
  }

  const last = lastCapture(run.steps, 'html');
  if (!last) {
    await insertCanary(db, registry, false, 'agent run captured no step');
    return;
  }

  const found = await readLatestHtml(client, run.run_id, run.steps);
  if (!found) {
    await insertCanary(db, registry, false, 'step html could not be read');
    return;
  }
  const html = found.html;

  const readings = [adapter.parseHtml(html), adapter.parseText(html), adapter.fieldsFromAgent(run.result)];
  const verdict = judge(readings, expected);
  await insertCanary(db, registry, verdict.ok, verdict.detail);
}

/**
 * The newest canary per registry decides its health. A registry with no canary, or whose newest
 * canary is more than 48 hours old, is unknown.
 */
export async function health(db: D1Database, now: Date = new Date()): Promise<Record<RegistryId, Health>> {
  const latest = new Map((await latestCanaries(db)).map((c) => [c.registry, c]));
  const out = {} as Record<RegistryId, Health>;
  for (const info of registries) {
    const row = latest.get(info.id);
    const stale = row !== undefined && Date.parse(row.ran_at) < now.getTime() - STALE_MS;
    out[info.id] = row === undefined || stale ? 'unknown' : row.ok ? 'ok' : 'degraded';
  }
  return out;
}

// A canary job that never produced a run. A budget refusal is not a registry failure, so it writes no row.
// A timeout counts as a failed canary: the agent could not read the record in time. A refused start counts too.
registerContinuation('canary', async (env, db, client, job, outcome) => {
  if (job.payload.registry === 'generic') return;
  if ('status' in outcome) {
    await onRun(env, db, client, job.payload.registry, outcome);
    return;
  }
  if (outcome.reason === 'timeout') {
    await insertCanary(db, job.payload.registry, false, 'canary run did not finish: timeout');
  }
  // TinyFish refused the canary's own request, so the registry was never read. The row makes /status show it as
  // failing.
  if (outcome.reason === 'start_refused') {
    await insertCanary(db, job.payload.registry, false, 'start_refused');
  }
});
