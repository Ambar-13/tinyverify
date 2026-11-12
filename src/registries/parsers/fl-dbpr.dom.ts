/**
 * Reader 1 for Florida DBPR licence pages: reads the saved HTML with node-html-parser. The registry has two layouts.
 * Pages captured from 2021 to 2024 use a table, with labels that end in a colon ("Status:") and values in the next
 * cell. The 2026 page uses <label> tags with the value in the next <div>. Both are read here, by finding the label
 * and taking the element right after it. It shares no code with the lines reader (tests/independence.test.ts enforces
 * it), so it keeps its own date reader.
 */
import { parse, type HTMLElement } from 'node-html-parser';
import { MAX_HTML_CHARS } from '../../text';
import type { Fields, Reading } from '../../types';
import { statusFor } from '../status-tables';

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** M/D/YYYY or MM/DD/YYYY, as the registry prints dates, to YYYY-MM-DD. Null when unreadable. */
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

/** A label cell's text without the trailing colon the older layout adds. */
const labelText = (el: HTMLElement): string => norm(el.text).replace(/:$/, '').trim();

/** The cells that can hold a label in either layout. */
const LABEL_CELLS = 'label, td, th, dt';

/** The line shaped "CITY ST 00000" or "CITY, ST 00000", with the state as a code or as Florida. */
const CITY_LINE = /^(.+?),?\s+([A-Z]{2}|Florida)\s+(\d{5}(?:-\d{4})?)$/i;

/** The lines of a value cell, with each <br> starting a new line. */
function linesOf(el: HTMLElement): string[] {
  return el.innerHTML
    .split(/<br\s*\/?>/i)
    .map((part) => norm(parse(part).text))
    .filter((line) => line !== '');
}

/** The label names carry "(Primary Name)" or "(DBA Name)" after the name itself. */
const NAME_TAG = /\s*\((?:Primary|DBA|Alternate) Name\)\s*$/i;

/**
 * TinyFish Fetch returns this page's content with no field labels: a "License Information" heading,
 * one <p> per value of the licensee block, a second "License Information" heading, and exactly six
 * <p> values (licence type, rank, number, status, licensure date, expiry date), in that order.
 * This reader takes them by position. It tells the Fetch form from the page's own HTML by the
 * structure: two such headings and none of the labels the page's own HTML has.
 * The Fetch form spells the state out ("DESTIN Florida 32541"), so its city line allows any state name.
 */
const FETCH_CITY_LINE =
  /^(.+?),?\s+(?:[A-Z]{2}|Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia|Puerto Rico)\s+\d{5}(?:-\d{4})?$/i;
const FETCH_FIELD_COUNT = 6;
const OWN_LABELS = ['License Number', 'Status', 'Licensure Date', 'License Type'];
const BR = /<br\s*\/?>/i;

/** The <p> elements that follow a heading, up to the next <h6>. */
function paragraphsAfter(heading: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  let el = heading.nextElementSibling;
  while (el && el.tagName !== 'H6') {
    if (el.tagName === 'P') out.push(el);
    el = el.nextElementSibling;
  }
  return out;
}

function parseFetchForm(heads: HTMLElement[]): Reading {
  const warnings: string[] = [];
  const quotes: string[] = [];
  const empty: Fields = {
    name: null,
    licence_number: null,
    status_raw: null,
    status: null,
    expires: null,
    issued: null,
    licence_type: null,
    discipline_flag: null,
    discipline_actions: [],
    data_as_of: null,
    city: null,
    other_names: [],
  };
  const second = paragraphsAfter(heads[1]).map((p) => norm(p.text));
  if (second.length !== FETCH_FIELD_COUNT) {
    return { reader: 'parser_html', fields: empty, quotes, warnings: ['unexpected field count'] };
  }
  const [licenceType, , licenceNumber, statusRaw, issuedRaw, expiresRaw] = second;
  const issued = isoDate(issuedRaw);
  const expires = isoDate(expiresRaw);
  if (issued === null) warnings.push('unreadable date: Licensure Date');
  if (expires === null) warnings.push('unreadable date: Expires');

  const first = paragraphsAfter(heads[0]);
  const rawName = first[0] ? norm(first[0].text) : '';
  const name = rawName === '' ? null : rawName.replace(NAME_TAG, '').trim();
  if (name === null) warnings.push('value not found: Name');
  const cityP = first
    .filter((p) => !BR.test(p.innerHTML))
    .map((p) => ({ text: norm(p.text), m: FETCH_CITY_LINE.exec(norm(p.text)) }))
    .find((x) => x.m !== null);
  const city = cityP?.m ? cityP.m[1].trim() : null;
  if (city === null) warnings.push('value not found: Main Address city');
  // A business name sits second, ahead of the address block. Without one the second paragraph is the street.
  const otherNames: string[] = [];
  if (first.length > 2 && !BR.test(first[1].innerHTML) && BR.test(first[2].innerHTML)) {
    const business = norm(first[1].text);
    if (business !== '') otherNames.push(business);
  }

  for (const q of [
    rawName,
    licenceType,
    licenceNumber,
    statusRaw,
    issuedRaw,
    expiresRaw,
    cityP?.text ?? '',
    ...otherNames,
  ]) {
    if (q !== '') quotes.push(q);
  }
  const fields: Fields = {
    ...empty,
    name,
    licence_number: licenceNumber === '' ? null : licenceNumber,
    status_raw: statusRaw === '' ? null : statusRaw,
    status: statusRaw === '' ? null : statusFor('fl-dbpr', statusRaw),
    expires,
    issued,
    licence_type: licenceType === '' ? null : licenceType,
    city,
    other_names: otherNames,
  };
  return { reader: 'parser_html', fields, quotes, warnings };
}

export function parseHtml(html: string): Reading {
  // The older pages leave a <b> open when they close a <font>, which swallows the next row.
  // Closing the <b> first keeps each label and value in its own cell.
  const capped = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  const root = parse(capped.replace(/<b>([^<]*)<\/font>/gi, '<b>$1</b></font>'));
  const warnings: string[] = [];
  const quotes: string[] = [];
  const cells = root.querySelectorAll(LABEL_CELLS);

  const heads = root.querySelectorAll('h6').filter((h) => labelText(h) === 'License Information');
  if (heads.length === 2 && !cells.some((c) => OWN_LABELS.includes(labelText(c)))) return parseFetchForm(heads);

  // The value cell after the first label that matches one of the wordings.
  const valueCell = (wordings: string[]): HTMLElement | null => {
    const cell = cells.find((c) => wordings.includes(labelText(c)));
    return cell?.nextElementSibling ?? null;
  };

  // The text of a labelled value, or null with a warning naming the label.
  const valueOf = (label: string, wordings: string[] = [label]): string | null => {
    const cell = valueCell(wordings);
    if (!cell) {
      warnings.push(`label not found: ${label}`);
      return null;
    }
    const value = norm(cell.text);
    if (value === '') {
      warnings.push(`value not found: ${label}`);
      return null;
    }
    return value;
  };

  const dateOf = (label: string, wordings: string[] = [label]): string | null => {
    const value = valueOf(label, wordings);
    if (value === null) return null;
    const iso = isoDate(value);
    if (!iso) {
      warnings.push(`unreadable date: ${label}`);
      return null;
    }
    quotes.push(value);
    return iso;
  };

  const rawName = valueOf('Name');
  const name = rawName === null ? null : rawName.replace(NAME_TAG, '').trim();
  if (rawName !== null) quotes.push(rawName);

  const licenceNumber = valueOf('License Number');
  if (licenceNumber !== null) quotes.push(licenceNumber);

  const statusRaw = valueOf('Status');
  if (statusRaw !== null) quotes.push(statusRaw);

  const licenceType = valueOf('License Type');
  if (licenceType !== null) quotes.push(licenceType);

  const expires = dateOf('Expires', ['Expires', 'Expiration Date']);
  const issued = dateOf('Licensure Date');

  // The city is the last address line shaped "CITY ST 00000".
  let city: string | null = null;
  const address = valueCell(['Main Address']);
  if (!address) {
    warnings.push('label not found: Main Address');
  } else {
    const found = linesOf(address)
      .map((line) => ({ line, m: CITY_LINE.exec(line) }))
      .filter((x) => x.m !== null)
      .pop();
    if (found?.m) {
      city = found.m[1].trim();
      quotes.push(found.line);
    } else {
      warnings.push('value not found: Main Address city');
    }
  }

  // Other names: the DBA name, and any alternate names. The older layout tags each
  // name in its value cell, the 2026 layout puts them under an "Alternate Names" heading.
  // Each other name is quoted as it reads on the page, tag included.
  const otherNames: string[] = [];
  const addOther = (visible: string): void => {
    const n = visible.replace(NAME_TAG, '').trim();
    if (n === '' || otherNames.includes(n)) return;
    otherNames.push(n);
    quotes.push(visible);
  };
  const dba = valueCell(['DBA Name']);
  if (dba && norm(dba.text) !== '') addOther(norm(dba.text));
  for (const el of root.querySelectorAll('td, div, dd')) {
    if (el.querySelectorAll('td, div').length > 0) continue;
    const text = norm(el.text);
    if (/\((?:DBA|Alternate) Name\)$/i.test(text)) addOther(text);
  }
  const heading = root.querySelectorAll('h6').find((h) => labelText(h) === 'Alternate Names');
  if (heading?.nextElementSibling) {
    for (const el of heading.nextElementSibling.querySelectorAll('.col-sm-8')) {
      const text = norm(el.text);
      if (text !== '') addOther(text);
    }
  }

  const fields: Fields = {
    name,
    licence_number: licenceNumber,
    status_raw: statusRaw,
    status: statusRaw === null ? null : statusFor('fl-dbpr', statusRaw),
    expires,
    issued,
    licence_type: licenceType,
    // This page has no discipline field, so the flag stays null and the list empty.
    discipline_flag: null,
    discipline_actions: [],
    data_as_of: null,
    city,
    other_names: otherNames,
  };

  return { reader: 'parser_html', fields, quotes, warnings };
}
