import { toText } from '../../text';
import type { Fields, Reading } from '../../types';
import { statusFor } from '../status-tables';

// Reader 2 for California CSLB licence detail pages. It works on the visible text of the
// page (toText), one line per block, and finds each value by its label. On these pages a
// label stands alone on its line and its value is on the next line, or the label is part
// of the value's line ("Contractor's License Detail for License # 9000001").

interface Hit {
  value: string;
  line: string; // the page line the value came from, quoted for the reading
}

/** A value is never a label or a section note. A blank value shows as the next label. */
const LABELS = new Set([
  'Business Information',
  'Entity',
  'Issue Date',
  'Expire Date',
  'License Status',
  'Additional Status',
  'Classifications',
  'Bonding Information',
  "Workers' Compensation",
  'Other',
  'Is this your license?',
]);
const NOTES = new Set(['All information below should be reviewed.']);

const DISCLOSURE_SENTENCE = /^There is Complaint Disclosure information for this license\.?$/i;
const COMPLAINT_LINK = /^Click here for Complaint Disclosure information\.?$/i;

/** The business block has the name, an optional "dba" line, street lines, then "CITY, CA ZIP". */
const CITY_LINE = /^(.+?),\s*CA\s+\d{5}(?:-\d{4})?$/i;
const STREET_LINE = /^\d+\s/;

/**
 * Dates on the page are M/D/YYYY, with or without leading zeros. An impossible date
 * (30 February, 31 June) is not a date.
 */
function isoDate(raw: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (!m) return null;
  const year = Number(m[3]);
  const month = Number(m[1]);
  const day = Number(m[2]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The label and its value share a line. The first line that matches wins. */
function sameLine(lines: string[], pattern: RegExp): Hit | null {
  for (const line of lines) {
    const m = pattern.exec(line);
    if (m && m[1].trim() !== '') return { value: m[1].trim(), line };
  }
  return null;
}

interface Under {
  found: boolean; // the label is on the page
  hit: Hit | null; // its value, or null when the value is blank
}

/**
 * The label stands alone on its line and the value is on the next line. The next line
 * is taken only when it is an acceptable value, so a blank value never takes another label.
 */
function under(lines: string[], label: string, accept: (line: string) => boolean = () => true): Under {
  const at = lines.indexOf(label);
  if (at === -1) return { found: false, hit: null };
  const next = lines[at + 1];
  if (next === undefined || LABELS.has(next) || NOTES.has(next) || !accept(next)) {
    return { found: true, hit: null };
  }
  return { found: true, hit: { value: next, line: next } };
}

/** The lines under a label, up to the first line that starts another section. */
function blockAfter(lines: string[], label: string, stops: string[]): string[] {
  const at = lines.indexOf(label);
  if (at === -1) return [];
  const out: string[] = [];
  for (let j = at + 1; j < lines.length && !stops.includes(lines[j]); j++) out.push(lines[j]);
  return out;
}

const CLASS_STOPS = ['Bonding Information', "Workers' Compensation", 'Other', 'Is this your license?'];

/** The city is the first line under the label that ends in ", CA" and a ZIP, before the Entity line. */
function cityUnder(lines: string[], label: string): Hit | null {
  const at = lines.indexOf(label);
  if (at === -1) return null;
  for (let j = at + 1; j <= at + 5 && j < lines.length && lines[j] !== 'Entity'; j++) {
    const m = CITY_LINE.exec(lines[j]);
    if (m) return { value: m[1].trim(), line: lines[j] };
  }
  return null;
}

export function parseText(html: string): Reading {
  const lines = toText(html).split('\n');
  const warnings: string[] = [];

  // A label that is missing, or present with a blank value, is one warning, in reading order.
  const read = (label: string, u: Under): Hit | null => {
    if (!u.found) warnings.push(`label not found: ${label}`);
    else if (u.hit === null) warnings.push(`no value under: ${label}`);
    return u.hit;
  };
  const date = (label: string, hit: Hit | null): string | null => {
    if (hit === null) return null;
    // The data date carries a time after the date ("8/8/2020 5:08:31 PM"); only the date is kept.
    const iso = isoDate(hit.value.split(' ')[0]);
    if (iso === null) warnings.push(`could not read date: ${label}`);
    return iso;
  };

  const licence = sameLine(lines, /^Contractor.s License Detail for License #\s*(.+)$/i);
  if (licence === null) warnings.push("label not found: Contractor's License Detail for License #");

  const businessFound = lines.includes('Business Information');
  const name = read(
    'Business Information',
    under(lines, 'Business Information', (l) => !STREET_LINE.test(l) && !CITY_LINE.test(l)),
  );
  const city = cityUnder(lines, 'Business Information');
  if (city === null) {
    warnings.push(
      businessFound
        ? 'no value under: city under Business Information'
        : 'label not found: city under Business Information',
    );
  }

  const issued = read('Issue Date', under(lines, 'Issue Date'));
  const expires = read('Expire Date', under(lines, 'Expire Date'));
  const dataAsOf = sameLine(lines, /^Data current as of\s+(.+)$/i);
  if (dataAsOf === null) warnings.push('label not found: Data current as of');

  const statusUnder = under(lines, 'License Status');
  const status = read('License Status', statusUnder);

  const classes = blockAfter(lines, 'Classifications', CLASS_STOPS).filter((l) => l !== '');
  let types: Hit | null = null;
  if (!lines.includes('Classifications')) warnings.push('label not found: Classifications');
  else if (classes.length === 0) warnings.push('no value under: Classifications');
  else types = { value: classes.join(', '), line: classes.join('\n') };

  // Discipline reads the whole page for its two disclosure lines. It is null when the
  // License Status block is missing, false when the block is there and neither line is,
  // and true when either line is. A false flag quotes the block's own label line.
  let discipline: Hit | null = null;
  let disciplineFlag: boolean | null = null;
  if (statusUnder.found) {
    const sentence = lines.find((l) => DISCLOSURE_SENTENCE.test(l));
    const link = lines.find((l) => COMPLAINT_LINK.test(l));
    const flagged = sentence ?? link;
    if (flagged !== undefined) {
      disciplineFlag = true;
      discipline = { value: flagged, line: flagged };
    } else {
      disciplineFlag = false;
      discipline = { value: 'License Status', line: 'License Status' };
    }
  }

  const fields: Fields = {
    name: name?.value ?? null,
    licence_number: licence?.value ?? null,
    status_raw: status?.value ?? null,
    status: status === null ? null : statusFor('ca-cslb', status.value),
    expires: date('Expire Date', expires),
    issued: date('Issue Date', issued),
    licence_type: types?.value ?? null,
    discipline_flag: disciplineFlag,
    discipline_actions: [],
    data_as_of: date('Data current as of', dataAsOf),
    city: city?.value ?? null,
    other_names: [],
  };

  // One quote per field that came from a page line, in field order.
  const sources: [unknown, Hit | null][] = [
    [fields.name, name],
    [fields.licence_number, licence],
    [fields.status_raw, status],
    [fields.status, status],
    [fields.expires, expires],
    [fields.issued, issued],
    [fields.licence_type, types],
    [fields.discipline_flag, discipline],
    [fields.data_as_of, dataAsOf],
    [fields.city, city],
  ];
  const quotes = sources.flatMap(([value, hit]) => (value !== null && hit !== null ? [hit.line] : []));

  return { reader: 'parser_text', fields, quotes, warnings };
}
