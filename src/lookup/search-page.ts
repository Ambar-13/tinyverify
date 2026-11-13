/**
 * Turns a search run's answer into a verdict: rows to score, the registry's own "no results", or a registry that did
 * not answer.
 */

import type { Adapter, SearchRow as Row } from '../registries/adapter';
import type { RecordType, UnavailableReason } from '../types';

/**
 * What a search run's `page` value says, for the adapters whose goals ask for one (search.reports_page).
 * The six values are record, results, none, error, captcha and sign_in. Only "none" is the registry saying that
 * nothing matched. An error, a captcha or a sign-in is a registry that did not answer, and an answer that gave
 * no usable rows, no page value, or a record address that does not parse is a page the code could not read.
 */
export type PageVerdict =
  { kind: 'rows' } | { kind: 'none' } | { kind: 'unavailable'; reason: UnavailableReason; message?: string };

/** The run's page value, trimmed and lower-cased. Null when the answer has none. */
export function pageOf(result: unknown): string | null {
  const page = (result as { page?: unknown } | null | undefined)?.page;
  return typeof page === 'string' ? page.trim().toLowerCase() : null;
}

/** Failures named by the page value alone. */
export function pageFailure(page: string | null): Extract<PageVerdict, { kind: 'unavailable' }> | null {
  if (page === 'error')
    return { kind: 'unavailable', reason: 'timeout', message: 'The registry showed an error or did not load.' };
  if (page === 'captcha') return { kind: 'unavailable', reason: 'captcha' };
  if (page === 'sign_in') return { kind: 'unavailable', reason: 'login_required' };
  return null;
}

/** The verdict on a run's answer, given how many rows the adapter read from it. */
export function judgeSearchAnswer(result: unknown, rowCount: number): PageVerdict {
  if (rowCount > 0) return { kind: 'rows' };
  const page = pageOf(result);
  if (page === 'none') return { kind: 'none' };
  return pageFailure(page) ?? { kind: 'unavailable', reason: 'layout_changed' };
}

/**
 * The candidate a link-finder answer names: the answer says the page is a record or says found, and carries an
 * address. The row carries the licence number that was asked for, never the one the agent echoes, and the link the
 * adapter parses from the address. The record read from that link has to show the same number. Null when the answer
 * is not a link-finder answer (it carries rows, or no address). An empty list is an address the adapter refuses.
 */
export function linkFinderRows(
  adapter: Pick<Adapter, 'rowsFromAgent'>,
  result: unknown,
  licence: string | undefined,
): Row[] | null {
  const answer = (result ?? {}) as { rows?: unknown; found?: unknown; url?: unknown };
  const hasRows = Array.isArray(answer.rows) && answer.rows.length > 0;
  if (hasRows || typeof answer.url !== 'string' || !(pageOf(result) === 'record' || answer.found === true)) return null;
  const rows = adapter.rowsFromAgent({ found: true, url: answer.url, rows: [] });
  return licence === undefined ? rows : rows.map((row) => ({ ...row, licence_number: licence }));
}

export type SearchQuery = {
  name?: string;
  licence_number?: string;
  type: RecordType;
  city?: string;
  alternate?: boolean;
  copy_rows?: boolean;
};

/** True when the search request for this query stops the agent at the page and asks for page snapshots. */
export function isSnapshotRequest(adapter: Adapter, q: SearchQuery): boolean {
  return (
    q.copy_rows !== true &&
    adapter.rowsFromSnapshot !== undefined &&
    adapter.search.kind === 'agent' &&
    adapter.search.snapshot?.applies(q) === true
  );
}

/**
 * The run request for one search pass of an agent-searched registry, and the steps it may take. A snapshot request
 * asks for the page snapshots and the page-value schema; any other request asks for the registry's own schema.
 */
export function searchRequest(
  adapter: Adapter,
  q: SearchQuery,
): {
  request: { url: string; goal: string; output_schema: object; capture_config?: { html: true } };
  max_steps: number;
} {
  const s = adapter.search;
  if (s.kind !== 'agent') throw new Error('searchRequest needs an agent search');
  if (isSnapshotRequest(adapter, q)) {
    return {
      request: {
        url: s.start_url,
        goal: s.goal(q),
        output_schema: s.snapshot?.output_schema ?? s.output_schema,
        capture_config: { html: true },
      },
      max_steps: s.snapshot?.max_steps ?? s.max_steps,
    };
  }
  // An adapter that asks for a page value can be answered "none", which is checked against the captured page.
  const capture = s.reports_page ? { capture_config: { html: true as const } } : {};
  return {
    request: { url: s.start_url, goal: s.goal(q), output_schema: s.output_schema, ...capture },
    max_steps: s.max_steps,
  };
}
