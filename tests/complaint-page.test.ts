import { describe, expect, it } from 'vitest';
import { tiedToLicence } from '../src/lookup/complaint-page';
import { TinyFishError, type RunStep } from '../src/tinyfish/client';

// Pages are written as "<html reader's number>|<text reader's number>", a results list as LIST and the complaint
// view as VIEW, or VIEW:A1,B2 when it lists cases A1 and B2. A number part of "-" is a reader that finds none.
const cases = (html: string) =>
  (html.includes(':') ? html.split(':')[1].split(',') : []).map((case_number) => ({
    case_number,
    status: '',
    date: '',
    description: '',
  }));
const adapter = {
  parseHtml: (html: string) => ({
    reader: 'parser_html' as const,
    fields: { licence_number: html.split('|')[0] === '-' ? null : (html.split('|')[0] ?? null) },
    quotes: [],
    warnings: [],
  }),
  parseText: (html: string) => ({
    reader: 'parser_text' as const,
    fields: { licence_number: html.split('|')[1] === '-' ? null : (html.split('|')[1] ?? null) },
    quotes: [],
    warnings: [],
  }),
  rowsFromSnapshot: (html: string) => (html === 'LIST' ? { rows: [], total: 0 } : null),
  // HALF is a view only the markup reader recognises.
  complaintRows: (html: string) => (html.startsWith('VIEW') ? cases(html) : html === 'HALF' ? [] : null),
  complaintLines: (html: string) => (html.startsWith('VIEW') ? cases(html) : null),
};

type Page = string | 404;
function tied(pages: Record<string, Page>, steps: RunStep[], licence = 'CCC1', view = 'VIEW'): Promise<boolean> {
  const client = {
    stepHtml: async (_run: string, step: string): Promise<string> => {
      const page = pages[step];
      if (page === 404) throw new TinyFishError('not_found', 404, 'gone');
      return page ?? '';
    },
  };
  return tiedToLicence(client, 'run_1', steps, { step_id: 'view', html: view }, adapter as never, licence);
}
const ids = (...names: string[]): RunStep[] => names.map((step_id) => ({ step_id }));

describe('tiedToLicence', () => {
  it('holds when the nearest earlier page with a capture is the record page of the licence', async () => {
    expect(await tied({ rec: 'CCC1|CCC1' }, ids('rec', 'view'))).toBe(true);
  });

  // Seen on a live run: record page on steps 1 to 3, the complaint view on steps 4 to 7.
  it('holds when earlier captures of the same complaint view sit between the view and the record page', async () => {
    const pages = { r1: 'CCC1|CCC1', r2: 'CCC1|CCC1', r3: 'CCC1|CCC1', v1: 'VIEW', v2: 'VIEW', v3: 'VIEW' };
    expect(await tied(pages, ids('r1', 'r2', 'r3', 'v1', 'v2', 'v3', 'view'))).toBe(true);
  });

  // Seen on a live run: three complaints listed on every capture of the view.
  it('holds when the earlier captures list the same cases in the same order', async () => {
    const pages = { rec: 'CCC1|CCC1', v1: 'VIEW:A1,B2,C3', v2: 'VIEW:A1,B2,C3' };
    expect(await tied(pages, ids('rec', 'v1', 'v2', 'view'), 'CCC1', 'VIEW:A1,B2,C3')).toBe(true);
  });

  // Seen on a live run: the agent went back to the record page and opened the view again.
  it('holds when the record page of the licence sits between two visits to the view', async () => {
    const pages = { r1: 'CCC1|CCC1', v1: 'VIEW', v2: 'VIEW', r2: 'CCC1|CCC1', v3: 'VIEW' };
    expect(await tied(pages, ids('r1', 'v1', 'v2', 'r2', 'v3', 'view'))).toBe(true);
  });

  it('is refused when the record page between two visits to the view is another licence', async () => {
    const pages = { r1: 'CCC1|CCC1', v1: 'VIEW', r2: 'CCC9|CCC9', v2: 'VIEW' };
    expect(await tied(pages, ids('r1', 'v1', 'r2', 'v2', 'view'))).toBe(false);
  });

  it('is refused when an earlier capture of the view lists different cases', async () => {
    const pages = { rec: 'CCC1|CCC1', v1: 'VIEW:A1', v2: 'VIEW:A1,B2' };
    expect(await tied(pages, ids('rec', 'v1', 'v2', 'view'), 'CCC1', 'VIEW:A1,B2')).toBe(false);
  });

  it('is refused when an earlier capture lists the same cases in another order', async () => {
    expect(await tied({ rec: 'CCC1|CCC1', v1: 'VIEW:B2,A1' }, ids('rec', 'v1', 'view'), 'CCC1', 'VIEW:A1,B2')).toBe(
      false,
    );
  });

  it('is refused when only one complaint reader takes an earlier capture for the view', async () => {
    expect(await tied({ rec: 'CCC1|CCC1', half: 'HALF', v: 'VIEW' }, ids('rec', 'half', 'v', 'view'))).toBe(false);
  });

  it('is refused when only one complaint reader takes the page being tied for the view', async () => {
    expect(await tied({ rec: 'CCC1|CCC1' }, ids('rec', 'view'), 'CCC1', 'HALF')).toBe(false);
  });

  it('is refused when the page before the views is the record page of another licence', async () => {
    expect(await tied({ rec: 'CCC9|CCC9', v1: 'VIEW', v2: 'VIEW' }, ids('rec', 'v1', 'v2', 'view'))).toBe(false);
  });

  it('is refused when a results list sits before the views', async () => {
    expect(await tied({ rec: 'CCC1|CCC1', list: 'LIST', v1: 'VIEW' }, ids('rec', 'list', 'v1', 'view'))).toBe(false);
  });

  it('is refused after 12 reads without reaching a deciding page', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `v${i + 1}`);
    const pages: Record<string, Page> = { rec: 'CCC1|CCC1' };
    for (const name of names) pages[name] = 'VIEW';
    expect(await tied(pages, ids('rec', ...names, 'view'))).toBe(false);
    expect(await tied(pages, ids('rec', ...names.slice(1), 'view'))).toBe(true);
  });

  it('is refused when that page is the record page of another licence', async () => {
    expect(await tied({ rec: 'CCC9|CCC9' }, ids('rec', 'view'))).toBe(false);
  });

  it('is refused when that page is a results list', async () => {
    expect(await tied({ rec: 'CCC1|CCC1', list: 'LIST' }, ids('rec', 'list', 'view'))).toBe(false);
  });

  it('is refused when that page answers 404, although the licence page lies before it', async () => {
    expect(await tied({ rec: 'CCC1|CCC1', gap: 404 }, ids('rec', 'gap', 'view'))).toBe(false);
  });

  it('is refused when that page is empty', async () => {
    expect(await tied({ rec: 'CCC1|CCC1', gap: '' }, ids('rec', 'gap', 'view'))).toBe(false);
  });

  it('is refused when the two record readers give different numbers on that page, although the licence page lies before it', async () => {
    expect(await tied({ rec: 'CCC1|CCC1', odd: 'CCC1|CCC2' }, ids('rec', 'odd', 'view'))).toBe(false);
  });

  it('is refused when only one reader finds a number on that page', async () => {
    expect(await tied({ rec: 'CCC1|CCC1', odd: 'CCC1|-' }, ids('rec', 'odd', 'view'))).toBe(false);
  });

  // Seen on 14 live runs: only the closing step has no capture, never a step before the view.
  it('is refused when a step with no capture lies between the view and the record page', async () => {
    const steps: RunStep[] = [{ step_id: 'rec' }, { step_id: 'a', has_html: false }, { step_id: 'view' }];
    expect(await tied({ rec: 'CCC1|CCC1' }, steps)).toBe(false);
  });

  it('is refused when no earlier step has a capture', async () => {
    const steps: RunStep[] = [{ step_id: 'a', has_html: false }, { step_id: 'view' }];
    expect(await tied({}, steps)).toBe(false);
  });
});
