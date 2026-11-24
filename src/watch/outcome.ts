/**
 * What a read of a watched record turns into: fields the two readers agree on, a stored copy of the page, and one
 * event. Creation, Monitor webhooks, re-checks and complaint runs all end here, so a failed check is recorded the
 * same way whichever of them made it.
 */

import type { Env } from '../env';
import type { Adapter } from '../registries/adapter';
import { getAdapter } from '../registries/index';
import { TinyFish, TinyFishError, type RunResult } from '../tinyfish/client';
import { agree, compareForWatch } from '../lookup/agree';
import type { Outcome } from '../queue/queue';
import { normaliseLicenceNumber, registries, type RegistryInfo } from '../registries/catalog';
import {
  getKey,
  getWatch,
  insertEvent,
  insertSnapshot,
  markWebhookSeen,
  updateWatchFields,
  wasWebhookSeen,
  type WatchRow,
} from '../store';
import type { Event, Fields, Reading, RegistryId, Snapshot } from '../types';
import { forwardEvent } from './forward';

/** Consecutive Monitor runs with errors before a watch gets the daily free re-read. */
export const FAIL_STREAK_LIMIT = 2;

/** What a reading comes to: the fields, or the note the check_failed event carries. */
export type Verdict = { fields: Fields } | { note: string };

type EventDraft = Omit<Event, 'event_id' | 'created_at' | 'watch_id'>;

export interface SnapshotDraft {
  watch_id: string;
  registry: RegistryId;
  url: string;
  reader_input: Snapshot['reader_input'];
  body: string;
  run_id: string | null;
  step_id: string | null;
}

export function adapterFor(registry: string): Adapter {
  return getAdapter(registry as RegistryId);
}

export function infoOf(registry: string): RegistryInfo {
  const info = registries.find((r) => r.id === registry);
  if (!info) throw new Error(`Unknown registry ${registry}`);
  return info;
}

export const LICENCE_MISMATCH = 'licence_number_mismatch';

export const isRun = (outcome: Outcome): outcome is RunResult => 'run_id' in outcome;

export const failNote = (reason: string): string => `check failed: ${reason}`;

/** A watch's own tier when it has one, else the registry's. */
export function effectiveTier(watch: WatchRow): 'monitor' | 'recheck' {
  if (watch.tier !== null) return watch.tier;
  return registries.find((r) => r.id === watch.registry)?.watch_tier ?? 'monitor';
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function storedFields(json: string | null): Fields | null {
  if (json === null) return null;
  // Fields stored before discipline_actions existed have no list; treat that as none. A discipline flag of null
  // is kept as it is: it means discipline has not been read yet, which is not the same as none on file.
  const parsed = JSON.parse(json) as Partial<Fields>;
  return {
    ...parsed,
    discipline_flag: parsed.discipline_flag ?? null,
    discipline_actions: Array.isArray(parsed.discipline_actions) ? parsed.discipline_actions : [],
  } as Fields;
}

export function pick(fields: Fields, keys: (keyof Fields)[]): Partial<Fields> {
  const out: Partial<Record<keyof Fields, unknown>> = {};
  for (const key of keys) out[key] = fields[key];
  return out as Partial<Fields>;
}

/** Leaves out the keys that have no value. The judgment, when a Monitor sent one, rides along as evidence.judgment. */
export function evidence(parts: {
  snapshot_id?: string;
  line?: string;
  note?: string | null;
  judgment?: unknown;
}): Event['evidence'] {
  const out: Record<string, unknown> = {};
  if (parts.snapshot_id !== undefined) out.snapshot_id = parts.snapshot_id;
  if (parts.line !== undefined) out.line = parts.line;
  if (parts.note) out.note = parts.note;
  if (parts.judgment !== undefined && parts.judgment !== null) out.judgment = parts.judgment;
  return out as Event['evidence'];
}

export async function writeEvent(db: D1Database, watch_id: string, draft: EventDraft, now: Date): Promise<Event> {
  const row = { watch_id, ...draft };
  const event_id = await insertEvent(db, row, now);
  return { event_id, created_at: now.toISOString(), ...row };
}

export async function saveSnapshot(db: D1Database, draft: SnapshotDraft, now: Date): Promise<string> {
  return insertSnapshot(db, {
    check_id: null,
    watch_id: draft.watch_id,
    registry: draft.registry,
    url: draft.url,
    reader_input: draft.reader_input,
    content_sha256: await sha256Hex(draft.body),
    body: draft.body,
    run_id: draft.run_id,
    step_id: draft.step_id,
    created_at: now.toISOString(),
  });
}

export function readersFor(adapter: Adapter, html: string): Reading[] {
  return [adapter.parseHtml(html), adapter.parseText(html)];
}

/**
 * A reading counts only when some reader finds a licence number, the readers agree, and the
 * licence number is the watch's own.
 */
export function judge(readings: Reading[], licence: string): Verdict {
  if (!readings.some((r) => r.fields.licence_number !== null)) {
    return { note: failNote('no licence number on the page') };
  }
  const agreement = agree(readings);
  if (!agreement.agree || agreement.fields === null) {
    const reasons = [...agreement.warnings, ...agreement.differences.map((d) => `differs: ${d.field}`)];
    return { note: failNote(`the readers do not agree (${reasons.join('; ')})`) };
  }
  const found =
    agreement.fields.licence_number === null ? null : normaliseLicenceNumber(agreement.fields.licence_number);
  if (found !== licence) return { note: LICENCE_MISMATCH };
  return { fields: agreement.fields };
}

export async function pageUrl(db: D1Database, adapter: Adapter, watch: WatchRow): Promise<string> {
  if (adapter.record.kind === 'agent') return adapter.record.start_url;
  if (watch.licence_number !== null) {
    const key = await getKey(db, adapter.id, watch.licence_number);
    if (key?.link_json) return adapter.record.url(JSON.parse(key.link_json) as Record<string, string>);
  }
  return adapter.info.url;
}

export async function publish(events: Event[], caller_webhook: string | null): Promise<void> {
  for (const event of events) await forwardEvent(event, caller_webhook);
}

export async function deleteMonitorIfPresent(client: TinyFish, monitor_id: string): Promise<void> {
  try {
    await client.deleteMonitor(monitor_id);
  } catch (err) {
    // A monitor that is already gone is what the caller wanted.
    if (err instanceof TinyFishError && err.code === 'not_found') return;
    throw err;
  }
}

/** Run ids are claimed once, so a repeated webhook for the same run is a duplicate. */
export async function claimRun(db: D1Database, run_id: string): Promise<boolean> {
  if (await wasWebhookSeen(db, run_id)) return false;
  return markWebhookSeen(db, run_id);
}

/**
 * A page that says nothing about discipline leaves what is stored about it alone. A register that keeps
 * complaints behind a second run always reads this way, so its complaint runs own these two fields. Until one of
 * them has read the view the flag stays null: not read is never stored as none.
 */
function keepDiscipline(previous: Fields | null, fields: Fields): Fields {
  if (fields.discipline_flag !== null) return fields;
  return {
    ...fields,
    discipline_flag: previous?.discipline_flag ?? null,
    discipline_actions: previous?.discipline_actions ?? [],
  };
}

/** Writes the snapshot, then the event for this check. A failed check never changes stored fields. */
export async function recordOutcome(
  db: D1Database,
  watch: WatchRow,
  verdict: Verdict,
  snapshot: SnapshotDraft | null,
  now: Date,
  judgment?: unknown,
): Promise<Event[]> {
  const snapshot_id = snapshot === null ? undefined : await saveSnapshot(db, snapshot, now);

  if ('note' in verdict) {
    return [await raiseFailure(db, watch, verdict.note, snapshot_id, judgment, now)];
  }

  const previous = storedFields(watch.last_fields_json);
  const next = keepDiscipline(previous, verdict.fields);
  await updateWatchFields(db, watch.watch_id, next);
  if (previous === null) return [];

  const cmp = compareForWatch(previous, next);
  if (cmp.changed) {
    const keys = cmp.changes.map((c) => c.field);
    if (keys.includes('status')) keys.push('status_raw');
    return [
      await writeEvent(
        db,
        watch.watch_id,
        {
          kind: 'status_change',
          before: pick(previous, keys),
          after: pick(next, keys),
          evidence: evidence({ snapshot_id, note: cmp.note, judgment }),
        },
        now,
      ),
    ];
  }
  // Nothing that counts changed. The run still leaves a trace, so the history shows the watch is being read.
  // The note names what moved without counting, when something did; the Monitor's judgment rides along.
  return [
    await writeEvent(
      db,
      watch.watch_id,
      {
        kind: 'unchanged',
        before: null,
        after: null,
        evidence: evidence({ snapshot_id, note: cmp.note, judgment }),
      },
      now,
    ),
  ];
}

export async function raiseFailure(
  db: D1Database,
  watch: WatchRow,
  note: string,
  snapshot_id: string | undefined,
  judgment: unknown,
  now: Date,
): Promise<Event> {
  return writeEvent(
    db,
    watch.watch_id,
    { kind: 'check_failed', before: null, after: null, evidence: evidence({ snapshot_id, note, judgment }) },
    now,
  );
}

export async function failCheck(env: Env, db: D1Database, watch: WatchRow, note: string, now: Date): Promise<void> {
  const event = await raiseFailure(db, watch, note, undefined, undefined, now);
  await publish([event], watch.caller_webhook);
}

export async function failById(env: Env, db: D1Database, watch_id: string, note: string): Promise<void> {
  const watch = await getWatch(db, watch_id);
  if (!watch || watch.deleted_at !== null) return;
  await failCheck(env, db, watch, note, new Date());
}
