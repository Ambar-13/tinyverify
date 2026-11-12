import { toText } from '../../text';
import type { Fields, Reading } from '../../types';
import { statusFor } from '../status-tables';

// Reader 2 for Florida DBPR licence pages. It works on the visible text of the page
// (toText), one line per block, and finds each value by its label. A label stands alone
// on its line, with a colon on the older layout ("Status:") and without one on the newer
// ("Status"), and its value is on the next line. Names and the DBA carry their own tag
// on the same line ("SAMPLE, PERSON A (Primary Name)").

interface Hit {
  value: string;
  line: string; // the page line the value came from, quoted for the reading
}

/**
 * Dates on the page are MM/DD/YYYY, with or without leading zeros. A date that does not
 * exist on the calendar (02/30/2024) gives null.
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

/** A label line, with any trailing colon taken off, so "Status:" and "Status" match alike. */
const bare = (line: string): string => line.replace(/:\s*$/, '').trim();

/** The two labels the expiry row can carry, in the order they are preferred. */
const EXPIRY_LABELS = ['Expires', 'Expiration Date'];

/**
 * Labels on these pages. A line that is one of them is never read as a value, so an
 * empty value (no DBA, say) does not pick up the next label.
 */
const LABELS = new Set([
  'Name',
  'DBA Name',
  'Main Address',
  'County',
  'License Location',
  'License Information',
  'License Type',
  'Rank',
  'License Number',
  'Status',
  'Licensure Date',
  'Expires',
  'Expiration Date',
  'Alternate Names',
  'Special Qualifications',
]);

/** The label stands alone on its line and the value is on the next line. */
function nextLine(lines: string[], labels: string[]): Hit | null {
  const at = lines.findIndex((line) => labels.includes(bare(line)));
  if (at === -1 || at + 1 >= lines.length) return null;
  const value = lines[at + 1];
  if (LABELS.has(bare(value))) return null;
  return { value, line: value };
}

/** A name line carries its tag in brackets, e.g. "SAMPLE, PERSON A (Primary Name)". */
function tagged(lines: string[], tag: string): Hit | null {
  const pattern = new RegExp(`^(.+?)\\s*\\(${tag}\\)$`, 'i');
  for (const line of lines) {
    const m = pattern.exec(line);
    if (m && m[1].trim() !== '') return { value: m[1].trim(), line };
  }
  return null;
}

/**
 * The address block under "Main Address" has street lines, then "CITY, ST ZIP" (or
 * "CITY Florida ZIP" on the older layout). Any two-letter state is accepted. The city is
 * the first line within three lines of the label that ends in a state and a ZIP.
 */
const CITY_LINE = /^(.+?),?\s+(?:[A-Za-z]{2}|Florida)\s+\d{5}(?:-\d{4})?$/i;

function cityUnder(lines: string[], label: string): Hit | null {
  const at = lines.findIndex((line) => bare(line) === label);
  if (at === -1) return null;
  for (let j = at + 1; j <= at + 3 && j < lines.length; j++) {
    const m = CITY_LINE.exec(lines[j]);
    if (m) return { value: m[1].trim().replace(/,$/, ''), line: lines[j] };
  }
  return null;
}

/**
 * The alternate names sit between the "Alternate Names" label and the "View ..." links
 * that follow it. An empty block gives no names.
 */
function alternateNames(lines: string[]): Hit[] {
  const at = lines.findIndex((line) => bare(line) === 'Alternate Names');
  if (at === -1) return [];
  const out: Hit[] = [];
  for (let j = at + 1; j < lines.length && j <= at + 10 && !/^View\b/i.test(lines[j]); j++) {
    const value = lines[j].replace(/\s*\((?:Alternate|Alt)[^)]*\)\s*$/i, '').trim();
    if (value !== '') out.push({ value, line: lines[j] });
  }
  return out;
}

/**
 * The Fetch form (TinyFish's extracted content) has no field labels. This reader finds each value
 * by its pattern in the second "License Information" section, which ends at "Special Qualifications":
 * the licence number by the shape of a licence number, the status as a line the status table
 * recognises or a word-comma-word line, the dates as MM/DD/YYYY lines (the later is the expiry).
 * A pattern that matches no line, or more than one, gives null with a warning.
 * The Fetch form spells the state out ("DESTIN Florida 32541"), so its city line allows any state name.
 */
const FETCH_CITY_LINE =
  /^(.+?),?\s+(?:[A-Z]{2}|Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia|Puerto Rico)\s+\d{5}(?:-\d{4})?$/i;
const LICENCE_SHAPE = /^[A-Z]{1,4}\d{4,10}$/;
const DATE_LINE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const WORD_COMMA_WORD = /^[A-Za-z]+,[A-Za-z]+$/;
const OWN_LABELS = ['License Number', 'Status', 'Licensure Date', 'License Type'];

function parseFetchForm(lines: string[]): Reading {
  const warnings: string[] = [];
  const heads = lines.map((l, i) => (bare(l) === 'License Information' ? i : -1)).filter((i) => i >= 0);
  const end = lines.findIndex((l, i) => i > heads[1] && bare(l) === 'Special Qualifications');
  const section = lines.slice(heads[1] + 1, end === -1 ? undefined : end);
  const firstSection = lines.slice(heads[0] + 1, heads[1]);
  const used = new Set<string>();

  const only = (label: string, found: string[]): string | null => {
    if (found.length === 0) warnings.push(`no line matches: ${label}`);
    else if (found.length > 1) warnings.push(`more than one line matches: ${label}`);
    return found.length === 1 ? found[0] : null;
  };

  const licence = only(
    'License Number',
    section.filter((l) => LICENCE_SHAPE.test(l)),
  );
  const status = only(
    'Status',
    section.filter(
      (l) =>
        !LICENCE_SHAPE.test(l) &&
        !DATE_LINE.test(l) &&
        (statusFor('fl-dbpr', l) !== 'other' || WORD_COMMA_WORD.test(l)),
    ),
  );
  for (const v of [licence, status]) if (v !== null) used.add(v);

  // Two date lines: the earlier is the licensure date, the later the expiry.
  let issued: string | null = null;
  let expires: string | null = null;
  const dateLines = section.filter((l) => DATE_LINE.test(l));
  if (dateLines.length !== 2) {
    warnings.push(
      dateLines.length === 0 ? 'no line matches: dates' : `expected 2 date lines, found ${dateLines.length}`,
    );
  } else {
    const isos = dateLines.map(isoDate);
    if (isos.includes(null)) {
      warnings.push('could not read date: dates');
    } else {
      const [a, b] = (isos as string[]).slice().sort();
      issued = a;
      expires = b;
    }
  }

  // The licence type is the first line that is none of the above (the rank follows it).
  const licenceType = section.find((l) => !used.has(l) && !DATE_LINE.test(l) && !LICENCE_SHAPE.test(l)) ?? null;
  if (licenceType === null) warnings.push('no line matches: License Type');

  const primary = tagged(lines, 'Primary Name');
  if (primary === null) warnings.push('label not found: Primary Name');
  const cityHit = firstSection.map((l) => ({ l, m: FETCH_CITY_LINE.exec(l) })).find((x) => x.m !== null);
  const city = cityHit?.m ? cityHit.m[1].trim().replace(/,$/, '') : null;
  if (city === null) warnings.push('no city in the licensee block');
  // A business name follows the primary name, and the street (then the city line) follows that.
  const others: string[] = [];
  const at = primary ? firstSection.indexOf(primary.line) : -1;
  if (at >= 0) {
    const cand = firstSection[at + 1];
    const next = firstSection[at + 2];
    if (cand !== undefined && next !== undefined && !FETCH_CITY_LINE.test(cand) && !FETCH_CITY_LINE.test(next))
      others.push(cand);
  }

  const fields: Fields = {
    name: primary?.value ?? null,
    licence_number: licence,
    status_raw: status,
    status: status === null ? null : statusFor('fl-dbpr', status),
    expires,
    issued,
    licence_type: licenceType,
    discipline_flag: null,
    discipline_actions: [],
    data_as_of: null,
    city,
    other_names: others,
  };
  const quotes = [
    primary?.line,
    licenceType,
    licence,
    status,
    issued === null ? null : dateLines[0],
    expires === null ? null : dateLines[1],
    cityHit?.l,
    ...others,
  ].filter((q): q is string => typeof q === 'string' && q !== '');
  return { reader: 'parser_text', fields, quotes, warnings };
}

export function parseText(html: string): Reading {
  const lines = toText(html).split('\n');
  const infoHeads = lines.filter((l) => bare(l) === 'License Information').length;
  if (infoHeads === 2 && !lines.some((l) => OWN_LABELS.includes(bare(l)))) return parseFetchForm(lines);
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

  const name = need('Primary Name', tagged(lines, 'Primary Name'));
  // A DBA is optional on a licence, so a missing one is not a warning.
  const dba = tagged(lines, 'DBA Name') ?? nextLine(lines, ['DBA Name']);
  const alternates = alternateNames(lines);
  const licence = need('License Number', nextLine(lines, ['License Number']));
  const status = need('Status', nextLine(lines, ['Status']));
  // The expiry row is labelled "Expires" on some pages and "Expiration Date" on others.
  // The warning names the label the page shows; neither shown means "Expiration Date".
  const expiryLabel = EXPIRY_LABELS.find((l) => lines.some((line) => bare(line) === l)) ?? 'Expiration Date';
  const expires = need(expiryLabel, nextLine(lines, [expiryLabel]));
  const issued = need('Licensure Date', nextLine(lines, ['Licensure Date']));
  const licenceType = need('License Type', nextLine(lines, ['License Type']));
  const city = cityUnder(lines, 'Main Address');
  if (city === null) {
    warnings.push(
      lines.some((line) => bare(line) === 'Main Address')
        ? 'no city under label: Main Address'
        : 'label not found: Main Address',
    );
  }

  const otherNames = [...(dba ? [dba] : []), ...alternates];

  const fields: Fields = {
    name: name?.value ?? null,
    licence_number: licence?.value ?? null,
    status_raw: status?.value ?? null,
    status: status === null ? null : statusFor('fl-dbpr', status.value),
    expires: date(expiryLabel, expires),
    issued: date('Licensure Date', issued),
    licence_type: licenceType?.value ?? null,
    discipline_flag: null,
    discipline_actions: [],
    data_as_of: null,
    city: city?.value ?? null,
    other_names: otherNames.map((hit) => hit.value),
  };

  // One quote per non-null field, in field order, then one per other name.
  const sources: [unknown, Hit | null][] = [
    [fields.name, name],
    [fields.licence_number, licence],
    [fields.status_raw, status],
    [fields.status, status],
    [fields.expires, expires],
    [fields.issued, issued],
    [fields.licence_type, licenceType],
    [fields.city, city],
  ];
  const quotes = sources.flatMap(([value, hit]) => (value !== null && hit !== null ? [hit.line] : []));
  for (const hit of otherNames) quotes.push(hit.line);

  return { reader: 'parser_text', fields, quotes, warnings };
}
