/**
 * The weekly complaint run, for a register that keeps complaints behind a second agent run. It owns the two
 * discipline fields of a watch and nothing else.
 */

import type { Env } from '../env';
import { tryGetAdapter } from '../registries/index';
import { readHtmlWhere, TinyFish, type RunResult } from '../tinyfish/client';
import { compareForWatch } from '../lookup/agree';
import { limitedRun } from '../queue/budget';
import { COMPLAINT_NOT_TIED, readComplaintPage, tiedToLicence } from '../lookup/complaint-page';
import { lineOnPage } from '../text';
import { registerContinuation, type Job } from '../queue/queue';
import { getWatch, updateWatchFields, type WatchRow } from '../store';
import type { Event, Fields, RegistryId } from '../types';
import {
  infoOf,
  isRun,
  failNote,
  storedFields,
  pick,
  evidence,
  writeEvent,
  saveSnapshot,
  publish,
  raiseFailure,
  failById,
} from './outcome';

const COMPLAINTS_STEPS = 20;

export interface Complaint {
  case_number: string;
  status: string;
  date: string;
}

/** Fields with no value, for a watch that has no stored fields yet. */
function blankFields(licence_number: string): Fields {
  return {
    name: null,
    licence_number,
    status_raw: null,
    status: null,
    expires: null,
    issued: null,
    licence_type: null,
    discipline_flag: null,
    discipline_actions: [],
    data_as_of: null,
    city: null,
    other_names: [],
  };
}

const QUOTE_UNVERIFIED = 'complaint_quote_unverified';

const FIRST_COMPLAINT_READ = 'first complaint read: what was already on file, not a change';

const AGENT_ANSWER_DIFFERS = 'agent_answer_differs';

/** Notes joined into one sentence list, leaving out the ones that are empty. */
function joinNotes(...notes: (string | null | undefined)[]): string | null {
  const kept = notes.filter((n): n is string => typeof n === 'string' && n !== '');
  return kept.length === 0 ? null : kept.join('. ');
}

/**
 * The weekly complaint comparison. It owns discipline_actions and discipline_flag only, so a
 * quiet week raises nothing. Every other stored field is carried over unchanged.
 */
export async function onComplaintsRun(
  env: Env,
  db: D1Database,
  client: TinyFish,
  watch_id: string,
  run: RunResult,
): Promise<void> {
  const watch = await getWatch(db, watch_id);
  if (!watch || watch.deleted_at !== null || watch.licence_number === null) return;
  const now = new Date();

  const complaintLine = (c: Complaint): string => `${c.case_number} ${c.status} ${c.date}`.trim();
  const previous = storedFields(watch.last_fields_json);

  // The complaint view is the newest of the last 4 snapshots that both readers take for it: the agent may have
  // clicked away after reading. When there is none, the page the run ended on is kept as the snapshot, or the
  // run's own JSON result when no page could be captured, and the event for this run says so.
  const adapter = tryGetAdapter(watch.registry as RegistryId);
  const step = await readHtmlWhere(
    client,
    run.run_id,
    run.steps,
    (candidate) => readComplaintPage(adapter, candidate) !== null,
  );
  if (!step) console.warn(`Complaint page not captured for watch ${watch_id}`);
  // A view that both readers accept but that the run does not tie to this licence may be another record's:
  // nothing from it is kept.
  const untied =
    step?.accepted === true &&
    !(await tiedToLicence(client, run.run_id, run.steps, step, adapter, watch.licence_number));
  const kept = untied ? null : step;
  const html: string | null = kept?.html ?? null;
  const notCaptured = html === null ? 'page not captured; the snapshot holds the run result' : null;
  const snapshot_id = await saveSnapshot(
    db,
    {
      watch_id,
      registry: watch.registry as RegistryId,
      url: infoOf(watch.registry).url,
      reader_input: 'agent_html',
      body: html ?? JSON.stringify(run.result ?? null),
      run_id: run.run_id,
      step_id: kept?.step_id ?? null,
    },
    now,
  );

  // The captured page decides, and the run's answer only adds a note. When no page is accepted by both
  // readers, or they disagree, the stored fields stay as they were.
  const refuse = async (reason: string): Promise<void> => {
    const note = failNote(`${reason} (complaints_not_checked)`);
    const event = await raiseFailure(db, watch, joinNotes(note, notCaptured) ?? note, snapshot_id, undefined, now);
    await publish([event], watch.caller_webhook);
  };
  if (untied) return refuse(COMPLAINT_NOT_TIED);
  const read = kept?.accepted ? readComplaintPage(adapter, kept.html) : null;
  if (read === null) return refuse('complaint page not captured');
  if (!read.agree) return refuse('the two readers of the complaint page disagree (complaint_readers_disagree)');
  const actions = read.rows.map(complaintLine);
  const view = (run.result ?? {}) as { complaints?: unknown; complaint_view_opened?: unknown; evidence_line?: unknown };
  const differs =
    view.complaint_view_opened !== true || !Array.isArray(view.complaints) || view.complaints.length !== actions.length;
  const next: Fields = {
    ...(previous ?? blankFields(watch.licence_number)),
    discipline_flag: actions.length > 0,
    discipline_actions: actions,
  };
  // The evidence line is kept only when it appears on the captured page. Otherwise it is dropped and the event says so.
  const claimed = typeof view.evidence_line === 'string' ? view.evidence_line.trim() : '';
  const line = lineOnPage(claimed, html) ? claimed : '';
  const unverified = claimed !== '' && line === '' ? QUOTE_UNVERIFIED : null;
  const firstRead = previous !== null && previous.discipline_flag === null ? FIRST_COMPLAINT_READ : null;
  const notes = [firstRead, differs ? AGENT_ANSWER_DIFFERS : null, unverified];

  await updateWatchFields(db, watch_id, next);
  if (previous === null) return;

  const cmp = compareForWatch(previous, next);
  let events: Event[];
  if (cmp.changed) {
    events = [
      await writeEvent(
        db,
        watch_id,
        {
          kind: 'status_change',
          before: pick(previous, ['discipline_flag', 'discipline_actions']),
          after: pick(next, ['discipline_flag', 'discipline_actions']),
          evidence: evidence({
            snapshot_id,
            line: line === '' ? undefined : line,
            note: joinNotes(cmp.note, notCaptured, ...notes),
          }),
        },
        now,
      ),
    ];
  } else {
    events = [
      await writeEvent(
        db,
        watch_id,
        {
          kind: 'unchanged',
          before: null,
          after: null,
          evidence: evidence({ snapshot_id, note: joinNotes(cmp.note, notCaptured, ...notes) }),
        },
        now,
      ),
    ];
  }
  await publish(events, watch.caller_webhook);
}

/** True for a register that keeps complaints behind a second agent run. Only such a register gets complaint runs. */
export function hasComplaintRun(registry: string): boolean {
  return tryGetAdapter(registry as RegistryId)?.discipline.kind === 'agent_second_run';
}

/**
 * A watch's complaint run, built from its adapter's own discipline goal and schema. Null, with the reason
 * logged, when the watch has no stored record link to open.
 */
export function complaintsJob(
  env: Env,
  watch: WatchRow,
  key: { link_json: string | null } | undefined,
): Omit<Job, 'job_id'> | null {
  const adapter = tryGetAdapter(watch.registry as RegistryId);
  if (!adapter || !key?.link_json || adapter.record.kind !== 'link') {
    console.warn(`No record link for watch ${watch.watch_id}; complaints not checked`);
    return null;
  }
  const discipline = adapter.discipline;
  if (discipline.kind !== 'agent_second_run') {
    console.warn(`The ${watch.registry} adapter has no complaint run; complaints not checked`);
    return null;
  }
  const link = JSON.parse(key.link_json) as Record<string, string>;
  const limited = limitedRun(
    {
      url: adapter.record.url(link),
      goal: discipline.goal(link),
      output_schema: discipline.output_schema,
      capture_config: { html: true, screenshots: true },
    },
    COMPLAINTS_STEPS,
    env.AGENT_STEP_CAP,
  );
  return {
    kind: 'recheck_complaints',
    priority: 3,
    bucket: 'ops',
    reserved_cents: limited.reserved_cents,
    payload: { watch_id: watch.watch_id, registry: watch.registry as RegistryId, request: limited.request },
  };
}

registerContinuation('recheck_complaints', async (env, db, client, job, outcome) => {
  const watch_id = job.payload.watch_id;
  if (watch_id === undefined) return;
  if (!isRun(outcome)) {
    await failById(env, db, watch_id, failNote(`the complaint check did not run (${outcome.reason})`));
    return;
  }
  if (outcome.status !== 'COMPLETED') {
    await failById(env, db, watch_id, failNote(`the complaint check ended ${outcome.status}`));
    return;
  }
  await onComplaintsRun(env, db, client, watch_id, outcome);
});
