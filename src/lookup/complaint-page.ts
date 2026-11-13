import type { Adapter } from '../registries/adapter';
import type { RunStep, TinyFish } from '../tinyfish/client';
import { normaliseLicenceNumber } from '../registries/catalog';

export const COMPLAINT_NOT_TIED = 'complaint page not tied to the licence';

type ComplaintRow = { case_number: string; status: string; date: string; description: string };

/**
 * What the two readers of a captured complaint view made of it: the rows when they agree, or no rows when
 * they count different complaints or name different case numbers.
 */
export type ComplaintPage = { agree: true; rows: ComplaintRow[] } | { agree: false };

/**
 * Reads a captured page with both complaint readers of the adapter. Null when either reader does not take
 * the page for the complaint view, or the adapter has no second reader. Otherwise the two answers are
 * compared on the number of complaints and on the case numbers in order.
 */
export function readComplaintPage(
  adapter: Pick<Adapter, 'complaintRows' | 'complaintLines'> | undefined,
  html: string,
): ComplaintPage | null {
  const rows = adapter?.complaintRows?.(html) ?? null;
  const lines = adapter?.complaintLines?.(html) ?? null;
  if (rows === null || lines === null) return null;
  const agree = rows.length === lines.length && rows.every((row, i) => row.case_number === lines[i].case_number);
  return agree ? { agree: true, rows } : { agree: false };
}

/**
 * The longest walk seen on a live run took 7 reads. 12 leaves room for a run that stays on the view longer, and
 * keeps the walk well inside the Worker's limit on outgoing requests.
 */
const MAX_TIE_READS = 12;

/** The case numbers the two complaint readers take from one page, in order, as one comparable string. */
const casesRead = (rows: { case_number: string }[], lines: { case_number: string }[]): string =>
  JSON.stringify([rows.map((row) => row.case_number), lines.map((row) => row.case_number)]);

/**
 * True when the run shows that the complaint `view` belongs to `licence`. The view names nothing of its own (no
 * number, no record id), so it is tied through the run, going back from its step one capture at a time:
 * - an earlier capture of the view is passed over when both complaint readers read the same cases from it as from
 * `view`, because the agent stays on the view for several steps;
 * - the first other capture decides: the tie holds only if it is a licence record page (both record readers give
 * the same number) and the number is the licence being checked.
 * Everything else breaks the tie: a view that lists other cases or that only one reader takes for the view, a
 * results list, another licence, a page that cannot be read (404, empty), a step with no capture (the browser may
 * have moved unseen), or more than MAX_TIE_READS reads.
 */
export async function tiedToLicence(
  client: Pick<TinyFish, 'stepHtml'>,
  runId: string,
  steps: RunStep[],
  view: { step_id: string; html: string },
  adapter:
    Pick<Adapter, 'parseHtml' | 'parseText' | 'rowsFromSnapshot' | 'complaintRows' | 'complaintLines'> | undefined,
  licence: string,
): Promise<boolean> {
  if (adapter === undefined) return false;
  const viewRows = adapter.complaintRows?.(view.html) ?? null;
  const viewLines = adapter.complaintLines?.(view.html) ?? null;
  if (viewRows === null || viewLines === null) return false;
  const wanted = casesRead(viewRows, viewLines);
  let reads = 0;
  for (let i = steps.findIndex((step) => step.step_id === view.step_id) - 1; i >= 0; i -= 1) {
    if (steps[i].has_html === false) return false;
    reads += 1;
    if (reads > MAX_TIE_READS) return false;
    let html: string;
    try {
      html = await client.stepHtml(runId, steps[i].step_id);
    } catch {
      return false;
    }
    const rows = adapter.complaintRows?.(html) ?? null;
    const lines = adapter.complaintLines?.(html) ?? null;
    if (rows !== null || lines !== null) {
      if (rows !== null && lines !== null && casesRead(rows, lines) === wanted) continue;
      return false;
    }
    if (html === '' || adapter.rowsFromSnapshot?.(html) != null) return false;
    const first = adapter.parseHtml(html).fields.licence_number;
    const second = adapter.parseText(html).fields.licence_number;
    return first !== null && first === second && normaliseLicenceNumber(first) === normaliseLicenceNumber(licence);
  }
  return false;
}
