/**
 * Scrubs a real Fetch-form capture of a Florida record page into a fixture. Pure text work, no files and no network,
 * so a test can run it. scripts/capture.ts does the I/O.
 *
 * A scrub replaces the person, the street, the city, the county and the licence number with the fake values the other
 * fixtures use. It then refuses to return anything while a real value from the capture, or anything shaped like
 * personal data, is still in the text.
 */

export type ScrubRegistry = 'fl-mqa' | 'fl-dbpr' | 'fl-mqa-tab' | 'fl-dbpr-complaints' | 'fl-dbpr-results';

export const FAKE_NAME = 'SAMPLE, PERSON A';
export const FAKE_STREET = '1 Sample St';
export const FAKE_CITY_LINE = 'SAMPLE CITY, FL 00000';
export const FAKE_BUSINESS = 'SAMPLE BUSINESS, INC.';

export class ScrubRefused extends Error {}

/** A city line ends in a ZIP code, with the state as a code or spelled out ("DESTIN Florida 32541"). */
const CITY_LINE = /^(.+?),?\s+(?:[A-Za-z]{2}|[A-Za-z]+(?: [A-Za-z]+)?)\s+\d{5}(?:-\d{4})?$/;
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
const decode = (s: string): string => s.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');

/** A licence number with its letters kept and its digits turned into zeros. */
export function fakeLicence(real: string): string {
  const m = /^([A-Za-z]+)(\d+)$/.exec(real.trim());
  if (!m) throw new ScrubRefused('licence number has an unexpected shape');
  return `${m[1].toUpperCase()}${'0'.repeat(m[2].length)}`;
}

/** What the capture held that must not survive: filled in as the scrub finds it. */
interface Real {
  words: string[]; // name words, matched as whole words in any case
  strings: string[]; // exact strings (street lines, the licence number, ids)
}

function nameWords(name: string): string[] {
  return name
    .replace(/\((?:Primary|DBA|Alternate) Name\)/gi, ' ')
    .split(/[^A-Za-z']+/)
    .filter((w) => w.length >= 3);
}

/** Replaces the body of the n-th match of `re` (one capture group = the body), keeping the tags and spacing. */
function replaceBodies(text: string, re: RegExp, fn: (body: string, index: number) => string): string {
  let i = 0;
  return text.replace(re, (all, body: string) => all.replace(body, () => fn(body, i++)));
}

function scrubMqa(text: string, real: Real): string {
  let out = text;

  // Name: the first <h3> that is not the licence number line.
  let nameDone = false;
  out = out.replace(/<h3>([^<]*)<\/h3>/gi, (all, body: string) => {
    if (nameDone || /^\s*License/i.test(body)) return all;
    nameDone = true;
    real.words.push(...nameWords(decode(body)));
    return all.replace(body, `${FAKE_NAME} `);
  });
  if (!nameDone) throw new ScrubRefused('no name heading found');

  // Licence number: the heading line names it, and every other copy follows.
  const lic = /License Number:\s*([A-Za-z]+\d+)/i.exec(out)?.[1];
  if (!lic) throw new ScrubRefused('no licence number heading found');
  real.strings.push(lic);
  out = out.split(lic).join(fakeLicence(lic));

  // Address of Record: the street lines become one fake street, the city line the fake city.
  const from = out.search(/Address of Record/i);
  if (from === -1) throw new ScrubRefused('no Address of Record label');
  // The block ends at the next label that has text; the empty <strong></strong> pairs inside it do not end it.
  let to = -1;
  for (const m of out.slice(from + 'Address of Record'.length).matchAll(/<strong>([\s\S]*?)<\/strong>/gi)) {
    if (m[1].trim() !== '') {
      to = from + 'Address of Record'.length + (m.index ?? 0);
      break;
    }
  }
  const head = out.slice(0, from);
  const section = out.slice(from, to === -1 ? undefined : to);
  const tail = to === -1 ? '' : out.slice(to);
  let streetPlaced = false;
  const scrubbed = section.replace(/(<dd>)([\s\S]*?)(<\/dd>)/gi, (all, open: string, body: string, close: string) => {
    const line = norm(decode(body));
    if (line === '') return all;
    real.strings.push(line);
    const m = CITY_LINE.exec(line);
    if (m) {
      real.words.push(...nameWords(m[1]));
      return `${open}\n${FAKE_CITY_LINE}\n${close}`;
    }
    if (!streetPlaced) {
      streetPlaced = true;
      return `${open}\n${FAKE_STREET}\n${close}`;
    }
    return `${open}\n${close}`;
  });
  out = head + scrubbed + tail;
  return out;
}

/** The enforcement tab: tables of rows with a name, licence, city and case number per row. */
function scrubMqaTab(text: string, real: Real): string {
  let caseNo = 100;
  let out = text.replace(/<table[\s\S]*?<\/table>/gi, (table) => {
    const headers = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => norm(decode(m[1])).toLowerCase());
    return table.replace(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*<\/tr>/gi, (row) => {
      if (!/<td/i.test(row)) return row;
      let col = -1;
      return row.replace(/(<td[^>]*>)([\s\S]*?)(<\/td>)/gi, (all, open: string, body: string, close: string) => {
        col++;
        const head = headers[col] ?? '';
        const plain = norm(decode(body.replace(/<[^>]*>/g, ' ')));
        // The cell's visible text is replaced inside its own tags, so a link around a case number stays.
        const put = (to: string): string => `${open}${plain === '' ? body : body.replace(plain, to)}${close}`;
        if (head === 'name') {
          real.words.push(...nameWords(plain));
          return put(FAKE_NAME);
        }
        if (head === 'license') {
          real.strings.push(plain);
          return put('000001');
        }
        if (head === 'city') {
          real.words.push(...nameWords(plain));
          return put('SAMPLE CITY');
        }
        if (head.startsWith('case')) {
          caseNo++;
          real.strings.push(plain);
          return put(String(caseNo).padStart(6, '0'));
        }
        return all;
      });
    });
  });
  // The Department's records address and phone number.
  out = out.replace(/\(\d{3}\) ?\d{3}-\d{4}/g, '000 000 0000');
  out = out.replace(STREET, (m) => {
    real.strings.push(m);
    return FAKE_STREET;
  });
  out = out.replace(/[A-Z][A-Za-z .]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?/g, (m) => {
    real.strings.push(m);
    return FAKE_CITY_LINE;
  });
  return out;
}

/**
 * The contractor board's complaint view: the licensee's name under the "Name" label, the complaint table, and the
 * Department's own address and phone numbers in the footer.
 */
function scrubDbprComplaints(text: string, real: Real): string {
  let out = text.replace(
    /(<span[^>]*>\s*Name\s*<\/span>\s*<br\s*\/?>)([\s\S]*?)(<\/p>)/i,
    (all, open: string, body: string, close: string) => {
      const plain = norm(decode(body.replace(/<[^>]*>/g, ' ')));
      if (plain === '') return all;
      real.strings.push(plain);
      real.words.push(...nameWords(plain));
      return `${open}\n${FAKE_BUSINESS}\n${close}`;
    },
  );
  // The case number in the first cell of each complaint row names the case of a real licensee, so it becomes a sample
  // number.
  let caseNo = 0;
  out = out.replace(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*<\/tr>/gi, (row) =>
    row.replace(/(<td[^>]*>)([\s\S]*?)(<\/td>)/i, (all, open: string, body: string, close: string) => {
      const plain = norm(decode(body.replace(/<[^>]*>/g, ' ')));
      if (plain === '') return all;
      caseNo++;
      real.strings.push(plain);
      return `${open}${body.replace(plain, `2000000${String(caseNo).padStart(3, '0')}`)}${close}`;
    }),
  );
  // The Department's phone numbers, in every printed form, including "(850) 487.1395".
  out = out.replace(/\(\d{3}\) ?\d{3}[-.]\d{4}/g, '000 000 0000');
  out = out.replace(/\b\d{3}[-.]\d{3}[-.]\d{4}\b/g, '000 000 0000');
  // The Department's street and city line.
  out = out.replace(STREET, (m) => {
    real.strings.push(m);
    return FAKE_STREET;
  });
  out = out.replace(/[A-Z][A-Za-z .]+,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?/g, (m) => {
    real.strings.push(m);
    return FAKE_CITY_LINE;
  });
  return out;
}

/**
 * The contractor board's results list (the page a search opens): cut down to its title, its "Search Results - N
 * Records" heading and the results form, so none of the page's navigation, footer or map stays. Each name, link id,
 * licence number and address line in the form becomes a sample value, and the typed search values the form echoes as
 * hidden inputs are replaced. The names are replaced in page order: a Primary name line by "SAMPLE, PERSON <letter>",
 * any other name line by "SAMPLE BUSINESS <n>, INC.". Words of a business name that the registry's own labels also use
 * are not secret, and stay where the page uses them.
 */
const FAKE_NAME_WORDS = new Set([
  'sample',
  'person',
  'business',
  'inc',
  'construction',
  'general',
  'contractor',
  'contractors',
  'building',
  'roofing',
  'services',
  'company',
  'group',
  'llc',
  'corp',
]);
function scrubDbprResults(text: string, real: Real): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] ?? 'Licensing Portal - License Search';
  const heading = /<strong[^>]*>\s*Search Results\s*-\s*\d+\s*Records?\s*<\/strong>/i.exec(text)?.[0];
  const form = /<form[\s\S]*?<\/form>/i.exec(text)?.[0];
  if (!heading || !form) throw new ScrubRefused('no results heading or results form found');
  let out = form;

  const ids = new Map<string, string>();
  let people = 0;
  let businesses = 0;
  out = out.replace(
    /(<a\b[^>]*href=")([^"]*?)([0-9A-Fa-f]{32})([^"]*"[^>]*>)([\s\S]*?)(<\/a>)/gi,
    (all, open: string, before: string, id: string, rest: string, body: string, close: string, offset: number) => {
      if (!ids.has(id.toLowerCase())) ids.set(id.toLowerCase(), `${'0'.repeat(31)}${ids.size + 1}`);
      real.strings.push(id);
      const plain = norm(decode(body.replace(/<[^>]*>/g, ' ')));
      real.strings.push(plain);
      real.words.push(...nameWords(plain).filter((w) => !FAKE_NAME_WORDS.has(w.toLowerCase())));
      const after = norm(decode(out.slice(offset + all.length, offset + all.length + 600).replace(/<[^>]*>/g, ' ')));
      const fake = /^Primary\b/i.test(after)
        ? `SAMPLE, PERSON ${String.fromCharCode(65 + people++)}`
        : `SAMPLE BUSINESS ${++businesses}, INC.`;
      return `${open}${before}${ids.get(id.toLowerCase())}${rest}${body.replace(plain, fake)}${close}`;
    },
  );

  // Licence numbers: the same real number always gets the same sample number, in order of first appearance.
  const licences = new Map<string, string>();
  out = out.replace(/\b([A-Z]{2,4})(\d{6,10})\b/g, (all, prefix: string, digits: string) => {
    if (!licences.has(all)) licences.set(all, `${prefix}${String(licences.size + 1).padStart(digits.length, '0')}`);
    real.strings.push(all);
    return licences.get(all) ?? all;
  });

  // The typed search values echoed as hidden inputs.
  out = out.replace(
    /(<input\b[^>]*name="hOrgName"[^>]*value=")([^"]*)(")/i,
    (_all, open: string, value: string, close: string) => {
      real.strings.push(value);
      real.words.push(...nameWords(value).filter((w) => !FAKE_NAME_WORDS.has(w.toLowerCase())));
      return `${open}SAMPLE BUSINESS 1, INC.${close}`;
    },
  );
  out = out.replace(
    /(<input\b[^>]*name="h(?:LastName|FirstName)"[^>]*value=")([^"]*)(")/gi,
    (_all, open: string, value: string, close: string) => {
      real.strings.push(value);
      real.words.push(...nameWords(value));
      return `${open}SAMPLE${close}`;
    },
  );

  // Address lines: "<number>  <street>  <CITY>, FL 32541", the parts separated by non-breaking spaces.
  out = out.replace(/>(\s*\d{1,5}[\s\u00a0]+[^<]*?,\s*[A-Za-z]{2}\s+\d{5}(?:-\d{4})?\s*)</g, (_all, body: string) => {
    const line = norm(decode(body));
    real.strings.push(line);
    const m = CITY_LINE.exec(line);
    if (m) real.words.push(...nameWords(m[1]));
    return `>1 Sample St\u00a0\u00a0${FAKE_CITY_LINE}<`;
  });

  return `<!doctype html>\n<html>\n<head>\n<title>${title}</title>\n</head>\n<body>\n<p>${heading}</p>\n${out}\n</body>\n</html>\n`;
}

function scrubDbpr(text: string, real: Real): string {
  const marker = /<h6>\s*License Information\s*<\/h6>/gi;
  const marks = [...text.matchAll(marker)].map((m) => m.index ?? 0);
  if (marks.length < 2) throw new ScrubRefused('the two License Information headings are missing');
  const firstEnd = marks[0];
  const secondStart = marks[1];
  const before = text.slice(0, firstEnd);
  const first = text.slice(firstEnd, secondStart);
  let rest = text.slice(secondStart);

  const P = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  const parts = [...first.matchAll(P)].length;
  if (parts < 5) throw new ScrubRefused('the first section has fewer than 5 paragraphs');

  const scrubbedFirst = replaceBodies(first, P, (body, i) => {
    const pad = (s: string): string => `\n            ${s}\n        `;
    if (i === 0) {
      real.words.push(...nameWords(decode(body)));
      return pad(`${FAKE_NAME} (Primary Name)`);
    }
    if (i === 1) {
      // The business line is a registry entry, but with a licence type and dates it names the person behind a
      // one-person company, so it is replaced as well. An empty line stays empty.
      const business = norm(decode(body));
      if (business === '') return body;
      real.strings.push(business);
      return pad(FAKE_BUSINESS);
    }
    // Later paragraphs are address blocks (street, then city line) and county, in any repeat.
    if (/<br\s*\/?>/i.test(body)) {
      for (const line of body.split(/<br\s*\/?>/i))
        if (norm(decode(line)) !== '') real.strings.push(norm(decode(line)));
      return pad(`${FAKE_STREET}\n            <br/>${FAKE_CITY_LINE}`);
    }
    const line = norm(decode(body));
    const m = CITY_LINE.exec(line);
    if (m) {
      real.strings.push(line);
      real.words.push(...nameWords(m[1]));
      return FAKE_CITY_LINE;
    }
    real.words.push(...nameWords(line));
    return pad('Sample');
  });

  // The licence number is the third paragraph of the second section.
  const secondParas = [...rest.matchAll(P)].map((m) => norm(decode(m[1])));
  const lic = secondParas.find((p) => /^[A-Za-z]{1,4}\d{4,10}$/.test(p));
  if (!lic) throw new ScrubRefused('no licence number in the second section');
  real.strings.push(lic);
  rest = rest.split(lic).join(fakeLicence(lic));

  return before + scrubbedFirst + rest;
}

/** Shapes of personal data. The same families tests/fixtures.test.ts scans for. */
const PHONES = [
  /\(\d{3}\) ?\d{3}-\d{4}/g,
  /\b\d{3}-\d{3}-\d{4}\b/g,
  /\b\d{3}\.\d{3}\.\d{4}\b/g,
  /\b\d{3} \d{3} \d{4}\b/g,
];
const HEX_IDS = /\b[0-9a-f]{24,}\b/gi;
const STREET_WORDS =
  'St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Blvd|Boulevard|Ln|Lane|Ct|Court|Way|Pkwy|Parkway|Hwy|Highway|Suite|Ste|Unit|Terrace|Ter|Place|Pl|Circle|Cir';
const STREET = new RegExp(`\\b\\d{1,5}\\s+[A-Za-z0-9.' -]{1,40}?\\s(?:${STREET_WORDS})\\.?(?![A-Za-z])`, 'gi');
const SEP = '(?:\\s|&nbsp;|&#160;|&#xa0;|,)';
const ZIP = new RegExp(`([A-Za-z][A-Za-z .'-]*?)${SEP}*\\b([A-Z]{2})${SEP}+(\\d{5})\\b`, 'g');
const LICENCE = /\b(ME|OS|DN|RN|PN|PS|APRN|CPC|EG|EMT|PMD|CNA|CCC|CGC|CBC|CRC|CFC|EC|RC|RG|RX)(\d{5,10})\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const isFakeDigits = (d: string): boolean => /^0{4,}\d{0,2}$/.test(d);

/** What is still in the text that looks like personal data. */
export function leftovers(text: string): string[] {
  const found: string[] = [];
  for (const re of PHONES)
    for (const m of text.matchAll(re)) if (m[0].replace(/\D/g, '') !== '0000000000') found.push(`phone ${m[0]}`);
  for (const m of text.matchAll(HEX_IDS)) if (!isFakeDigits(m[0])) found.push('hex id');
  for (const m of text.replace(/1 Sample St\b/gi, '').matchAll(STREET)) found.push(`street ${m[0]}`);
  for (const m of text.matchAll(ZIP)) {
    const city = (m[1] ?? '').replace(/(?:\s|&nbsp;|&#160;|&#xa0;|,)+$/, '');
    if (!(city.endsWith('SAMPLE CITY') && m[3] === '00000')) found.push(`zip and city ${m[0]}`);
  }
  for (const m of text.matchAll(LICENCE)) if (!isFakeDigits(m[2])) found.push(`licence ${m[0]}`);
  for (const m of text.matchAll(EMAIL)) found.push(`email ${m[0]}`);
  return found;
}

/** Scrubs the capture, or throws ScrubRefused. `ids` are the registry's own record ids from the URL. */
export function scrub(registry: ScrubRegistry, capture: string, ids: string[] = []): string {
  const real: Real = { words: [], strings: [...ids.filter((i) => i !== '')] };
  const out =
    registry === 'fl-mqa'
      ? scrubMqa(capture, real)
      : registry === 'fl-mqa-tab'
        ? scrubMqaTab(capture, real)
        : registry === 'fl-dbpr-complaints'
          ? scrubDbprComplaints(capture, real)
          : registry === 'fl-dbpr-results'
            ? scrubDbprResults(capture, real)
            : scrubDbpr(capture, real);

  const problems: string[] = [];
  const flat = norm(decode(out));
  for (const s of real.strings) {
    if (s.length >= 4 && flat.toLowerCase().includes(norm(s).toLowerCase()))
      problems.push('a real address line, id or licence number is still present');
  }
  for (const w of new Set(real.words)) {
    if (new RegExp(`(?<![A-Za-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`, 'i').test(flat)) {
      problems.push('a real name or city word is still present');
    }
  }
  for (const l of leftovers(out)) problems.push(l.split(' ')[0] + ' shaped data is still present');
  if (problems.length > 0) throw new ScrubRefused([...new Set(problems)].join('; '));
  return out;
}
