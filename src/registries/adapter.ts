/**
 * The interface every registry adapter fills in. Registers differ in how they are searched, how a record is opened
 * and how discipline is shown, so each of those parts is a choice between the ways that exist. An adapter holds no
 * state and does no I/O: it describes the register and reads its pages.
 */

import type { Candidate, Fields, RecordType, RegistryId, Reading, Status } from '../types';
import type { RegistryInfo } from './catalog';

/** A row of a register's results list, before it is scored against the query. */
export type SearchRow = Omit<Candidate, 'score' | 'reasons' | 'candidate_id'>;

/** What a search is asked to find. */
export interface AdapterQuery {
  name?: string;
  licence_number?: string;
  type: RecordType;
  city?: string;
  /** Asks for the second pass, which tries the register's other spellings of the name. */
  alternate?: boolean;
  /** Asks for the goal that has the agent copy the rows into its answer. */
  copy_rows?: boolean;
}

/** The register's search is a form, so an agent run works it. */
export interface AgentSearch {
  kind: 'agent';
  start_url: string;
  goal(q: AdapterQuery): string;
  output_schema: object;
  max_steps: number;
  /**
   * True when the goal asks the agent to say which kind of page came up: record, results, none, error,
   * captcha or sign_in. See lookup/search-page.ts.
   */
  reports_page?: true;
  /**
   * Only on adapters with rowsFromSnapshot. For a query where applies is true, goal() stops the agent at the
   * results page and the run answers in this schema without copying rows; code reads the rows from the run's
   * page snapshot. A query with copy_rows set gets the row-copying goal instead.
   */
  snapshot?: {
    applies(q: Pick<AdapterQuery, 'name' | 'licence_number' | 'copy_rows'>): boolean;
    output_schema: object;
    max_steps: number;
  };
}

/** The register's results list has a link of its own, so it is fetched. */
export interface FetchSearch {
  kind: 'fetch';
  url(q: Pick<AdapterQuery, 'name' | 'licence_number' | 'type' | 'city'>): string;
}

/** A record has a stable link, built from the ids a search row carries. */
export interface LinkRecord {
  kind: 'link';
  url(link: Record<string, string>): string;
}

/** A record has no stable link, so an agent run opens it. */
export interface AgentRecord {
  kind: 'agent';
  start_url: string;
  goal(licence_number: string): string;
  output_schema: object;
  max_steps: number;
  /** The link a person would use to look this licence up by hand. */
  source_lookup(licence_number: string): string;
}

/** Where a register shows discipline. */
export type DisciplineRoute =
  /** The record says whether discipline exists, and a second page lists it. */
  | { kind: 'flag_then_fetch'; url(link: Record<string, string>, flags: Record<string, boolean>): string }
  /** Complaints sit behind a button, so a second agent run reads them. */
  | { kind: 'agent_second_run'; goal(link: Record<string, string>): string; output_schema: object }
  /** The record page itself shows it. */
  | { kind: 'on_page' };

export interface Adapter {
  id: RegistryId;
  version: string;
  info: RegistryInfo;

  search: AgentSearch | FetchSearch;
  record: LinkRecord | AgentRecord;
  discipline: DisciplineRoute;

  /** Every status wording the register publishes, mapped to one of the ten statuses. */
  statusTable: Record<string, Status>;

  /** Reader 1: walks the page structure. Lives in parsers/<id>.dom.ts. */
  parseHtml(html: string): Reading;
  /** Reader 2: reads the page's text lines. Lives in parsers/<id>.lines.ts. */
  parseText(html: string): Reading;
  /** Reader 3: the fields as an agent run reported them. */
  fieldsFromAgent(output: unknown): Reading;

  /** The rows an agent copied into its answer. */
  rowsFromAgent(output: unknown): SearchRow[];
  /**
   * The first page of a results list, read by code from a run's page snapshot, with the count the page itself
   * states. Null when the page is not a results list.
   */
  rowsFromSnapshot?(html: string): { rows: SearchRow[]; total: number | null } | null;
  /** The rows of a fetched results list. Only on adapters whose search is fetched. */
  rowsFromFetchHtml?(html: string): SearchRow[];
  /** False when a search row belongs to another profession than the one asked. */
  ofType?(row: SearchRow, q: Pick<AdapterQuery, 'name' | 'type'>): boolean;

  /** One line per row of the register's enforcement page. Null when the page could not be parsed. */
  parseDisciplinePage?(html: string): string[] | null;
  /** The rows of the register's complaint view. Null when the page is not that view. */
  complaintRows?(html: string): { case_number: string; status: string; date: string; description: string }[] | null;
  /** The same view read from its text lines by a second reader. Null when the text is not that view. */
  complaintLines?(html: string): { case_number: string; status: string }[] | null;

  /** Warnings this register attaches to a record both readers agreed on, such as a missing expiry date. */
  recordWarnings?(fields: Fields): string[];
  /** When the register's planned offline window ends, or null when it is not in one. */
  maintenanceUntil(now: Date): string | null;
}
