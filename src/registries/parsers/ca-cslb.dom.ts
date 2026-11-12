/**
 * Reader 1 for California CSLB licence detail pages: reads the saved HTML with node-html-parser. It shares no code
 * with the lines reader (tests/independence.test.ts enforces it), so the date rule is kept here and not taken from
 * shared.ts.
 */
import { parse, type HTMLElement } from 'node-html-parser';
import { MAX_HTML_CHARS } from '../../text';
import type { Fields, Reading, Status } from '../../types';
import { statusFor } from '../status-tables';

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The text of an element with its entities decoded and its whitespace collapsed. */
const plain = (html: string): string => norm(parse(html).text);

/** M/D/YYYY or MM/DD/YYYY, as the board prints dates, to YYYY-MM-DD. Null when unreadable. */
export function isoDate(raw: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(norm(raw));
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** A label in its own cell, with the value in the next cell of the same row (Issue Date, Expire Date). */
function cellAfterLabel(root: HTMLElement, label: string): string | null {
  const td = root.querySelectorAll('td').find((c) => norm(c.text) === label);
  if (!td) return null;
  const next = td.nextElementSibling;
  if (!next || next.tagName !== 'TD') return null;
  return norm(next.text);
}

/**
 * A heading row (an h2 or a bold cell) with the value in the first cell of the row after it.
 * Rows are taken in document order, because the board's tables do not nest cleanly enough
 * for the sibling links of the tree to be trusted.
 */
function cellBelowHeading(root: HTMLElement, label: string): HTMLElement | null {
  const rows = root.querySelectorAll('tr');
  const cellsOf = (tr: HTMLElement): HTMLElement[] =>
    tr.childNodes.filter((n): n is HTMLElement => n.nodeType === 1 && 'tagName' in n);
  const index = rows.findIndex((tr) =>
    cellsOf(tr).some(
      (c) =>
        (c.tagName === 'TD' && norm(c.text) === label) || c.querySelectorAll('h2').some((h) => norm(h.text) === label),
    ),
  );
  if (index < 0 || index + 1 >= rows.length) return null;
  const value = cellsOf(rows[index + 1]).find((c) => c.tagName === 'TD');
  return value ?? null;
}

export function parseHtml(html: string): Reading {
  const warnings: string[] = [];
  const quotes: string[] = [];
  const capped = html.length > MAX_HTML_CHARS;
  if (capped) warnings.push('input over the size cap was cut');
  const root = parse(capped ? html.slice(0, MAX_HTML_CHARS) : html);

  // Licence number: the heading "Contractor's License Detail for License #" carries the number after it.
  const LICENCE_LABEL = "Contractor's License Detail for License #";
  let licence: string | null = null;
  const heading = root.querySelectorAll('h1').find((h) => norm(h.text).startsWith('Contractor'));
  if (heading) {
    const after = norm(heading.text).split('License #')[1];
    licence = after && norm(after) !== '' ? norm(after) : null;
  }
  if (licence === null) warnings.push(`label not found: ${LICENCE_LABEL}`);
  else quotes.push(`${LICENCE_LABEL} ${licence}`);

  // Business information: the first line of the cell is the business name; the line
  // shaped "CITY, CA 00000" gives the city.
  let name: string | null = null;
  let city: string | null = null;
  const bus = cellBelowHeading(root, 'Business Information');
  if (!bus) {
    warnings.push('label not found: Business Information');
  } else {
    // The first line before the first line break is the name. An empty first line means no name,
    // and the address line is never taken as the name.
    const parts = bus.innerHTML.split(/<br\s*\/?>/i).map(plain);
    name = parts[0] !== '' ? (parts[0] ?? null) : null;
    if (name === null) warnings.push('value not found: business name');
    const lines = parts.slice(1).filter((l) => l !== '');
    const cityLine = lines.find((l) => /^.+,\s*CA\s+\d{5}(-\d{4})?$/.test(l));
    if (cityLine) {
      city = cityLine.replace(/,\s*CA\s+\d{5}(-\d{4})?$/, '');
      quotes.push(cityLine);
    } else {
      warnings.push('value not found: Business Information city');
    }
    if (name !== null) quotes.push(name);
  }

  const dateField = (label: string): string | null => {
    const value = cellAfterLabel(root, label);
    if (value === null) {
      warnings.push(`label not found: ${label}`);
      return null;
    }
    const iso = isoDate(value);
    if (!iso) {
      warnings.push(`unreadable date: ${label}`);
      return null;
    }
    quotes.push(value);
    return iso;
  };
  const expires = dateField('Expire Date');
  const issued = dateField('Issue Date');

  // Status: the first bold line of the License Status block.
  let statusRaw: string | null = null;
  let status: Status | null = null;
  const statusCell = cellBelowHeading(root, 'License Status');
  if (!statusCell) {
    warnings.push('label not found: License Status');
  } else {
    const bold = statusCell.querySelector('strong');
    statusRaw = bold ? norm(bold.text) : null;
    if (statusRaw === null || statusRaw === '') {
      statusRaw = null;
      warnings.push('value not found: License Status');
    } else {
      status = statusFor('ca-cslb', statusRaw);
      if (status === 'other') warnings.push(`unknown license status: ${statusRaw}`);
      quotes.push(statusRaw);
    }
  }

  // Classifications: each linked classification, joined with ", ".
  let licenceType: string | null = null;
  const classes = cellBelowHeading(root, 'Classifications');
  if (!classes) {
    warnings.push('label not found: Classifications');
  } else {
    const items = classes
      .querySelectorAll('a')
      .map((a) => plain(a.innerHTML))
      .filter((t) => t !== '');
    const fallback = plain(classes.innerHTML);
    const list = items.length > 0 ? items : fallback ? [fallback] : [];
    if (list.length > 0) {
      licenceType = list.join(', ');
      // The page writes the links back to back, so the quote is the first classification.
      quotes.push(list[0]);
    } else {
      warnings.push('value not found: Classifications');
    }
  }

  // Discipline is null until the License Status block is read. Then it is false, unless the
  // Additional Status block points to a complaint disclosure, which makes it true. The case
  // lines sit on the board's complaint page, which this reader does not open, so the actions
  // stay empty. The board's markup leaves a span open in this block, which drops the block from
  // the tree, so the block is read as the text between its label and the Classifications label.
  let discipline: boolean | null = null;
  let pointer: string | null = null;
  const pageText = norm(root.text);
  if (statusRaw !== null) {
    discipline = false;
    const LABEL = 'Additional Status';
    const at = pageText.indexOf(LABEL);
    if (at >= 0) {
      const next = pageText.indexOf('Classifications', at);
      const block = pageText.slice(at + LABEL.length, next > at ? next : undefined);
      const hit =
        /There is Complaint Disclosure information[^.]*\./.exec(block) ??
        /[^.]*Complaint Disclosure information[^.]*\./.exec(block);
      if (hit) {
        discipline = true;
        pointer = norm(hit[0]);
      }
    }
    // A false flag is evidenced by the License Status line; a true flag by the disclosure pointer.
    if (discipline) quotes.push(pointer as string);
    else quotes.push(statusRaw);
  }

  // The board's extract date: "Data current as of M/D/YYYY ..." sits in a span hidden from screen readers.
  let dataAsOf: string | null = null;
  const extract = /Data current as of (\d{1,2}\/\d{1,2}\/\d{4})/.exec(pageText);
  if (!extract) {
    warnings.push('label not found: Data current as of');
  } else {
    dataAsOf = isoDate(extract[1]);
    if (dataAsOf) quotes.push(`Data current as of ${extract[1]}`);
    else warnings.push('unreadable date: Data current as of');
  }

  const fields: Fields = {
    name,
    licence_number: licence,
    status_raw: statusRaw,
    status,
    expires,
    issued,
    licence_type: licenceType,
    discipline_flag: discipline,
    discipline_actions: [],
    data_as_of: dataAsOf,
    city,
    other_names: [],
  };

  return { reader: 'parser_html', fields, quotes, warnings };
}
