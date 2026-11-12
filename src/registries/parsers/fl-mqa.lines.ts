import { toText } from '../../text';
import type { Fields, Reading } from '../../types';
import { statusFor } from '../status-tables';

// Reader 2 for Florida MQA record pages. It works on the visible text of the page
// (toText), one line per block, and finds each value by its label. A label is either
// on the same line as its value ("License Number: ME000000") or alone on a line with
// the value on the next line ("License Status" / "Clear/Active").

interface Hit {
  value: string;
  line: string; // the page line the value came from, quoted for the reading
}

/**
 * Labels this page prints. A value cell is never another label, so a blank cell
 * reads as missing instead of taking the next label as its value.
 */
const PAGE_LABELS = new Set([
  'Printer Friendly Version',
  'Profession',
  'License',
  'License Status',
  'Qualifications',
  'License Expiration Date',
  'License Original Issue Date',
  'Address of Record',
  'Controlled Substance Prescriber (for the Treatment of Chronic Non-malignant Pain)',
  'Discipline on File',
  'Public Complaint',
  'Alerts',
  'Enforcement Alert',
  'Other License',
  'Secondary Locations',
  'Discipline/Admin Action',
  'Practitioner Profile',
  'License Information',
  'Subordinate Practitioners',
]);

const isLabelLine = (line: string): boolean => PAGE_LABELS.has(line) || /^(?:License Number|Data As Of)\b/.test(line);

/**
 * Dates on the page are M/D/YYYY, with or without leading zeros. An impossible date
 * (2/30/2028) has no ISO form.
 */
function isoDate(raw: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (!m) return null;
  const year = Number(m[3]);
  const month = Number(m[1]);
  const day = Number(m[2]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
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

/**
 * The label stands alone on its line and the value is on the next line. If the next
 * line is another label, the value cell is empty and the field is missing.
 */
function nextLine(lines: string[], label: string): Hit | null {
  const at = lines.indexOf(label);
  if (at === -1 || at + 1 >= lines.length) return null;
  const value = lines[at + 1];
  if (isLabelLine(value)) return null;
  return { value, line: value };
}

/**
 * The address block under "Address of Record" has street lines, then "CITY, ST ZIP".
 * The city is read from the first line within three lines of the label with a two-letter
 * state and a ZIP code.
 */
const CITY_LINE = /^(.+?),\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?$/i;

function cityUnder(lines: string[], label: string): Hit | null {
  const at = lines.indexOf(label);
  if (at === -1) return null;
  for (let j = at + 1; j <= at + 3 && j < lines.length; j++) {
    const m = CITY_LINE.exec(lines[j]);
    if (m) return { value: m[1].trim(), line: lines[j] };
  }
  return null;
}

/**
 * Discipline actions: every "Enforcement Alert" line and every emergency order line
 * ("Emergency Restriction Order ...", "Emergency Suspension Order ..."), in page order,
 * with the full line text. Matched without regard to case.
 */
const ALERT = /^Enforcement Alert\b/i;
const EMERGENCY_ORDER = /^Emergency [A-Za-z ]+ Order\b/i;

function enforcementActions(lines: string[]): string[] {
  return lines.filter((line) => ALERT.test(line) || EMERGENCY_ORDER.test(line));
}

export function parseText(html: string): Reading {
  const lines = toText(html).split('\n');
  const warnings: string[] = [];

  // A missing label is recorded once, in the order the labels are read.
  const need = (label: string, hit: Hit | null): Hit | null => {
    if (hit === null) warnings.push(`label not found: ${label}`);
    return hit;
  };
  const date = (label: string, hit: Hit | null): string | null => {
    if (hit === null) return null;
    const iso = isoDate(hit.value);
    if (iso === null) warnings.push(`could not read date: ${label}`);
    return iso;
  };

  const name = need('Printer Friendly Version', nextLine(lines, 'Printer Friendly Version'));
  const licence = need('License Number', sameLine(lines, /^License Number\s*:\s*(.+)$/));
  const dataAsOf = need('Data As Of', sameLine(lines, /^Data As Of\s*:?\s+(.+)$/));
  const profession = need('Profession', nextLine(lines, 'Profession'));
  const status = need('License Status', nextLine(lines, 'License Status'));
  const expires = need('License Expiration Date', nextLine(lines, 'License Expiration Date'));
  const issued = need('License Original Issue Date', nextLine(lines, 'License Original Issue Date'));
  const discipline = need('Discipline on File', nextLine(lines, 'Discipline on File'));
  const complaint = need('Public Complaint', nextLine(lines, 'Public Complaint'));
  const city = cityUnder(lines, 'Address of Record');
  if (city === null) {
    warnings.push(
      lines.includes('Address of Record')
        ? 'no city under label: Address of Record'
        : 'label not found: Address of Record',
    );
  }

  // Discipline actions: each Emergency order line listed on the page. An enforcement
  // alert label, when present, marks the record as having discipline too.
  const actions = enforcementActions(lines);
  const alert = lines.find((line) => ALERT.test(line)) ?? null;

  // discipline_flag is true when Discipline on File is Yes, Public Complaint is Yes,
  // or an enforcement alert or order is listed. Otherwise it is false when Discipline
  // on File is No.
  let disciplineFlag: boolean | null = null;
  let flagSource: string | null = null;
  const disciplineYes = discipline !== null && /^yes\b/i.test(discipline.value);
  const complaintYes = complaint !== null && /^yes\b/i.test(complaint.value);
  if (disciplineYes) flagSource = discipline.line;
  else if (complaintYes) flagSource = complaint.line;
  else if (actions.length > 0) flagSource = actions[0];
  else if (alert !== null) flagSource = alert;
  if (flagSource !== null) {
    disciplineFlag = true;
  } else if (discipline !== null && /^no\b/i.test(discipline.value)) {
    disciplineFlag = false;
    flagSource = discipline.line;
  } else if (discipline !== null) {
    warnings.push('could not read: Discipline on File');
  }

  const fields: Fields = {
    name: name?.value ?? null,
    licence_number: licence?.value ?? null,
    status_raw: status?.value ?? null,
    status: status === null ? null : statusFor('fl-mqa', status.value),
    expires: date('License Expiration Date', expires),
    issued: date('License Original Issue Date', issued),
    licence_type: profession?.value ?? null,
    discipline_flag: disciplineFlag,
    discipline_actions: actions,
    data_as_of: date('Data As Of', dataAsOf),
    city: city?.value ?? null,
    other_names: [],
  };

  // One quote per non-null scalar field, in field order: the page line the value came
  // from. The discipline flag is quoted from the line that set it.
  const sources: [unknown, string | null][] = [
    [fields.name, name?.line ?? null],
    [fields.licence_number, licence?.line ?? null],
    [fields.status_raw, status?.line ?? null],
    [fields.status, status?.line ?? null],
    [fields.expires, expires?.line ?? null],
    [fields.issued, issued?.line ?? null],
    [fields.licence_type, profession?.line ?? null],
    [fields.discipline_flag, flagSource],
    [fields.data_as_of, dataAsOf?.line ?? null],
    [fields.city, city?.line ?? null],
  ];
  const quotes = sources.flatMap(([value, line]) => (value !== null && line !== null ? [line] : []));

  return { reader: 'parser_text', fields, quotes, warnings };
}
