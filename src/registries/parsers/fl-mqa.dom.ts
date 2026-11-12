/**
 * Reader 1 for Florida MQA licence pages: reads the saved HTML with node-html-parser. Discipline actions rule (the
 * text reader, fl-mqa.lines.ts, follows the same rule): discipline_actions lists every line under Alerts that says
 * "Enforcement Alert", and every line that says "Emergency <any words> Order", in page order, as the full line text.
 * discipline_flag is true when Discipline on File or Public Complaint is Yes, or an action exists. It shares no code
 * with the lines reader (tests/independence.test.ts enforces it), so it keeps its own date reader.
 */
import { parse, type HTMLElement } from 'node-html-parser';
import { MAX_HTML_CHARS } from '../../text';
import type { Fields, Reading } from '../../types';
import { statusFor } from '../status-tables';

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** M/D/YYYY or MM/DD/YYYY, as the registry prints dates, to YYYY-MM-DD. Null when unreadable. */
function isoDate(raw: string): string | null {
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

/**
 * The page's own HTML puts each label in a <dt>. The Fetch form (TinyFish's extracted content)
 * puts it in a <strong> instead. In both, the value is the next <dd>, so both are read here.
 */
const LABELS = 'dt, strong';
const isLabel = (el: HTMLElement): boolean => el.tagName === 'DT' || el.tagName === 'STRONG';

/** The value of a label is the next <dd> after it. */
function valueAfter(dt: HTMLElement): string | null {
  const dd = dt.nextElementSibling;
  if (!dd || dd.tagName !== 'DD') return null;
  return norm(dd.text);
}

/**
 * The address block runs over several <dt>/<dd> pairs, most of them with an empty label.
 * The city is the first line shaped "CITY, ST ZIP". The block ends at the next labelled <dt>.
 */
function cityAfter(dt: HTMLElement): { city: string; line: string } | null {
  let el = dt.nextElementSibling;
  while (el) {
    if (isLabel(el) && norm(el.text) !== '') break;
    if (el.tagName === 'DD') {
      const line = norm(el.text);
      const m = /^(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/.exec(line);
      if (m) return { city: m[1], line };
    }
    el = el.nextElementSibling;
  }
  return null;
}

/**
 * Discipline actions, one rule shared with the text reader (fl-mqa.lines.ts):
 * every line under the Alerts label that says "Enforcement Alert", and every line that says
 * "Emergency <any words> Order", in page order, as the full line text.
 * The walk under Alerts ends at the next labelled <dt>.
 */
const ACTION = /Enforcement Alert|\bEmergency\b.*\bOrder\b/i;

function alertLinesAfter(dt: HTMLElement): string[] {
  const lines: string[] = [];
  let el = dt.nextElementSibling;
  while (el) {
    if (isLabel(el) && norm(el.text) !== '') break;
    if (el.tagName === 'DD') {
      const t = norm(el.text);
      if (ACTION.test(t)) lines.push(t);
    }
    el = el.nextElementSibling;
  }
  return lines;
}

export function parseHtml(html: string): Reading {
  const root = parse(html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html);
  const warnings: string[] = [];
  const quotes: string[] = [];
  const dts = root.querySelectorAll(LABELS);

  const labelled = (label: string): { value: string } | null => {
    const dt = dts.find((d) => norm(d.text) === label);
    if (!dt) {
      warnings.push(`label not found: ${label}`);
      return null;
    }
    const value = valueAfter(dt);
    if (!value) {
      warnings.push(`value not found: ${label}`);
      return null;
    }
    return { value };
  };

  // A field is quoted only when it is not null, so each quote backs one field.
  const quoteOf = (label: string, value: string): void => {
    quotes.push(`${label} ${value}`);
  };

  const dateField = (label: string): string | null => {
    const hit = labelled(label);
    if (!hit) return null;
    const iso = isoDate(hit.value);
    if (!iso) {
      warnings.push(`unreadable date: ${label}`);
      return null;
    }
    quoteOf(label, hit.value);
    return iso;
  };

  // Name: the first heading that is not a "License Number:" line.
  let name: string | null = null;
  const heading = root.querySelectorAll('h3').find((h) => !/^License/i.test(norm(h.text)));
  if (heading && norm(heading.text) !== '') {
    name = norm(heading.text);
    quotes.push(name);
  } else {
    warnings.push('label not found: name');
  }

  // Data As Of sits in an <em> line, not in a label pair.
  let dataAsOf: string | null = null;
  const asOf = root.querySelectorAll('em').find((e) => /^Data As Of/i.test(norm(e.text)));
  if (asOf) {
    dataAsOf = isoDate(norm(asOf.text).replace(/^Data As Of/i, ''));
    if (dataAsOf) quotes.push(norm(asOf.text));
    else warnings.push('unreadable date: Data As Of');
  } else {
    warnings.push('label not found: Data As Of');
  }

  const licence = labelled('License');
  const status = labelled('License Status');
  const profession = labelled('Profession');
  const expires = dateField('License Expiration Date');
  const issued = dateField('License Original Issue Date');

  // Discipline. The flag is true when Discipline on File is Yes, Public Complaint is Yes,
  // or an enforcement alert or emergency order is listed. Every such line is one action, in page order.
  const disc = labelled('Discipline on File');
  const discYes = disc !== null && /^yes\b/i.test(disc.value);
  const discNo = disc !== null && /^no\b/i.test(disc.value);
  if (disc && !discYes && !discNo) warnings.push('unreadable value: Discipline on File');
  const complaint = labelled('Public Complaint');
  const complaintYes = complaint !== null && /^yes\b/i.test(complaint.value);
  const alertDt = dts.find((d) => norm(d.text) === 'Alerts');
  const alerts = alertDt ? alertLinesAfter(alertDt) : [];
  const discipline_actions = alerts;
  const action = alerts[0] ?? null;

  let discipline_flag: boolean | null = null;
  if (discYes || complaintYes || action !== null) discipline_flag = true;
  else if (discNo) discipline_flag = false;
  if (discYes) quoteOf('Discipline on File', disc.value);
  else if (complaintYes) quoteOf('Public Complaint', complaint.value);
  else if (action !== null) quotes.push(action);
  else if (discNo) quoteOf('Discipline on File', disc.value);
  if (licence) quoteOf('License', licence.value);
  if (status) quoteOf('License Status', status.value);
  if (profession) quoteOf('Profession', profession.value);

  let city: string | null = null;
  const address = dts.find((d) => norm(d.text) === 'Address of Record');
  if (!address) {
    warnings.push('label not found: Address of Record');
  } else {
    const found = cityAfter(address);
    if (found) {
      city = found.city;
      quotes.push(found.line);
    } else {
      warnings.push('value not found: Address of Record city');
    }
  }

  const fields: Fields = {
    name,
    licence_number: licence?.value ?? null,
    status_raw: status?.value ?? null,
    status: status ? statusFor('fl-mqa', status.value) : null,
    expires,
    issued,
    licence_type: profession?.value ?? null,
    discipline_flag,
    discipline_actions,
    data_as_of: dataAsOf,
    city,
    other_names: [],
  };

  return { reader: 'parser_html', fields, quotes, warnings };
}
