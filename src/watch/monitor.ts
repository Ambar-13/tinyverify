/** A TinyFish Monitor's webhook: the page it fetched is read by both parsers, and the Monitor's own judgment never decides. */

import type { Env } from '../env';
import { TinyFish } from '../tinyfish/client';
import {
  bumpFailStreak,
  findWatchByMonitor,
  resetFailStreak,
  setWatchTier,
  unmarkWebhookSeen,
  type WatchRow,
} from '../store';
import type { RegistryId } from '../types';
import {
  type Verdict,
  type SnapshotDraft,
  adapterFor,
  failNote,
  readersFor,
  judge,
  pageUrl,
  publish,
  claimRun,
  recordOutcome,
  FAIL_STREAK_LIMIT,
} from './outcome';

interface MonitorBody {
  fetch_monitor_id: string;
  id: string;
  text: string | null;
  errors: unknown[];
  judgment: unknown;
}

function parseMonitorBody(body: unknown): MonitorBody | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.fetch_monitor_id !== 'string' || typeof b.id !== 'string') return null;
  const results = Array.isArray(b.results) ? b.results : [];
  const first = results[0] as { text?: unknown } | null | undefined;
  return {
    fetch_monitor_id: b.fetch_monitor_id,
    id: b.id,
    text: typeof first?.text === 'string' ? first.text : null,
    errors: Array.isArray(b.errors) ? b.errors : [],
    judgment: b.judgment,
  };
}

/**
 * 'ignored' is a body that is not a monitor run or names no watch; 'duplicate' is a run already handled; 'failed' is a
 * run whose page could not be read, so a check_failed event was written instead of a comparison.
 * When processing throws, the run is released so a retry is handled.
 */
export async function onMonitorWebhook(
  env: Env,
  db: D1Database,
  client: TinyFish,
  body: unknown,
): Promise<'ignored' | 'duplicate' | 'processed' | 'failed'> {
  // An ignored webhook is logged with its reason and never its body, which anyone with the URL could fill.
  const parsed = parseMonitorBody(body);
  if (parsed === null) {
    console.warn('Monitor webhook ignored: the body is not a monitor run');
    return 'ignored';
  }
  const watch = await findWatchByMonitor(db, parsed.fetch_monitor_id);
  if (watch === null) {
    console.warn('Monitor webhook ignored: no watch has that monitor id');
    return 'ignored';
  }
  if (!(await claimRun(db, parsed.id))) return 'duplicate';

  try {
    return (await processMonitorRun(env, db, client, watch, parsed)) ? 'failed' : 'processed';
  } catch (err) {
    await unmarkWebhookSeen(db, parsed.id);
    throw err;
  }
}

/** True when the run ended as a failed check (a check_failed event) and not as a comparison. */
async function processMonitorRun(
  env: Env,
  db: D1Database,
  client: TinyFish,
  watch: WatchRow,
  body: MonitorBody,
): Promise<boolean> {
  const now = new Date();
  const adapter = adapterFor(watch.registry);
  const licence = watch.licence_number ?? '';
  let verdict: Verdict;
  if (body.errors.length > 0) {
    // Only errors count toward the streak. A maintenance or layout page is a failed check, not an error.
    verdict = { note: failNote('the monitor reported errors') };
    const streak = await bumpFailStreak(db, watch.watch_id);
    if (streak >= FAIL_STREAK_LIMIT) await setWatchTier(db, watch.watch_id, 'recheck');
  } else if (body.text === null) {
    verdict = { note: failNote('the monitor returned no page') };
  } else {
    verdict = judge(readersFor(adapter, body.text), licence);
  }
  if ('fields' in verdict) await resetFailStreak(db, watch.watch_id);

  const snapshot: SnapshotDraft | null =
    body.text === null
      ? null
      : {
          watch_id: watch.watch_id,
          registry: watch.registry as RegistryId,
          url: await pageUrl(db, adapter, watch),
          reader_input: 'monitor_html',
          body: body.text,
          run_id: body.id,
          step_id: null,
        };
  const events = await recordOutcome(db, watch, verdict, snapshot, now, body.judgment);
  await publish(events, watch.caller_webhook);
  return 'note' in verdict;
}
