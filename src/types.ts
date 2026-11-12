/**
 * The shapes that cross the API: the lookup input, the readings and fields a registry page gives, and the
 * VerifyResult a check returns. parseVerifyRequest checks an incoming body.
 */

import { z } from 'zod';

export type RecordType = 'physician' | 'dentist' | 'nurse' | 'pharmacist' | 'contractor' | 'company';
export type Jurisdiction = 'US-FL' | 'US-CA' | 'AU';
export type RegistryId = 'fl-mqa' | 'fl-dbpr' | 'ca-cslb' | 'au-ahpra';
export type Outcome =
  'match' | 'multiple_matches' | 'no_match' | 'needs_review' | 'source_unavailable' | 'unsupported' | 'invalid_input';
export type Status =
  | 'active'
  | 'expired'
  | 'suspended'
  | 'revoked'
  | 'surrendered'
  | 'inactive'
  | 'probation'
  | 'pending'
  | 'delinquent'
  | 'other';
export type UnavailableReason =
  'blocked' | 'captcha' | 'maintenance' | 'timeout' | 'layout_changed' | 'login_required' | 'rate_limited' | 'budget';
export type ReaderName = 'parser_html' | 'parser_text' | 'agent_output' | 'page_grounding';

export interface VerifyInput {
  name?: string;
  licence_number?: string;
  record_type: string;
  jurisdiction: string;
  first_name?: string;
  last_name?: string;
  city?: string;
  include_complaints?: boolean;
  candidate_id?: string;
}

export interface Fields {
  name: string | null;
  licence_number: string | null;
  status_raw: string | null;
  status: Status | null;
  expires: string | null;
  issued: string | null;
  licence_type: string | null;
  discipline_flag: boolean | null;
  discipline_actions: string[];
  data_as_of: string | null;
  city: string | null;
  other_names: string[];
}

export interface Reading {
  reader: ReaderName;
  fields: Fields;
  quotes: string[];
  warnings: string[];
}

export interface Candidate {
  candidate_id: string;
  name: string;
  licence_number: string | null;
  city: string | null;
  licence_type: string | null;
  status_raw: string | null;
  score: number;
  reasons: string[];
  from: 'search' | 'alternate_spellings';
  link: Record<string, string> | null;
}

export interface LicenceRecord {
  /** A record read through the generic route carries the id 'generic' and the place as the visitor named it. */
  registry: { id: RegistryId | 'generic'; name: string; jurisdiction: Jurisdiction | string };
  key: { licence_number: string };
  source_url: string;
  source_lookup: string | null;
  data_as_of: string | null;
  subject: { name: string; kind: 'person' | 'business'; other_names: string[]; city: string | null };
  licence: {
    type: string | null;
    rank: string | null;
    status: Status;
    status_raw: string;
    issued: string | null;
    expires: string | null;
  };
  discipline: {
    checked: boolean;
    on_file: boolean | null;
    actions: string[];
    read_by: 'fetch' | 'agent' | 'both_readers' | null;
    reason?: string;
    /** The stored page of the complaint view and its screenshot, when a complaint run read one. */
    snapshot_id?: string;
    screenshot_url?: string | null;
  };
  match: { score: number; reasons: string[] } | null;
  verification: { readers: ReaderName[]; agree: boolean };
  evidence: {
    quotes: string[];
    snapshot_id: string;
    content_sha256: string;
    screenshot_url: string | null;
    tinyfish_run_id: string | null;
  };
  read_by: 'fetch' | 'agent';
  adapter_version: string;
  warnings: string[];
}

export interface VerifyResult {
  check_id: string;
  state: 'queued' | 'searching' | 'reading' | 'done';
  query: VerifyInput;
  outcome: Outcome | null;
  checked_at: string | null;
  served_from_cache: boolean;
  cache_age_seconds?: number;
  records: LicenceRecord[];
  candidates: Candidate[];
  disambiguators: string[];
  searched: { registries: RegistryId[]; spellings_tried: string[]; alternate_spellings_used: boolean };
  unavailable?: { reason: UnavailableReason; message?: string; retry_after?: string };
  unsupported?: { registry_name: string | null; registry_url: string | null; message?: string };
  invalid?: { field: string; expected: string };
  readings?: Reading[];
  queue_position?: number;
  streaming_url?: string | null;
  candidates_total?: number;
  warnings?: string[];
  /**
   * The parts of the check still running while the record is already shown: ["complaints"] until the complaint run
   * ends, then an empty list on the final result. Absent on a result that never had a partial.
   */
  pending?: string[];
}

export interface Snapshot {
  snapshot_id: string;
  check_id: string | null;
  watch_id: string | null;
  registry: RegistryId | 'generic';
  url: string;
  reader_input: 'fetch_html' | 'agent_html' | 'monitor_html';
  content_sha256: string;
  body: string;
  run_id: string | null;
  step_id: string | null;
  created_at: string;
}

export interface Event {
  event_id: string;
  watch_id: string;
  kind: 'status_change' | 'check_failed' | 'unchanged';
  before: Partial<Fields> | null;
  after: Partial<Fields> | null;
  /** judgment is what the TinyFish Monitor said about the run. It is kept beside the event and never decides it. */
  evidence: { snapshot_id?: string; line?: string; note?: string; judgment?: unknown };
  created_at: string;
}

/** What a caller may send to a check. record_type and jurisdiction are required text; every other field is optional. */
const requestText = z.string({ error: (issue) => (issue.input === undefined ? 'is required' : 'must be text') });
const optionalText = requestText.optional();
const verifyInputFields = {
  name: optionalText,
  licence_number: optionalText,
  record_type: requestText,
  jurisdiction: requestText,
  first_name: optionalText,
  last_name: optionalText,
  city: optionalText,
  include_complaints: z.boolean({ error: 'must be true or false' }).optional(),
  candidate_id: optionalText,
};

/**
 * The request body of POST /verify and the arguments of verify_licence. Fields it does not know are dropped, so a check
 * only ever receives the fields above, each of its own type. check_id travels with candidate_id on a refinement.
 */
const verifyRequestSchema = z.object({ ...verifyInputFields, check_id: optionalText });

const describeIssue = (issue: z.core.$ZodIssue): string => {
  const field = issue.path.map(String).join('.');
  return field === '' ? issue.message : `${field} ${issue.message}`;
};

/** Fields the input does not know are dropped. The message names each field that is wrong. */
export function parseVerifyRequest(
  body: unknown,
): { ok: true; input: VerifyInput; check_id?: string } | { ok: false; message: string } {
  const parsed = verifyRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, message: `Invalid input: ${parsed.error.issues.map(describeIssue).join(', ')}` };
  }
  const { check_id, ...input } = parsed.data;
  return check_id === undefined ? { ok: true, input } : { ok: true, input, check_id };
}
