/**
 * The licence lookup. startCheck validates a request, serves a recent identical lookup from the cache, and otherwise
 * reads the registry through its adapter: by fetching a page, or by a queued agent run where the registry needs one.
 * continueCheck resumes the check when the queue reports a finished run, and refine reads the record of one candidate
 * picked from a multiple_matches result.
 */

import type { Env } from '../env';
import { getAdapter, tryGetAdapter } from '../registries';
import type { Adapter, SearchRow as Row } from '../registries/adapter';
import {
  isSnapshotRequest,
  judgeSearchAnswer,
  linkFinderRows,
  pageFailure,
  pageOf,
  searchRequest,
} from './search-page';
import {
  readHtmlWhere,
  readLatestHtml,
  TinyFishError,
  type FetchResult,
  type RunResult,
  type TinyFish,
} from '../tinyfish/client';
import { agree, expiryWarning } from './agree';
import { canStart, limitedRun, type Bucket } from '../queue/budget';
import { decide, disambiguatorsFor, normaliseName, scoreCandidate } from './match';
import {
  enqueue,
  QueueFull,
  registerContinuation,
  type Job,
  type JobKind,
  type Outcome as JobOutcome,
} from '../queue/queue';
import {
  normaliseLicenceNumber,
  normaliseRecordType,
  parseJurisdiction,
  formatCheck,
  registries,
  routesFor,
  type RegistryInfo,
} from '../registries/catalog';
import { COMPLAINT_NOT_TIED, readComplaintPage, tiedToLicence } from './complaint-page';
import { screenshotUrl, storeSnapshot } from './evidence';
import {
  GENERIC_MAX_STEPS,
  GENERIC_OUTPUT_SCHEMA,
  GENERIC_VERSION,
  genericGoal,
  groundRecord,
  holdsNumber,
  readAnswer,
  saysNoResults,
} from './generic';
import { findCachedCheck, getCheck, getKey, insertCheck, updateCheck, upsertKey, type CheckRow } from '../store';
import { lineOnPage } from '../text';
import { isOfficialHost, JURISDICTION_NAME, placeOf, searchWordings, type Place } from './places';
import { resolveWatchFromSearch } from '../watch/watch';
import type {
  Candidate,
  Fields,
  Jurisdiction,
  LicenceRecord,
  Outcome,
  RecordType,
  RegistryId,
  Reading,
  UnavailableReason,
  VerifyInput,
  VerifyResult,
} from '../types';

type Discipline = LicenceRecord['discipline'];
type Unsupported = NonNullable<VerifyResult['unsupported']>;
type Failure = { reason: UnavailableReason; message?: string; retry_after?: string; refused?: true };
type Query = {
  name?: string;
  licence_number?: string;
  type: RecordType;
  city?: string;
  alternate?: boolean;
  copy_rows?: boolean;
};

/**
 * Set on a result whose search rows were copied by the agent, because the results page could not be read from the run's
 * snapshot.
 */
const RESULTS_READ_BY_AGENT = 'results_read_by_agent';
type Unavailable = NonNullable<VerifyResult['unavailable']>;

const CACHE_SECONDS = 600;
const RETRY_AFTER_MS = 60_000;
const FETCH_GAP_MS = 1_000;
const MAX_CANDIDATES = 25;
/** The same plausibility floor match.ts uses for a candidate name. */
const PLAUSIBLE_NAME = 0.5;
const DISCIPLINE_STEPS = 20;
const SOMETHING_WRONG = 'Something went wrong';
/** Only these outcomes are served from cache. Unavailable and invalid results are never reused. */
const CACHEABLE = new Set<string>(['match', 'multiple_matches', 'no_match', 'needs_review', 'unsupported']);

/** The check row keeps the input and the bucket it was started with. */
const queryJson = (input: VerifyInput, bucket: Bucket): string => JSON.stringify({ input, bucket });
const US_NAME_A_STATE = 'Name a state, for example Florida or California';
const NO_ADAPTER_YET = 'No adapter for this place yet; the official registry link is included when found';
const NOT_CONNECTED = 'This registry is not connected yet';
/** Both complaint runs capture the page and a screenshot, so the proof of what the complaint view showed is kept. */
const COMPLAINT_CAPTURE = { html: true, screenshots: true };
const COMPLAINT_PAGE_NOT_CAPTURED = 'complaint page not captured';
const COMPLAINT_READERS_DISAGREE = 'the two readers of the complaint page disagree';
const START_REFUSED = 'The check could not be started. This is a fault in TinyVerify, not in the registry.';
const COMPLAINT_NOT_STARTED = 'The complaint check could not be started.';
const COMPLAINT_NOT_COMPLETED = 'The complaint check could not be completed.';
const WALLET_UNREADABLE = 'The service could not confirm it can pay for this check. Try again in a minute.';

const MESSAGES: Record<UnavailableReason, string> = {
  blocked: 'The registry blocked the request.',
  captcha: 'The registry asked for a captcha. Try again later.',
  maintenance: 'The registry is in maintenance.',
  timeout: 'The registry did not answer in time.',
  layout_changed: 'The registry page did not match what we expect.',
  login_required: 'The registry asked for a sign-in.',
  rate_limited: 'Too many checks are running. Try again shortly.',
  budget: 'The daily check budget is used up.',
};

/** Fetch errors that end a check; any other fetch error means the link gave no record. */
const FETCH_FAILURES = new Map<string, UnavailableReason>([
  ['bot_blocked', 'blocked'],
  ['login_required', 'login_required'],
  ['timeout', 'timeout'],
]);

/**
 * The registry a watch request names by record_type and jurisdiction, found the way a lookup is routed. Exactly
 * one connected registry is the answer; none is unsupported (as a lookup would say); more than one is a request
 * that must name the registry.
 */
export type WatchTarget =
  { ok: true; registry: RegistryInfo } | { ok: false; code: 'invalid_input' | 'unsupported'; message: string };

export function watchTargetFor(record_type: unknown, jurisdiction: unknown): WatchTarget {
  if (typeof record_type !== 'string' || typeof jurisdiction !== 'string') {
    return {
      ok: false,
      code: 'invalid_input',
      message: 'Name a registry this service knows, for example fl-mqa, or send record_type and jurisdiction',
    };
  }
  const type = normaliseRecordType(record_type);
  if (type === null) {
    return {
      ok: false,
      code: 'invalid_input',
      message:
        'record_type must be a physician, dentist, nurse, pharmacist, contractor or company, or a common name for one',
    };
  }
  const j = parseJurisdiction(jurisdiction);
  if (j === null && placeOf(jurisdiction) === null) {
    return { ok: false, code: 'invalid_input', message: 'jurisdiction must be a US state or code, or a country' };
  }
  const connected = j === null ? [] : routesFor(type, j).filter((r) => r.connected);
  if (connected.length === 1) return { ok: true, registry: connected[0] };
  if (connected.length === 0)
    return { ok: false, code: 'unsupported', message: 'No registry is connected for that record type and place yet' };
  return {
    ok: false,
    code: 'invalid_input',
    message: `More than one registry covers that. Send registry as one of: ${connected.map((r) => r.id).join(', ')}.`,
  };
}

function typedName(input: VerifyInput): string | null {
  const name = input.name?.trim();
  if (name) return name;
  const joined = [input.first_name, input.last_name]
    .map((p) => p?.trim() ?? '')
    .filter((p) => p !== '')
    .join(' ');
  return joined === '' ? null : joined;
}

interface Valid {
  ok: true;
  type: RecordType;
  jurisdiction: Jurisdiction | null;
  place: Place | null;
  route: RegistryInfo | null;
  name: string | null;
  licence: string | null;
}
interface Invalid {
  ok: false;
  field: string;
  expected: string;
}

const NAME_RE = /^[\p{L}\p{N} ,.'&-]{1,80}$/u;
const CITY_RE = /^[\p{L} .'-]{1,40}$/u;
const NAME_EXPECTED = "letters, numbers, spaces and , . ' & -, up to 80 characters";
const CITY_EXPECTED = "letters, spaces and . ' -, up to 40 characters";

function validate(input: VerifyInput): Valid | Invalid {
  const type = normaliseRecordType(input.record_type);
  if (type === null) {
    return {
      ok: false,
      field: 'record_type',
      expected: 'a physician, dentist, nurse, pharmacist, contractor or company, or a common name for one',
    };
  }
  // Text goes into registry search goals, so it is checked before any goal is built.
  for (const [field, value] of [
    ['name', input.name],
    ['first_name', input.first_name],
    ['last_name', input.last_name],
  ] as const) {
    const text = value?.trim();
    if (text && !NAME_RE.test(text)) return { ok: false, field, expected: NAME_EXPECTED };
  }
  const city = input.city?.trim();
  if (city && !CITY_RE.test(city)) return { ok: false, field: 'city', expected: CITY_EXPECTED };
  const name = typedName(input);
  const licence = input.licence_number?.trim() ? normaliseLicenceNumber(input.licence_number) : null;
  if (name === null && licence === null) return { ok: false, field: 'name', expected: 'a name or a licence number' };

  const j = parseJurisdiction(input.jurisdiction);
  if (j === null) {
    const place = placeOf(input.jurisdiction);
    if (place === null) return { ok: false, field: 'jurisdiction', expected: 'a US state or code, or a country' };
    return { ok: true, type, jurisdiction: null, place, route: null, name, licence };
  }
  const routes = routesFor(type, j);
  if (licence !== null) {
    for (const r of routes) {
      const message = formatCheck(r.id, licence);
      if (message !== null) return { ok: false, field: 'licence_number', expected: message };
    }
  }
  // A connected registry is preferred. A table row with no adapter still counts as a route, so the
  // caller hears "not connected yet" and gets the registry's own link.
  const route = routes.find((r) => r.connected) ?? routes[0] ?? null;
  return { ok: true, type, jurisdiction: j, place: null, route, name, licence };
}

/**
 * include_complaints only changes the answer where a separate agent run reads the complaints (DBPR).
 * Everywhere else the flag is left out of the key, so a repeat with the other value is the same lookup.
 */
function complaintsFlagMatters(v: Valid): boolean {
  return v.route !== null && tryGetAdapter(v.route.id)?.discipline.kind === 'agent_second_run';
}

function cacheKeyFor(input: VerifyInput, v: Valid): string {
  const city = input.city ? normaliseName(input.city).folded : '';
  return JSON.stringify({
    type: v.type,
    jurisdiction: v.jurisdiction ?? v.place?.name ?? '',
    name: v.name === null ? null : normaliseName(v.name).folded,
    licence_number: v.licence,
    city: city === '' ? null : city,
    include_complaints: complaintsFlagMatters(v) ? input.include_complaints !== false : true,
  });
}

/** Pacing: calls to one registry run one at a time, at least FETCH_GAP_MS apart, per isolate. */
const lastCallAt = new Map<string, number>();
const callChain = new Map<string, Promise<unknown>>();

function paced<T>(registry: string, call: () => Promise<T>): Promise<T> {
  const previous = callChain.get(registry) ?? Promise.resolve();
  const run = previous.then(async () => {
    const wait = (lastCallAt.get(registry) ?? 0) + FETCH_GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCallAt.set(registry, Date.now());
    return call();
  });
  callChain.set(
    registry,
    run.catch(() => undefined),
  );
  return run;
}

/** Shared state for one check. base is the stored result; ctx never mutates it. */
interface Ctx {
  env: Env;
  db: D1Database;
  client: TinyFish;
  check_id: string;
  bucket: Bucket;
  now: Date;
  input: VerifyInput;
  base: VerifyResult;
  type: RecordType;
  route: RegistryInfo;
  adapter: Adapter;
  /** The agent search run that found the record's address. Unset when the address came from the stored key map. */
  search_run_id?: string;
}

function makeCtx(
  env: Env,
  db: D1Database,
  client: TinyFish,
  check_id: string,
  input: VerifyInput,
  base: VerifyResult,
  bucket: Bucket,
  now: Date,
): Ctx {
  const type = normaliseRecordType(input.record_type);
  const route = registries.find((r) => r.id === base.searched.registries[0]);
  if (type === null || route === undefined) throw new Error(`check ${check_id} has no route`);
  return { env, db, client, check_id, bucket, now, input, base, type, route, adapter: getAdapter(route.id) };
}

function shape(
  check_id: string,
  query: VerifyInput,
  ids: RegistryId[],
  state: VerifyResult['state'],
  alternate = false,
  spellings: string[] = [],
): VerifyResult {
  return {
    check_id,
    state,
    query,
    outcome: null,
    checked_at: null,
    served_from_cache: false,
    records: [],
    candidates: [],
    disambiguators: [],
    candidates_total: 0,
    warnings: [],
    searched: { registries: ids, spellings_tried: spellings, alternate_spellings_used: alternate },
  };
}

function fresh(
  ctx: Ctx,
  state: VerifyResult['state'],
  alternate = ctx.base.searched.alternate_spellings_used,
): VerifyResult {
  return shape(ctx.check_id, ctx.input, [ctx.route.id], state, alternate, ctx.base.searched.spellings_tried);
}

function done(ctx: Ctx, patch: Partial<VerifyResult> & { outcome: Outcome }, alternate?: boolean): VerifyResult {
  // An unmapped registry wording is visible at the top level too, not only on the record.
  const unknownWording = (patch.records ?? []).some((r) => r.licence.status === 'other')
    ? ['status_unknown_wording']
    : [];
  const warnings = [...new Set([...(patch.warnings ?? []), ...unknownWording])];
  return { ...fresh(ctx, 'done', alternate), ...patch, warnings, state: 'done', checked_at: ctx.now.toISOString() };
}

function unavailableBlock(f: Failure): Unavailable {
  return {
    reason: f.reason,
    message: f.message ?? MESSAGES[f.reason],
    ...(f.retry_after !== undefined ? { retry_after: f.retry_after } : {}),
  };
}

function fail(ctx: Ctx, f: Failure): VerifyResult {
  return done(ctx, { outcome: 'source_unavailable', unavailable: unavailableBlock(f) });
}

function needsReview(ctx: Ctx, readings: Reading[]): VerifyResult {
  return done(ctx, { outcome: 'needs_review', readings });
}

/** Results that must not be served from the cache, though their outcome is a cacheable one. */
const uncached = new WeakSet<object>();
/**
 * No-match results whose captured page showed neither a results list nor a licence page: the registry's own "no
 * results".
 */
const confirmedNone = new WeakSet<object>();

async function save(db: D1Database, r: VerifyResult): Promise<VerifyResult> {
  await updateCheck(db, r.check_id, { state: r.state, result_json: JSON.stringify(r), uncache: uncached.has(r) });
  return r;
}

function servedFromCache(row: CheckRow, now: Date): VerifyResult {
  const stored = JSON.parse(row.result_json ?? 'null') as VerifyResult;
  const at = Date.parse(stored.checked_at ?? row.created_at);
  return {
    ...stored,
    served_from_cache: true,
    cache_age_seconds: Math.max(0, Math.floor((now.getTime() - at) / 1000)),
  };
}

function linkOf(json: string | null | undefined): Record<string, string> | null {
  if (!json) return null;
  const parsed = JSON.parse(json) as Record<string, string>;
  return Object.keys(parsed).length > 0 ? parsed : null;
}

function nextUtcMidnight(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

/** A run or a reason the job ended without one, as the queue reports it. */
type Settled = { run: RunResult } | { failure: Failure };

function isRun(o: JobOutcome): o is RunResult {
  return 'run_id' in o;
}

function mapRunError(run: RunResult, now: Date): Failure {
  const code = run.error?.code ?? '';
  const text = (run.error?.message ?? '').toLowerCase();
  if (code === 'BILLING_FAILURE') return { reason: 'budget', retry_after: nextUtcMidnight(now) };
  if (code === 'MAX_STEPS_EXCEEDED') return { reason: 'timeout', message: `Stopped after ${run.steps_used} steps.` };
  if (code === 'AGENT_FAILURE') {
    if (text.includes('captcha')) return { reason: 'captcha' };
    if (text.includes('blocked') || text.includes('access denied')) return { reason: 'blocked' };
    return { reason: 'layout_changed' };
  }
  return { reason: 'timeout' };
}

function settle(run: JobOutcome, now: Date): Settled {
  if (!isRun(run)) {
    // The queue could not start the run. The public reason stays timeout; the message says whose fault it is.
    if (run.reason === 'start_refused')
      return { failure: { reason: 'timeout', message: START_REFUSED, refused: true } };
    // A refusal from the queue may carry its own message and reset time; those reach the caller.
    const extra = run as { message?: unknown; resets_at?: unknown };
    const message = typeof extra.message === 'string' ? extra.message : undefined;
    if (run.reason !== 'budget') return { failure: { reason: 'timeout', message } };
    const resets = typeof extra.resets_at === 'string' ? extra.resets_at : nextUtcMidnight(now);
    return { failure: { reason: 'budget', message, retry_after: resets } };
  }
  if (run.status === 'COMPLETED') return { run };
  return { failure: mapRunError(run, now) };
}

function failureOfError(err: TinyFishError, now: Date): Failure {
  if (err.code === 'rate_limited') {
    return {
      reason: 'rate_limited',
      retry_after: new Date(now.getTime() + (err.retryAfterSeconds ?? 60) * 1000).toISOString(),
    };
  }
  return { reason: 'timeout' };
}

/** One paced fetch of a registry page. Returns the text, a fetch error code, or a failure for a call that threw. */
async function fetchHtml(ctx: Ctx, url: string): Promise<{ text: string } | { error: string } | { failure: Failure }> {
  try {
    const res = await paced(ctx.route.id, () => ctx.client.fetchPages([url], { format: 'html', ttl: 0 }));
    if (res.errors[0]) return { error: res.errors[0].code };
    const page: FetchResult | undefined = res.results[0];
    if (!page) return { error: 'no_page' };
    return { text: page.text };
  } catch (err) {
    if (err instanceof TinyFishError) return { failure: failureOfError(err, ctx.now) };
    throw err;
  }
}

function agreementWarnings(a: ReturnType<typeof agree>): string[] {
  return [...a.warnings, ...a.differences.map((d) => `differs:${d.field}`)];
}

function withWarnings(readings: Reading[], extra: string[]): Reading[] {
  return readings.map((r) => ({ ...r, warnings: [...r.warnings, ...extra] }));
}

const BUSINESS = /(^| )(llc|l l c|inc|incorporated|ltd|limited|corp|corporation|co|company|pty|plc|lp|llp|pc|pa)( |$)/;

interface BuildParts {
  fields: Fields;
  readings: Reading[];
  source_url: string;
  source_lookup: string | null;
  subject: Candidate | null;
  snapshot: { snapshot_id: string; content_sha256: string };
  screenshot_url: string | null;
  run_id: string | null;
  read_by: 'fetch' | 'agent';
  discipline: Discipline;
  warnings: string[];
}

function buildRecord(ctx: Ctx, p: BuildParts): LicenceRecord {
  const f = p.fields;
  const name = f.name ?? p.subject?.name ?? typedName(ctx.input) ?? '';
  const warnings = [...p.warnings];
  const expiry = expiryWarning(f, ctx.now);
  if (expiry !== null) warnings.push(expiry);
  if (f.status === null || f.status === 'other') warnings.push('status_unknown_wording');
  // A registry can add its own notes to a record both readers agreed on, such as a missing expiry.
  for (const w of ctx.adapter.recordWarnings?.(f) ?? []) if (!warnings.includes(w)) warnings.push(w);
  return {
    registry: { id: ctx.route.id, name: ctx.route.name, jurisdiction: ctx.route.jurisdiction },
    key: { licence_number: f.licence_number ?? '' },
    source_url: p.source_url,
    source_lookup: p.source_lookup,
    data_as_of: f.data_as_of,
    subject: {
      name,
      kind: BUSINESS.test(normaliseName(name).folded) ? 'business' : 'person',
      other_names: f.other_names,
      city: f.city ?? p.subject?.city ?? null,
    },
    licence: {
      type: f.licence_type,
      rank: null,
      status: f.status ?? 'other',
      status_raw: f.status_raw ?? '',
      issued: f.issued,
      expires: f.expires,
    },
    discipline: p.discipline,
    match: p.subject ? { score: p.subject.score, reasons: p.subject.reasons } : null,
    verification: { readers: p.readings.map((r) => r.reader), agree: true },
    evidence: {
      quotes: p.readings.flatMap((r) => r.quotes),
      snapshot_id: p.snapshot.snapshot_id,
      content_sha256: p.snapshot.content_sha256,
      screenshot_url: p.screenshot_url,
      tinyfish_run_id: p.run_id,
    },
    read_by: p.read_by,
    adapter_version: ctx.adapter.version,
    warnings,
  };
}

const notRequested = (): Discipline => ({
  checked: false,
  on_file: null,
  actions: [],
  read_by: null,
  reason: 'Complaints were not requested.',
});
const notReadHere = (): Discipline => ({
  checked: false,
  on_file: null,
  actions: [],
  read_by: null,
  reason: 'Complaints are not read on this path.',
});

/**
 * Discipline on the fetch path. A flag-then_fetch registry is read from its discipline page only when the flag is set.
 */
async function fetchDiscipline(
  ctx: Ctx,
  link: Record<string, string>,
  fields: Fields,
): Promise<{ discipline: Discipline; warnings: string[] }> {
  const plain = (discipline: Discipline) => ({ discipline, warnings: [] as string[] });
  const d = ctx.adapter.discipline;
  // include_complaints governs only the separate complaint run of an agent_second_run registry.
  // A discipline read from the record page or from its enforcement tab never depends on it.
  if (d.kind === 'agent_second_run') {
    return plain(ctx.input.include_complaints === false ? notRequested() : notReadHere());
  }
  if (d.kind === 'on_page') {
    return plain({
      checked: true,
      on_file: fields.discipline_flag,
      actions: fields.discipline_actions,
      read_by: 'fetch',
    });
  }
  // An adapter with an enforcement-tab parser: read the tab with both flags set, and merge its rows with the alert
  // lines.
  if (ctx.adapter.parseDisciplinePage !== undefined) {
    // The record says discipline exists, yet no action could be read: fail closed, never on_file false.
    const unparsed = {
      discipline: {
        checked: false,
        on_file: true,
        actions: [],
        read_by: 'fetch' as const,
        reason: 'actions page not parsed',
      },
      warnings: ['discipline_actions_unparsed'],
    };
    const tab = await fetchHtml(ctx, d.url(link, { hasDiscipline: true, hasPublicComplaint: true }));
    if (!('text' in tab)) {
      if (fields.discipline_flag === true && fields.discipline_actions.length === 0) return unparsed;
      return plain({
        checked: false,
        on_file: null,
        actions: fields.discipline_actions,
        read_by: null,
        reason: 'The discipline page did not load.',
      });
    }
    const parsed = ctx.adapter.parseDisciplinePage(tab.text);
    // null means the tab's sections were not found: that is not "no actions", so it is never counted as checked.
    if (parsed === null) {
      if (fields.discipline_flag === true) return unparsed;
      return plain({
        checked: false,
        on_file: null,
        actions: fields.discipline_actions,
        read_by: null,
        reason: 'actions page not parsed',
      });
    }
    const actions = [...new Set([...parsed, ...fields.discipline_actions])];
    if (actions.length === 0 && fields.discipline_flag === true) return unparsed;
    return plain({ checked: true, on_file: actions.length > 0, actions, read_by: 'fetch' });
  }
  if (fields.discipline_flag === null) {
    return plain({
      checked: false,
      on_file: null,
      actions: [],
      read_by: null,
      reason: 'The record page did not show a discipline flag.',
    });
  }
  if (fields.discipline_flag === false) return plain({ checked: true, on_file: false, actions: [], read_by: 'fetch' });
  const got = await fetchHtml(ctx, d.url(link, { hasDiscipline: true }));
  if (!('text' in got)) {
    return plain({
      checked: false,
      on_file: true,
      actions: [],
      read_by: null,
      reason: 'The discipline page did not load.',
    });
  }
  const actions = ctx.adapter.parseHtml(got.text).fields.discipline_actions;
  // Raw page lines are never stored as actions. An unparsed page is reported as such.
  if (actions.length === 0) {
    return {
      discipline: { checked: false, on_file: true, actions: [], read_by: 'fetch', reason: 'actions page not parsed' },
      warnings: ['discipline_actions_unparsed'],
    };
  }
  return plain({ checked: true, on_file: true, actions, read_by: 'fetch' });
}

/** A name given with a number must be plausibly the name on the record that was read. */
function nameMismatch(ctx: Ctx, fields: Fields): boolean {
  if (typedName(ctx.input) === null) return false;
  const nameOnly = scoreCandidate(
    { ...ctx.input, licence_number: undefined },
    {
      name: fields.name ?? '',
      licence_number: null,
      city: null,
      licence_type: null,
      status_raw: null,
      from: 'search',
      link: null,
    },
  );
  return nameOnly.score < PLAUSIBLE_NAME;
}

/** Starts the complaints run. When the run cannot start, the record is kept with complaints marked as not checked. */
async function startComplaints(
  ctx: Ctx,
  provisional: LicenceRecord,
  readings: Reading[],
  subject: Candidate | null,
  request: Job['payload']['request'],
): Promise<VerifyResult> {
  // The record is shown while the complaint run is in flight: state reading, no outcome, pending ["complaints"].
  // It is replaced by the final result when the run ends, and it is never served from the cache.
  const started = await enqueueJob(ctx, 'discipline', request, DISCIPLINE_STEPS, {
    ...fresh(ctx, 'reading'),
    records: [provisional],
    readings,
    candidates: subject ? [subject] : [],
    pending: ['complaints'],
  });
  if (started.state !== 'done') return started;
  const discipline: Discipline = {
    checked: false,
    on_file: null,
    actions: [],
    read_by: null,
    reason: started.unavailable?.reason ?? 'unavailable',
  };
  const record = { ...provisional, discipline, warnings: [...provisional.warnings, 'complaints_not_checked'] };
  return done(ctx, {
    outcome: 'match',
    records: [record],
    candidates: [],
    warnings: ['complaints_not_checked'],
    pending: [],
  });
}

/** Reads one record by its stored link. Returns 'unknown' when the link gives no record. */
async function readByFetch(
  ctx: Ctx,
  link: Record<string, string>,
  licence: string | null,
  subject: Candidate | null,
): Promise<VerifyResult | 'unknown'> {
  const rec = ctx.adapter.record;
  if (rec.kind !== 'link') throw new Error('readByFetch needs a link record');
  const url = rec.url(link);
  const got = await fetchHtml(ctx, url);
  if ('failure' in got) return fail(ctx, got.failure);
  if ('error' in got) {
    const reason = FETCH_FAILURES.get(got.error);
    return reason === undefined ? 'unknown' : fail(ctx, { reason });
  }
  const html = got.text;
  const readings = [ctx.adapter.parseHtml(html), ctx.adapter.parseText(html)];
  const found = readings.map((r) => r.fields.licence_number).find((n): n is string => n !== null);
  if (found === undefined) return 'unknown';

  const snapshot = await storeSnapshot(ctx.db, {
    check_id: ctx.check_id,
    registry: ctx.route.id,
    url,
    reader_input: 'fetch_html',
    body: html,
  });
  const agreed = agree(readings);
  if (!agreed.agree || agreed.fields === null) {
    return needsReview(ctx, withWarnings(readings, agreementWarnings(agreed)));
  }
  const fields = agreed.fields;
  // A number lookup that also gave a name: the read name must be plausibly the one asked for.
  if (subject === null && nameMismatch(ctx, fields)) return needsReview(ctx, withWarnings(readings, ['name_mismatch']));
  // The link is stored only when the record it leads to is the licence that was asked for or chosen.
  if (licence !== null) {
    if (normaliseLicenceNumber(found) !== normaliseLicenceNumber(licence)) {
      return needsReview(ctx, withWarnings(readings, ['licence_number_mismatch']));
    }
    await upsertKey(ctx.db, ctx.route.id, licence, link, ctx.now);
  }
  const disc = ctx.adapter.discipline;
  if (ctx.input.include_complaints !== false && disc.kind === 'agent_second_run') {
    const provisional = buildRecord(ctx, {
      fields,
      readings,
      source_url: url,
      source_lookup: null,
      subject,
      snapshot,
      screenshot_url: null,
      run_id: ctx.search_run_id ?? null,
      read_by: 'fetch',
      discipline: pendingDiscipline(),
      warnings: [],
    });
    return startComplaints(ctx, provisional, readings, subject, {
      url,
      goal: disc.goal(link),
      output_schema: disc.output_schema,
      capture_config: COMPLAINT_CAPTURE,
    });
  }
  const { discipline, warnings } = await fetchDiscipline(ctx, link, fields);
  return done(ctx, {
    outcome: 'match',
    records: [
      buildRecord(ctx, {
        fields,
        readings,
        source_url: url,
        source_lookup: null,
        subject,
        snapshot,
        screenshot_url: null,
        run_id: ctx.search_run_id ?? null,
        read_by: 'fetch',
        discipline,
        warnings,
      }),
    ],
    candidates: [],
  });
}

async function enqueueJob(
  ctx: Ctx,
  kind: 'search' | 'record' | 'discipline',
  request: Job['payload']['request'],
  maxSteps: number,
  pending: VerifyResult,
): Promise<VerifyResult> {
  // The request arrives without limits; they are applied here, with the money to hold for them.
  const limited = limitedRun(request, maxSteps, ctx.env.AGENT_STEP_CAP);
  const cents = limited.reserved_cents;
  const verdict = await canStart(ctx.env, ctx.db, ctx.client, ctx.bucket, cents, ctx.now);
  if (!verdict.ok) {
    // A wallet that cannot be read is an outage, not a spent budget: the answer is a timeout with a minute to wait.
    if (verdict.cause === 'wallet_unreadable') {
      return fail(ctx, { reason: 'timeout', message: WALLET_UNREADABLE, retry_after: verdict.resets_at });
    }
    return fail(ctx, { reason: 'budget', retry_after: verdict.resets_at });
  }
  // Saved before the job exists, so a run that finishes at once finds the check in its pending state.
  await save(ctx.db, pending);
  try {
    const { position } = await enqueue(ctx.db, {
      kind,
      priority: 1,
      bucket: ctx.bucket,
      reserved_cents: cents,
      payload: { check_id: ctx.check_id, registry: ctx.route.id, request: limited.request },
    });
    return { ...pending, queue_position: position };
  } catch (err) {
    if (err instanceof QueueFull) {
      return fail(ctx, {
        reason: 'rate_limited',
        retry_after: new Date(ctx.now.getTime() + RETRY_AFTER_MS).toISOString(),
      });
    }
    throw err;
  }
}

function enqueueRecord(ctx: Ctx, licence: string, subject: Candidate | null): Promise<VerifyResult> {
  const rec = ctx.adapter.record;
  if (rec.kind !== 'agent') throw new Error('enqueueRecord needs an agent record');
  const request = {
    url: rec.start_url,
    goal: rec.goal(licence),
    output_schema: rec.output_schema,
    capture_config: { html: true, screenshots: true },
  };
  return enqueueJob(ctx, 'record', request, rec.max_steps, {
    ...fresh(ctx, 'reading'),
    candidates: subject ? [subject] : [],
  });
}

/** Agent record outcome: a candidate or a licence number reads a record; a candidate with no way to read fails. */
async function onMatch(ctx: Ctx, chosen: Candidate): Promise<VerifyResult> {
  if (ctx.adapter.record.kind === 'link') {
    if (!chosen.link)
      return fail(ctx, { reason: 'layout_changed', message: 'The registry row had no link to its record.' });
    const got = await readByFetch(ctx, chosen.link, chosen.licence_number, chosen);
    if (got === 'unknown')
      return fail(ctx, { reason: 'layout_changed', message: 'The link to the record returned no record.' });
    return got;
  }
  if (chosen.licence_number === null) {
    return fail(ctx, { reason: 'layout_changed', message: 'The registry row had no licence number.' });
  }
  return enqueueRecord(ctx, chosen.licence_number, chosen);
}

function supportsAlternate(adapter: Adapter, q: Query): boolean {
  const alt: Query = { ...q, alternate: true };
  if (adapter.search.kind === 'agent') return adapter.search.goal(alt) !== adapter.search.goal(q);
  return adapter.search.url(alt) !== adapter.search.url(q);
}

/** Adapters get "Last, First" when the caller gave first and last names separately. */
function adapterName(input: VerifyInput): string | null {
  const name = input.name?.trim();
  if (name) return name;
  const first = input.first_name?.trim() ?? '';
  const last = input.last_name?.trim() ?? '';
  if (first !== '' && last !== '') return `${last}, ${first}`;
  return first || last || null;
}

function queryOf(ctx: Ctx): Query {
  const q: Query = { type: ctx.type };
  const name = adapterName(ctx.input);
  if (name !== null) q.name = name;
  if (ctx.input.licence_number?.trim()) q.licence_number = normaliseLicenceNumber(ctx.input.licence_number);
  if (ctx.input.city?.trim()) q.city = ctx.input.city.trim();
  // A check already marked as read by the agent keeps asking the agent to copy rows, so a later pass does the same.
  if ((ctx.base.warnings ?? []).includes(RESULTS_READ_BY_AGENT)) q.copy_rows = true;
  return q;
}

/**
 * Scores the rows of one search pass and decides. A first pass with no plausible row gets one alternate-spellings pass.
 */
async function resolveRows(
  ctx: Ctx,
  read: Row[],
  alternate: boolean,
  q: Query,
  pageTotal = read.length,
): Promise<VerifyResult> {
  const from = alternate ? 'alternate_spellings' : 'search';
  // A name search can list people of other professions. Those rows are dropped before scoring. A licence
  // number picks its own row, so nothing is dropped for one.
  const ofType = ctx.adapter.ofType;
  const rows = q.licence_number || !ofType ? read : read.filter((row) => ofType(row, q));
  const dropped = read.length - rows.length;
  const more = pageTotal > read.length;
  // Every row read is of another profession and the list goes on: the profession asked may sit on a later
  // page, so this is neither a no_match nor a list of candidates.
  if (dropped > 0 && more && rows.length === 0) {
    return fail(ctx, {
      reason: 'layout_changed',
      message: `The registry lists ${pageTotal} people under this name and the first page holds none of the profession asked. Narrow the search by first name, city or licence number.`,
    });
  }
  const total = more ? pageTotal : rows.length;
  const cands: Candidate[] = rows.map((row, i) => {
    const scored = scoreCandidate(ctx.input, row);
    return { ...row, candidate_id: `cand_${i + 1}`, from, score: scored.score, reasons: scored.reasons };
  });
  const decided = decide(cands);
  const note =
    dropped === 0
      ? []
      : more
        ? ['total_counts_other_professions']
        : rows.length === 0
          ? ['listed_under_other_professions']
          : [];
  const decision = { ...decided, warnings: [...decided.warnings, ...note] };
  // The page lists more results than were read. The rows read cannot show who is missing or who stands alone, so the
  // outcome is never a no_match or a match: the caller narrows the search. A licence number picks its own row.
  if (!q.licence_number && rows.length > 0 && more) {
    const narrowing = [...disambiguatorsFor(cands), ...(ctx.input.city ? [] : ['city']), 'licence_number'];
    const ranked = [...cands].sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
    return done(
      ctx,
      {
        outcome: 'multiple_matches',
        candidates: ranked,
        disambiguators: [...new Set(narrowing)],
        candidates_total: total,
        warnings: decision.warnings,
      },
      alternate,
    );
  }
  if (decision.outcome === 'match') {
    const top = decision.chosen[0];
    if (top !== undefined) return onMatch(ctx, top);
  }
  if (decision.outcome === 'multiple_matches') {
    return done(
      ctx,
      {
        outcome: 'multiple_matches',
        candidates: decision.chosen.slice(0, MAX_CANDIDATES),
        disambiguators: decision.disambiguators,
        candidates_total: total,
        warnings: decision.warnings,
      },
      alternate,
    );
  }
  if (decision.outcome === 'no_match' && !alternate && supportsAlternate(ctx.adapter, q)) {
    return runSearch(ctx, { ...q, alternate: true }, true);
  }
  return done(ctx, { outcome: 'no_match', candidates_total: total, warnings: decision.warnings }, alternate);
}

/** Runs one search pass: inline for a fetch-searched registry, as a queued agent job otherwise. */
async function runSearch(ctx: Ctx, q: Query, alternate: boolean): Promise<VerifyResult> {
  const s = ctx.adapter.search;
  if (s.kind === 'fetch') {
    const got = await fetchHtml(ctx, s.url(q));
    if (!('text' in got)) {
      if ('failure' in got) return fail(ctx, got.failure);
      return fail(ctx, { reason: FETCH_FAILURES.get(got.error) ?? 'layout_changed' });
    }
    const rows = ctx.adapter.rowsFromFetchHtml?.(got.text) ?? [];
    return resolveRows(ctx, rows, alternate, q);
  }
  const { request, max_steps } = searchRequest(ctx.adapter, q);
  const pending = fresh(ctx, 'searching', alternate);
  const marked =
    q.copy_rows === true && s.snapshot !== undefined ? { ...pending, warnings: [RESULTS_READ_BY_AGENT] } : pending;
  return enqueueJob(ctx, 'search', request, max_steps, marked);
}

/** Reads the record of a licence whose key is known. Returns 'unknown' when there is no stored link to try. */
async function routeCheck(ctx: Ctx, v: Valid): Promise<VerifyResult> {
  const until = ctx.adapter.maintenanceUntil(ctx.now);
  if (until !== null) return fail(ctx, { reason: 'maintenance', retry_after: until });
  const licence = v.licence;
  if (licence !== null && ctx.adapter.record.kind === 'agent') return enqueueRecord(ctx, licence, null);
  if (licence !== null && ctx.adapter.record.kind === 'link') {
    const key = await getKey(ctx.db, ctx.route.id, licence);
    const link = linkOf(key?.link_json);
    if (link !== null) {
      const got = await readByFetch(ctx, link, licence, null);
      if (got !== 'unknown') return got;
      // The stored link gave no record. Store an empty link so the key counts as unknown, then search.
      await upsertKey(ctx.db, ctx.route.id, licence, {}, ctx.now);
    }
  }
  return runSearch(ctx, queryOf(ctx), false);
}

async function recordInvalid(
  db: D1Database,
  input: VerifyInput,
  v: Invalid,
  bucket: Bucket,
  now: Date,
): Promise<VerifyResult> {
  const id = await insertCheck(db, { state: 'queued', query_json: queryJson(input, bucket) }, now);
  return save(db, {
    ...shape(id, input, [], 'done'),
    outcome: 'invalid_input',
    checked_at: now.toISOString(),
    invalid: { field: v.field, expected: v.expected },
  });
}

function placeAsked(v: Valid): Place {
  if (v.place !== null) return v.place;
  if (v.jurisdiction === null) return { name: '', kind: 'country' };
  return { name: JURISDICTION_NAME[v.jurisdiction], kind: v.jurisdiction.startsWith('US-') ? 'state' : 'country' };
}

/**
 * No adapter for this type and place. Search finds the official registry link; a nationwide US name gets no search.
 * With a link and something to search for, a queued agent run looks the licence up on that register and
 * genericStage checks its answer against the captured page.
 */
async function recordUnsupported(
  env: Env,
  client: TinyFish,
  db: D1Database,
  check_id: string,
  input: VerifyInput,
  v: Valid,
  now: Date,
  bucket: Bucket,
): Promise<VerifyResult> {
  const place = placeAsked(v);
  let found: Unsupported = {
    registry_name: null,
    registry_url: null,
    message: place.kind === 'us' ? US_NAME_A_STATE : NO_ADAPTER_YET,
  };
  if (place.kind !== 'us') {
    try {
      let hit: { title: string; url: string } | undefined;
      for (const wording of searchWordings(place, v.type)) {
        hit = (await client.search(wording)).results.find((r) => isOfficialHost(r.url, place, v.type));
        if (hit) break;
      }
      if (hit) found = { registry_name: hit.title || null, registry_url: hit.url, message: NO_ADAPTER_YET };
    } catch (err) {
      if (!(err instanceof TinyFishError)) throw err;
    }
  }
  const linkOnly: VerifyResult = {
    ...shape(check_id, input, [], 'done'),
    outcome: 'unsupported',
    checked_at: now.toISOString(),
    unsupported: found,
  };
  if (found.registry_url === null || (v.name === null && v.licence === null)) return save(db, linkOnly);

  const limited = limitedRun(
    {
      url: found.registry_url,
      goal: genericGoal({ type: v.type, name: v.name, licence: v.licence }),
      output_schema: GENERIC_OUTPUT_SCHEMA,
      capture_config: { html: true, screenshots: true },
    },
    GENERIC_MAX_STEPS,
    env.AGENT_STEP_CAP,
  );
  // The register was found but the lookup cannot start. That is said as it is, with the link, and never cached.
  const notStarted = (f: Failure): Promise<VerifyResult> => {
    const result: VerifyResult = {
      ...shape(check_id, input, [], 'done'),
      outcome: 'source_unavailable',
      checked_at: now.toISOString(),
      unavailable: unavailableBlock(f),
      unsupported: { registry_name: found.registry_name, registry_url: found.registry_url },
    };
    uncached.add(result);
    return save(db, result);
  };
  const verdict = await canStart(env, db, client, bucket, limited.reserved_cents, now);
  if (!verdict.ok) return notStarted({ reason: 'budget', retry_after: verdict.resets_at });
  const pending: VerifyResult = {
    ...shape(check_id, input, [], 'searching'),
    unsupported: { registry_name: found.registry_name, registry_url: found.registry_url },
  };
  await save(db, pending);
  try {
    const { position } = await enqueue(db, {
      kind: 'generic',
      priority: 1,
      bucket,
      reserved_cents: limited.reserved_cents,
      payload: { check_id, registry: 'generic', request: limited.request },
    });
    return { ...pending, queue_position: position };
  } catch (err) {
    if (err instanceof QueueFull)
      return notStarted({
        reason: 'rate_limited',
        retry_after: new Date(now.getTime() + RETRY_AFTER_MS).toISOString(),
      });
    throw err;
  }
}

const GENERIC_REASONS: Record<string, UnavailableReason> = { captcha: 'captcha', login: 'login_required' };
const NOT_GROUNDED =
  "The register's page could not be read with confidence, so nothing is shown. Check the official link.";

/**
 * The end of a generic lookup. The agent's answer is kept only where the page it captured says the same;
 * anything else ends as needs_review with the register's link and no record.
 */
async function genericStage(
  env: Env,
  db: D1Database,
  client: TinyFish,
  base: VerifyResult,
  link: Unsupported & { registry_url: string },
  run: JobOutcome,
  now: Date,
): Promise<VerifyResult> {
  const finish = (patch: Partial<VerifyResult> & { outcome: Outcome }, message?: string): VerifyResult => ({
    ...shape(base.check_id, base.query, [], 'done'),
    ...patch,
    warnings: ['generic_route', ...(patch.warnings ?? [])],
    checked_at: now.toISOString(),
    unsupported: {
      registry_name: link.registry_name,
      registry_url: link.registry_url,
      ...(message ? { message } : {}),
    },
  });
  const unavailable = (f: Failure): VerifyResult => {
    const result = finish({ outcome: 'source_unavailable', unavailable: unavailableBlock(f) });
    uncached.add(result);
    return result;
  };
  const notGrounded = (): VerifyResult => finish({ outcome: 'needs_review', warnings: ['not_grounded'] }, NOT_GROUNDED);

  const settled = settle(run, now);
  if ('failure' in settled) return unavailable(settled.failure);
  const v = validate(base.query);
  const answer = readAnswer(settled.run.result);
  if (!v.ok || answer === null) return notGrounded();
  const { run_id, steps } = settled.run;

  if (answer.record === null) {
    if (answer.reason === 'several') {
      const total = answer.results_total ?? 0;
      return finish(
        {
          outcome: 'needs_review',
          candidates_total: total,
          disambiguators: ['licence_number'],
          warnings: ['several_results'],
        },
        `The register lists ${total > 1 ? `${total} records` : 'several records'} under this name. Add the ${v.type === 'company' ? 'registration' : 'licence'} number to check one.`,
      );
    }
    if (answer.reason === 'no_results') {
      const page = await readHtmlWhere(client, run_id, steps, saysNoResults, 8);
      return page?.accepted ? finish({ outcome: 'no_match' }) : notGrounded();
    }
    return unavailable({ reason: GENERIC_REASONS[answer.reason ?? ''] ?? 'layout_changed' });
  }

  const reported = answer.record;
  const place = placeAsked(v);
  const page = await readHtmlWhere(client, run_id, steps, (html) => holdsNumber(html, reported.licence_number), 8);
  if (!page?.accepted) return notGrounded();
  const grounded = groundRecord(
    reported,
    page.html,
    { type: v.type, name: v.name, licence: v.licence },
    {
      monthFirst: place.kind !== 'country',
      official: (url) => isOfficialHost(url, place, v.type),
    },
  );
  if (grounded === null) return notGrounded();

  const snapshot = await storeSnapshot(db, {
    check_id: base.check_id,
    registry: 'generic',
    url: grounded.source_url,
    reader_input: 'agent_html',
    body: page.html,
    run_id,
    step_id: page.step_id,
  });
  const record: LicenceRecord = {
    registry: {
      id: 'generic',
      name: link.registry_name ?? new URL(link.registry_url).hostname,
      jurisdiction: place.name,
    },
    key: { licence_number: grounded.licence_number },
    source_url: grounded.source_url,
    source_lookup: link.registry_url,
    data_as_of: null,
    subject: {
      name: grounded.name,
      kind: v.type === 'company' || BUSINESS.test(normaliseName(grounded.name).folded) ? 'business' : 'person',
      other_names: [],
      city: null,
    },
    licence: {
      type: grounded.licence_type,
      rank: null,
      status: grounded.status,
      status_raw: grounded.status_raw,
      issued: null,
      expires: grounded.expires,
    },
    discipline: notReadHere(),
    match: null,
    verification: { readers: ['agent_output', 'page_grounding'], agree: true },
    evidence: {
      quotes: grounded.quotes,
      snapshot_id: snapshot.snapshot_id,
      content_sha256: snapshot.content_sha256,
      screenshot_url: screenshotUrl(env, snapshot.snapshot_id),
      tinyfish_run_id: run_id,
    },
    read_by: 'agent',
    adapter_version: GENERIC_VERSION,
    warnings: ['generic_route'],
  };
  return finish({
    outcome: 'match',
    records: [record],
    warnings: grounded.status === 'other' ? ['status_unknown_wording'] : [],
  });
}

/**
 * The table lists this registry but no adapter is registered for it. No search, no run: the answer is
 * the registry's own link and a plain message.
 */
async function recordNotConnected(
  db: D1Database,
  check_id: string,
  input: VerifyInput,
  route: RegistryInfo,
  now: Date,
): Promise<VerifyResult> {
  return save(db, {
    ...shape(check_id, input, [], 'done'),
    outcome: 'unsupported',
    checked_at: now.toISOString(),
    unsupported: { registry_name: route.name, registry_url: route.url, message: NOT_CONNECTED },
  });
}

/** Creates the check, serves the cache, and runs the first step. Never throws for user input. */
export async function startCheck(
  env: Env,
  db: D1Database,
  client: TinyFish,
  input: VerifyInput,
  bucket: Bucket,
): Promise<VerifyResult> {
  const now = new Date();
  let check_id: string | null = null;
  try {
    const v = validate(input);
    if (!v.ok) return await recordInvalid(db, input, v, bucket, now);
    const cacheKey = cacheKeyFor(input, v);
    const cached = await findCachedCheck(db, cacheKey, CACHE_SECONDS, now);
    if (cached !== null && cached.result_json !== null) {
      const stored = JSON.parse(cached.result_json) as VerifyResult;
      // A result whose complaints were not checked is re-run, so a later call can read them.
      const degraded = (stored.warnings ?? []).includes('complaints_not_checked');
      if (stored.outcome !== null && CACHEABLE.has(stored.outcome) && !degraded) return servedFromCache(cached, now);
    }

    check_id = await insertCheck(
      db,
      { state: 'queued', query_json: queryJson(input, bucket), cache_key: cacheKey },
      now,
    );
    if (v.route === null) return await recordUnsupported(env, client, db, check_id, input, v, now, bucket);
    if (tryGetAdapter(v.route.id) === undefined) return await recordNotConnected(db, check_id, input, v.route, now);
    const spellings = v.name === null ? [] : [v.name];
    const base = shape(check_id, input, [v.route.id], 'queued', false, spellings);
    const ctx = makeCtx(env, db, client, check_id, input, base, bucket, now);
    return await save(db, await routeCheck(ctx, v));
  } catch (err) {
    console.error(err);
    const id = check_id ?? (await insertCheck(db, { state: 'queued', query_json: queryJson(input, bucket) }, now));
    return save(db, {
      ...shape(id, input, [], 'done'),
      outcome: 'source_unavailable',
      checked_at: now.toISOString(),
      unavailable: { reason: 'timeout', message: SOMETHING_WRONG },
    });
  }
}

async function searchStage(ctx: Ctx, run: JobOutcome): Promise<VerifyResult> {
  const s = settle(run, ctx.now);
  if ('failure' in s) return fail(ctx, s.failure);
  const answer = (s.run.result ?? {}) as { page?: unknown; total?: unknown; url?: unknown };
  const q = queryOf(ctx);
  const alternate = ctx.base.searched.alternate_spellings_used;
  const ran = { ...ctx, search_run_id: s.run.run_id };
  // The snapshot path is for a run whose request was a snapshot request. A run sent any other way has no snapshots, and
  // the row-copying fallback (q.copy_rows) never takes the path, so a search starts at most one snapshot run and one
  // fallback run per spelling.
  const searchResult =
    typeof answer.page === 'string' && isSnapshotRequest(ctx.adapter, q)
      ? await snapshotSearch(ran, s.run, answer, q, alternate)
      : await rowsSearch(ran, s.run, q, alternate);
  // An adapter that asks for a page value is a registry that can say "no results" itself. Only a no_match that rests on
  // that page, seen by code on the captured page, is kept for later callers. Any other (a list with no plausible row,
  // a "none" nobody could check, a page that could not be told) is not.
  if (
    ctx.adapter.search.kind === 'agent' &&
    ctx.adapter.search.reports_page &&
    searchResult.outcome === 'no_match' &&
    !confirmedNone.has(searchResult)
  ) {
    uncached.add(searchResult);
  }
  // A check that fell back to the agent's own rows says so on its result.
  const warnings = searchResult.warnings ?? [];
  if (q.copy_rows === true && !warnings.includes(RESULTS_READ_BY_AGENT)) {
    const marked = { ...searchResult, warnings: [...warnings, RESULTS_READ_BY_AGENT] };
    if (uncached.has(searchResult)) uncached.add(marked);
    return marked;
  }
  return searchResult;
}

/** The run copied the rows into its answer: the answer is the candidates. */
async function rowsSearch(ctx: Ctx, run: RunResult, q: Query, alternate: boolean): Promise<VerifyResult> {
  const rows =
    (q.licence_number ? linkFinderRows(ctx.adapter, run.result, q.licence_number) : null) ??
    ctx.adapter.rowsFromAgent(run.result);
  if (ctx.adapter.search.kind === 'agent' && ctx.adapter.search.reports_page) {
    if (rows.length === 0) {
      // An answer with no rows and no address is checked against the captured page: "none", or a list the run did not
      // copy.
      const page = pageOf(run.result);
      if (page === 'none') return noneSearch(ctx, run, q, alternate);
      if (page === 'results') {
        const listed = await resultsSearch(ctx, run, null, q, alternate);
        if (listed !== null) return listed;
      }
    }
    const verdict = judgeSearchAnswer(run.result, rows.length);
    if (verdict.kind === 'unavailable') return fail(ctx, { reason: verdict.reason, message: verdict.message });
  }
  const reported = (run.result as { total?: unknown } | null)?.total;
  const total = typeof reported === 'number' ? reported : rows.length;
  return resolveRows(ctx, rows, alternate, q, total);
}

/**
 * One more run, copying the rows. It is never started from a run that already copied them, nor when its goal is the
 * one that just ran: the same goal would only be paid for twice.
 */
function fallbackSearch(ctx: Ctx, q: Query, alternate: boolean): Promise<VerifyResult> | VerifyResult {
  const search = ctx.adapter.search;
  const sameGoal = search.kind === 'agent' && search.goal({ ...q, copy_rows: true }) === search.goal(q);
  if (q.copy_rows === true || sameGoal) return fail(ctx, { reason: 'layout_changed' });
  return runSearch(ctx, { ...q, copy_rows: true }, alternate);
}

/** True when both record readers find a licence number on the captured page. */
function showsRecord(adapter: Adapter, html: string): boolean {
  return (
    adapter.parseHtml(html).fields.licence_number !== null && adapter.parseText(html).fields.licence_number !== null
  );
}

/**
 * The run answered "none", the registry's own no-results page. The captured page decides, not the word: a results list
 * there continues as a results list, and a licence page sends the search on to the row-copying run. A page that is
 * neither is a no_match kept for later callers. With no readable capture it is a no_match that nobody could check.
 */
async function noneSearch(ctx: Ctx, run: RunResult, q: Query, alternate: boolean): Promise<VerifyResult> {
  const found = await readLatestHtml(ctx.client, run.run_id, run.steps);
  if (found !== null) {
    const list = ctx.adapter.rowsFromSnapshot?.(found.html) ?? null;
    if (list !== null) return (await listedResult(ctx, list, null, q, alternate)) ?? fallbackSearch(ctx, q, alternate);
    if (showsRecord(ctx.adapter, found.html)) return fallbackSearch(ctx, q, alternate);
  }
  const result = await resolveRows(ctx, [], alternate, q, 0);
  if (found !== null && result.outcome === 'no_match') confirmedNone.add(result);
  return result;
}

/**
 * A results list read from the captured page. Null when a query with a licence number meets a list with a row whose
 * number could not be read, so the list was not understood.
 */
async function listedResult(
  ctx: Ctx,
  read: { rows: Row[]; total: number | null },
  reported: number | null,
  q: Query,
  alternate: boolean,
): Promise<VerifyResult | null> {
  // A query with a licence number wants that licence only: the candidates are the rows carrying exactly that number
  // (one licence can have several rows, one for each name line). A list with no such row is a no-match, unless a row
  // has no readable number: then the list was not understood.
  if (q.licence_number) {
    const want = normaliseLicenceNumber(q.licence_number);
    const same = read.rows.filter(
      (r) => r.licence_number !== null && normaliseLicenceNumber(r.licence_number) === want,
    );
    if (same.length > 0 || read.rows.every((r) => r.licence_number !== null))
      return resolveRows(ctx, same, alternate, q, same.length);
    return null;
  }
  return resolveRows(ctx, read.rows, alternate, q, read.total ?? reported ?? read.rows.length);
}

/**
 * The run said the page was a results list: the rows come from the run's latest page snapshot. Null when no snapshot
 * reads as a list.
 */
async function resultsSearch(
  ctx: Ctx,
  run: RunResult,
  reported: number | null,
  q: Query,
  alternate: boolean,
): Promise<VerifyResult | null> {
  const found = await readLatestHtml(ctx.client, run.run_id, run.steps);
  const read = found === null ? null : (ctx.adapter.rowsFromSnapshot?.(found.html) ?? null);
  return read === null ? null : listedResult(ctx, read, reported, q, alternate);
}

/** The run stopped at the page and said which kind it was; the rows come from the run's page snapshot. */
async function snapshotSearch(
  ctx: Ctx,
  run: RunResult,
  answer: { page?: unknown; total?: unknown; url?: unknown },
  q: Query,
  alternate: boolean,
): Promise<VerifyResult> {
  const adapter = ctx.adapter;
  const page = pageOf(answer);
  if (page === 'none') return noneSearch(ctx, run, q, alternate);
  const failed = pageFailure(page);
  if (failed !== null) return fail(ctx, { reason: failed.reason, message: failed.message });
  if (page === 'record' && typeof answer.url === 'string') {
    // One licence page opened. The candidate is the licence number that was asked for, with the link in the answer, and
    // the record read from that link decides; no snapshot is needed for it.
    const rows = linkFinderRows(adapter, run.result, q.licence_number) ?? [];
    if (rows.length === 0) return fail(ctx, { reason: 'layout_changed' });
    // A typed name is scored against the name the licence page itself shows, when a snapshot has it.
    if (q.name || !q.licence_number) {
      const found = await readLatestHtml(ctx.client, run.run_id, run.steps);
      const shown = found === null ? null : adapter.parseText(found.html).fields;
      if (shown?.name) {
        rows[0] = {
          ...rows[0],
          name: shown.name,
          licence_number: rows[0].licence_number ?? shown.licence_number,
          city: shown.city,
          licence_type: shown.licence_type,
          status_raw: shown.status_raw,
        };
      }
    }
    return resolveRows(ctx, rows, alternate, q);
  }
  if (page === 'results') {
    const listed = await resultsSearch(ctx, run, typeof answer.total === 'number' ? answer.total : null, q, alternate);
    if (listed !== null) return listed;
  }
  // The page could not be read by code (or the answer was not one of the three): one more run, copying the rows.
  return fallbackSearch(ctx, q, alternate);
}

/** One plain line per complaint: case, date, status, then the description. */
function complaintLine(c: Record<string, unknown>): string {
  const head = [c.case_number, c.date, c.status].filter((v) => typeof v === 'string' && v !== '').join(', ');
  const description = typeof c.description === 'string' && c.description !== '' ? `: ${c.description}` : '';
  return `${head}${description}`;
}

const pendingDiscipline = (): Discipline => ({
  checked: false,
  on_file: null,
  actions: [],
  read_by: null,
  reason: 'Complaint check in progress.',
});

/**
 * Discipline of an agent-read record that has no complaint run to start. A record page that shows its
 * discipline is always read; include_complaints only turns the separate complaint run off.
 */
function agentDiscipline(ctx: Ctx, fields: Fields, include: boolean): Discipline {
  const d = ctx.adapter.discipline;
  if (d.kind === 'on_page') {
    return { checked: true, on_file: fields.discipline_flag, actions: fields.discipline_actions, read_by: 'agent' };
  }
  if (d.kind === 'agent_second_run' && !include) return notRequested();
  return notReadHere();
}

/**
 * The record run finished: read the page, compare the readers, and either store the record or start its discipline run.
 */
async function recordStage(ctx: Ctx, run: JobOutcome): Promise<VerifyResult> {
  const s = settle(run, ctx.now);
  if ('failure' in s) return fail(ctx, s.failure);
  const agentRun = s.run;
  const rec = ctx.adapter.record;
  if (rec.kind !== 'agent') throw new Error('recordStage needs an agent record');

  // The latest step whose page can be read; the screenshot link uses the same step.
  const found = await readLatestHtml(ctx.client, agentRun.run_id, agentRun.steps);
  const lastStep = found?.step_id;
  const html = found?.html ?? '';
  const readings: Reading[] = html === '' ? [] : [ctx.adapter.parseHtml(html), ctx.adapter.parseText(html)];
  readings.push(ctx.adapter.fieldsFromAgent(agentRun.result));

  const snapshot = await storeSnapshot(ctx.db, {
    check_id: ctx.check_id,
    registry: ctx.route.id,
    url: rec.start_url,
    reader_input: 'agent_html',
    body: html,
    run_id: agentRun.run_id,
    step_id: lastStep,
  });
  const screenshot = screenshotUrl(ctx.env, snapshot.snapshot_id);
  const subject = ctx.base.candidates[0] ?? null;
  const agreed = agree(readings);
  if (readings.length < 2) {
    return needsReview(ctx, withWarnings(readings, ['single_reader', ...agreementWarnings(agreed)]));
  }
  if (!agreed.agree || agreed.fields === null) {
    return needsReview(ctx, withWarnings(readings, agreementWarnings(agreed)));
  }
  const fields = agreed.fields;
  const requested =
    subject?.licence_number ??
    (ctx.input.licence_number?.trim() ? normaliseLicenceNumber(ctx.input.licence_number) : null);
  if (requested !== null && normaliseLicenceNumber(fields.licence_number ?? '') !== normaliseLicenceNumber(requested)) {
    return needsReview(ctx, withWarnings(readings, ['licence_number_mismatch']));
  }
  // A number lookup that also gave a name: the read name must be plausibly the same person or business.
  if (subject === null && nameMismatch(ctx, fields)) return needsReview(ctx, withWarnings(readings, ['name_mismatch']));
  const include = ctx.input.include_complaints !== false;
  const parts = {
    fields,
    readings,
    source_url: rec.start_url,
    source_lookup: rec.source_lookup(fields.licence_number ?? ''),
    subject,
    snapshot,
    screenshot_url: screenshot,
    run_id: agentRun.run_id,
    read_by: 'agent' as const,
    warnings: [] as string[],
  };

  const disc = ctx.adapter.discipline;
  if (include && disc.kind === 'agent_second_run') {
    const provisional = buildRecord(ctx, { ...parts, discipline: pendingDiscipline() });
    const request = {
      url: rec.start_url,
      goal: disc.goal(subject?.link ?? {}),
      output_schema: disc.output_schema,
      capture_config: COMPLAINT_CAPTURE,
    };
    return startComplaints(ctx, provisional, readings, subject, request);
  }
  return done(ctx, {
    outcome: 'match',
    records: [buildRecord(ctx, { ...parts, discipline: agentDiscipline(ctx, fields, include) })],
    candidates: [],
  });
}

/**
 * The record with its complaints marked as not checked. The warning also keeps the result out of the cache,
 * so the next call reads the complaints again.
 */
function complaintsNotChecked(
  ctx: Ctx,
  prov: LicenceRecord,
  discipline: Discipline,
  warnings: string[] = [],
): VerifyResult {
  const all = [...warnings, 'complaints_not_checked'];
  const record = { ...prov, discipline, warnings: [...new Set([...prov.warnings, ...all])] };
  return done(ctx, { outcome: 'match', records: [record], candidates: [], warnings: all, pending: [] });
}

/** The discipline run finished: attach its actions to the stored provisional record. */
async function disciplineStage(ctx: Ctx, run: JobOutcome): Promise<VerifyResult> {
  const prov = ctx.base.records[0];
  if (prov === undefined) return fail(ctx, { reason: 'timeout' });
  const s = settle(run, ctx.now);
  if ('failure' in s) {
    return complaintsNotChecked(ctx, prov, {
      checked: false,
      on_file: null,
      actions: [],
      read_by: null,
      reason: s.failure.refused ? COMPLAINT_NOT_STARTED : (s.failure.message ?? MESSAGES[s.failure.reason]),
    });
  }

  // The complaint view is the newest of the last 4 snapshots that both readers take for it: the agent may have
  // clicked away after reading. When there is none, the page the run ended on is kept as evidence of what it
  // showed, or the run's own JSON result when no page could be captured.
  const found = await readHtmlWhere(
    ctx.client,
    s.run.run_id,
    s.run.steps,
    (candidate) => readComplaintPage(ctx.adapter, candidate) !== null,
  );
  // A view that both readers accept but that the run does not tie to this licence may be another record's:
  // nothing from it is kept.
  const untied =
    found?.accepted === true &&
    !(await tiedToLicence(ctx.client, s.run.run_id, s.run.steps, found, ctx.adapter, prov.key.licence_number));
  const kept = untied ? null : found;
  const html = kept?.html ?? '';
  const snapshot = await storeSnapshot(ctx.db, {
    check_id: ctx.check_id,
    registry: ctx.route.id,
    url: prov.source_url,
    reader_input: 'agent_html',
    body: html === '' ? JSON.stringify(s.run.result ?? null) : html,
    run_id: s.run.run_id,
    step_id: kept?.step_id,
  });
  const proof = {
    snapshot_id: snapshot.snapshot_id,
    screenshot_url: kept === null ? null : screenshotUrl(ctx.env, snapshot.snapshot_id),
  };
  const captureWarnings = html === '' && !untied ? ['complaint_page_not_captured'] : [];
  const notChecked = (reason: string, warnings: string[] = []): VerifyResult =>
    complaintsNotChecked(
      ctx,
      prov,
      { checked: false, on_file: null, actions: [], read_by: null, reason, ...proof },
      warnings,
    );

  // The captured page decides. The run's answer never makes a complaint answer, in either direction.
  if (untied) return notChecked(COMPLAINT_NOT_TIED);
  const read = kept?.accepted ? readComplaintPage(ctx.adapter, html) : null;
  if (read === null) return notChecked(COMPLAINT_PAGE_NOT_CAPTURED, captureWarnings);
  if (!read.agree) return notChecked(COMPLAINT_READERS_DISAGREE, ['complaint_readers_disagree']);

  const out = (s.run.result ?? {}) as {
    complaints?: unknown;
    complaint_view_opened?: unknown;
    evidence_line?: unknown;
  };
  const differs =
    out.complaint_view_opened !== true || !Array.isArray(out.complaints) || out.complaints.length !== read.rows.length;
  const discipline: Discipline = {
    checked: true,
    on_file: read.rows.length > 0,
    actions: read.rows.map(complaintLine),
    read_by: 'both_readers',
    ...proof,
  };
  // The line the run copied from the complaint view is a quote for the record.
  // It is kept only when it appears on the captured page. Otherwise it is dropped and the record says so.
  const line = typeof out.evidence_line === 'string' ? out.evidence_line.trim() : '';
  const verified = line !== '' && lineOnPage(line, html);
  const quoteWarnings = line !== '' && !verified ? ['complaint_quote_unverified'] : [];
  const resultWarnings = [...(differs ? ['agent_answer_differs'] : []), ...quoteWarnings];
  const quotes = verified ? [...prov.evidence.quotes, line] : prov.evidence.quotes;
  const record = {
    ...prov,
    discipline,
    evidence: { ...prov.evidence, quotes },
    warnings: [...new Set([...prov.warnings, ...resultWarnings])],
  };
  return done(ctx, { outcome: 'match', records: [record], candidates: [], warnings: resultWarnings, pending: [] });
}

/**
 * While reading, a record run belongs to a check with no record stored yet, and a discipline run to a check
 * that already holds the record it will be attached to.
 */
function matchesStage(kind: JobKind, state: VerifyResult['state'], recordCount: number): boolean {
  if (state === 'searching') return kind === 'search';
  if (state === 'reading') return recordCount === 0 ? kind === 'record' : kind === 'discipline';
  return false;
}

/** Continues a check after one of its runs finished. The stored state says which stage that run belongs to. */
export async function continueCheck(
  env: Env,
  db: D1Database,
  client: TinyFish,
  check_id: string,
  run: JobOutcome,
  bucket: Bucket,
  kind?: JobKind,
): Promise<void> {
  const row = await getCheck(db, check_id);
  if (!row?.result_json) return;
  const base = JSON.parse(row.result_json) as VerifyResult;
  if (base.state === 'done') return;
  const link = base.unsupported;
  if (base.searched.registries.length === 0 && link !== undefined && link.registry_url !== null) {
    if (kind !== undefined && kind !== 'generic') return;
    await save(
      db,
      await genericStage(env, db, client, base, { ...link, registry_url: link.registry_url }, run, new Date()),
    );
    return;
  }
  // A finished job counts only for the stage its check is in: a search run while searching, a record run
  // while reading with no record yet, a discipline run while reading with one.
  // Any other run is ignored and the check is left as it is.
  if (kind !== undefined && !matchesStage(kind, base.state, base.records.length)) {
    console.warn(`Run of kind ${kind} ignored: check ${check_id} is ${base.state}`);
    return;
  }
  const ctx = makeCtx(env, db, client, check_id, base.query, base, bucket, new Date());
  if (base.state === 'searching') {
    await save(db, await searchStage(ctx, run));
    return;
  }
  if (base.state === 'reading') {
    await save(db, base.records.length === 0 ? await recordStage(ctx, run) : await finishedComplaintStage(ctx, run));
  }
}

/**
 * The complaint stage, or the record with complaints not checked when the stage throws, so the check is never left
 * reading.
 */
async function finishedComplaintStage(ctx: Ctx, run: JobOutcome): Promise<VerifyResult> {
  try {
    return await disciplineStage(ctx, run);
  } catch (err) {
    // The error's name only: the message and the request can hold what the caller typed.
    console.error(
      `check ${ctx.check_id}: the complaint stage failed (${err instanceof Error ? err.name : 'unknown error'})`,
    );
    const discipline: Discipline = {
      checked: false,
      on_file: null,
      actions: [],
      read_by: null,
      reason: COMPLAINT_NOT_COMPLETED,
    };
    return complaintsNotChecked(ctx, ctx.base.records[0], discipline);
  }
}

/** The user picks one of several candidates; the check reads that candidate's record in a new check. */
export async function refine(
  env: Env,
  db: D1Database,
  client: TinyFish,
  check_id: string,
  candidate_id: string,
  bucket: Bucket,
): Promise<VerifyResult> {
  const now = new Date();
  const row = await getCheck(db, check_id);
  const base = row?.result_json ? (JSON.parse(row.result_json) as VerifyResult) : null;
  const cand =
    base !== null && base.state === 'done' && base.outcome === 'multiple_matches'
      ? base.candidates.find((c) => c.candidate_id === candidate_id)
      : undefined;
  if (base === null || cand === undefined) {
    return {
      ...shape(check_id, { record_type: '', jurisdiction: '' }, [], 'done'),
      outcome: 'invalid_input',
      checked_at: now.toISOString(),
      invalid: { field: 'candidate_id', expected: 'a candidate_id from an earlier multiple_matches result' },
    };
  }
  const id = await insertCheck(db, { state: 'queued', query_json: queryJson(base.query, bucket) }, now);
  const seed = {
    ...shape(id, base.query, base.searched.registries, 'queued', false, base.searched.spellings_tried),
    candidates: [cand],
  };
  const ctx = makeCtx(env, db, client, id, base.query, seed, bucket, now);
  return save(db, await onMatch(ctx, cand));
}

/** Queue continuations. A search run that belongs to a watch goes to the watch module, not to a check. */
async function fromJob(env: Env, db: D1Database, client: TinyFish, job: Job, outcome: JobOutcome): Promise<void> {
  if (job.kind === 'search' && job.payload.watch_id !== undefined) {
    await resolveWatchFromSearch(env, db, client, job, outcome);
    return;
  }
  if (job.payload.check_id === undefined) return;
  await continueCheck(env, db, client, job.payload.check_id, outcome, job.bucket, job.kind);
}

registerContinuation('search', fromJob);
registerContinuation('record', fromJob);
registerContinuation('discipline', fromJob);
registerContinuation('generic', fromJob);
