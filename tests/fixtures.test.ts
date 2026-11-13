import { describe, expect, it } from 'vitest';

// Every file under tests/fixtures is read as text, so the checks see what the repo ships.
const fixtures = import.meta.glob('./fixtures/**/*', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// Code and tests, read as text, for the identifier scan below.
const code = import.meta.glob(['./**/*.ts', '../src/**/*'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// Phone numbers in the three printed forms.
const PHONES = [
  /\(\d{3}\) ?\d{3}-\d{4}/g,
  /\b\d{3}-\d{3}-\d{4}\b/g,
  /\b\d{3}\.\d{3}\.\d{4}\b/g,
  /\b\d{3} \d{3} \d{4}\b/g,
];
// 24 or more hex characters, in any case.
const HEX_IDS = /\b[0-9a-f]{24,}\b/gi;
// A street number of 1 to 5 digits, a street name, then a street word. Full words and
// abbreviations, with or without a dot, in any case.
const STREET_WORDS =
  'St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Blvd|Boulevard|Ln|Lane|Ct|Court|Way|Pkwy|Parkway|Hwy|Highway|' +
  'Suite|Ste|Unit|Terrace|Ter|Place|Pl|Circle|Cir';
const STREET = new RegExp(`\\b\\d{1,5}\\s+[A-Za-z0-9.' -]{1,40}?\\s(?:${STREET_WORDS})\\.?(?![A-Za-z])`, 'gi');
// A city, an optional comma, a two-letter upper-case state, then a five-digit ZIP. The
// separators may be spaces, a non-breaking space as a character or as an entity. The city
// is group 1; trailing separators are stripped before the fake SAMPLE CITY line is allowed.
const SEP = '(?:\\s|&nbsp;|&#160;|&#xa0;|,)';
const ZIP = new RegExp(`([A-Za-z][A-Za-z .'-]*?)${SEP}*\\b([A-Z]{2})${SEP}+(\\d{5})\\b`, 'g');
const TRAILING_SEPARATORS = /(?:\s|&nbsp;|&#160;|&#xa0;|,)+$/;
// Licence numbers for every registry prefix. MQA and DBPR prefixes, and the CSLB header span and "LicNum=" links.
const LICENCE = /\b(ME|OS|DN|RN|PN|PS|APRN|CPC|EG|EMT|PMD|CNA|CCC|CGC|CBC|CRC|CFC|EC|RC|RG|RX)(\d{5,10})\b/g;
const CSLB_HEADER = /MainContent_Header2Detail[^>]*>([^<]*)</g;
const CSLB_LINK = /LicNum=(\d{5,8})\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Fake numbers are a run of zeros with at most two digits after it, e.g. ME000000, PN000001, CCC0000000.
const isFakeDigits = (digits: string): boolean => /^0{4,}\d{0,2}$/.test(digits);

// Everything in the text that looks like personal data, after the fake forms are allowed.
function leaks(text: string): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  const add = (kind: string, value: string): void => {
    (found[kind] ??= []).push(value);
  };
  for (const re of PHONES)
    for (const m of text.matchAll(re)) {
      // The fake "000 000 0000" is allowed; every other printed phone is not.
      if (m[0].replace(/\D/g, '') !== '0000000000') add('phone', m[0]);
    }
  for (const m of text.matchAll(HEX_IDS)) if (!isFakeDigits(m[0])) add('hex id', m[0]);
  // The fake street "1 Sample St" is allowed; any other numbered street is not.
  for (const m of text.replace(/1 Sample St\b/gi, '').matchAll(STREET)) add('street', m[0]);
  for (const m of text.matchAll(ZIP)) {
    const city = (m[1] ?? '').replace(TRAILING_SEPARATORS, '');
    const fakeCity = city.endsWith('SAMPLE CITY') && m[3] === '00000';
    if (!fakeCity) add('zip and city', m[0]);
  }
  for (const m of text.matchAll(LICENCE)) if (!isFakeDigits(m[2])) add('licence', m[0]);
  for (const m of text.matchAll(CSLB_HEADER)) {
    for (const digits of (m[1] ?? '').match(/\d{5,8}/g) ?? []) if (!isFakeDigits(digits)) add('licence', m[0]);
  }
  for (const m of text.matchAll(CSLB_LINK)) if (!isFakeDigits(m[1] ?? '')) add('licence', m[0]);
  for (const m of text.matchAll(EMAIL)) add('email', m[0]);
  return found;
}

// Real identifiers from the saved pages. Written in pieces, so this file does not contain them.
const REAL_IDENTIFIERS = [
  ['1335', '434'],
  ['181', '008'],
  ['1155', '041'],
  ['188', '673'],
  ['890', 'EB419'],
  ['1166', '736'],
  ['1260', '863'],
  ['9584', '697'],
].map((parts) => parts.join(''));

describe('fixture scrubbing', () => {
  it('finds fixture files to check', () => {
    expect(Object.keys(fixtures).length).toBeGreaterThan(0);
  });

  for (const [path, text] of Object.entries(fixtures)) {
    it(`${path} has no personal data left in it`, () => {
      expect(leaks(text)).toEqual({});
    });
  }
});

describe('guard shapes', () => {
  it('catches a comma-less ZIP line with entity separators, and not the fake SAMPLE CITY line', () => {
    expect(leaks('OAKLAND PARK&nbsp;&nbsp; FL&nbsp;&nbsp; 33334')).toHaveProperty('zip and city');
    expect(leaks('SAMPLE CITY&nbsp;&nbsp; FL&nbsp;&nbsp; 00000')).toEqual({});
  });

  it('catches a space-separated phone and not the fake 000 000 0000', () => {
    expect(leaks('Call 813 555 0142 today')).toHaveProperty('phone');
    expect(leaks('Call 000 000 0000 today')).toEqual({});
  });

  it('catches a CSLB number in the header span and not a 000000x fake', () => {
    expect(leaks('<span id="MainContent_Header2Detail"> 1234567</span>')).toHaveProperty('licence');
    expect(leaks('<span id="MainContent_Header2Detail">0000001</span>')).toEqual({});
  });
});

describe('real identifiers stay out of code and tests', () => {
  it('finds code files to check', () => {
    expect(Object.keys(code).length).toBeGreaterThan(0);
  });

  for (const [path, text] of Object.entries(code)) {
    // golden.json and the canary test exercise the golden records, so they are exempt.
    if (path.endsWith('golden.json') || path.endsWith('canary.test.ts')) continue;
    it(`${path} has no real identifier`, () => {
      const hits = REAL_IDENTIFIERS.filter((id) => text.includes(id));
      expect(hits).toEqual([]);
    });
  }
});

// Real business names stay out of every tracked text file. Only SHA-256 hashes are stored here, so this file does
// not hold a name. Each entry is the hash of the name's first word, the number of words in the name, and the hash of
// the whole name. Text is lower-cased, every run of characters other than letters and digits is a word break, and the
// words are joined by one space, so "L.L.C." and a new line inside a name do not hide it.
type NameHash = { first: string; words: number; whole: string };
const REPLACED_NAMES: NameHash[] = [
  {
    first: '54f170de1dc9a4cac6816a1c2fbaedfaf47d0ab38221f92712c925f9c2c742e5',
    words: 2,
    whole: '2f13720ff86f68e9b30eafc15f59186730ebebb21574e40b4c1af6c5a8b04531',
  },
  {
    first: '1bda8fa72d0b6c4e79fd4f237fb24feade3b7a432fa062c3ec42a8db9cce01f3',
    words: 1,
    whole: '1bda8fa72d0b6c4e79fd4f237fb24feade3b7a432fa062c3ec42a8db9cce01f3',
  },
  {
    first: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    words: 3,
    whole: '82c86c611c58d30980f8f8566d4d7d2deeff8be64ff815f78a99c85d327dc4b4',
  },
  {
    first: 'a21dfce2c27396ca29a322bf3d9fe9ffd46339f8197973002d239fb7fe13566c',
    words: 3,
    whole: '501f5784efe249f6422544c7c3f55f1650a937b21b8154e70a3a4644eef76195',
  },
];

const digests = new Map<string, Promise<string>>();
function sha256(text: string): Promise<string> {
  let hit = digests.get(text);
  if (hit === undefined) {
    hit = crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(text))
      .then((buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''));
    digests.set(text, hit);
  }
  return hit;
}

// How many times a hashed name appears in the text.
async function namesIn(text: string, names: NameHash[]): Promise<number> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
  let found = 0;
  for (let i = 0; i < words.length; i += 1) {
    const first = await sha256(words[i]);
    for (const n of names) {
      if (n.first !== first || i + n.words > words.length) continue;
      if ((await sha256(words.slice(i, i + n.words).join(' '))) === n.whole) found += 1;
    }
  }
  return found;
}

describe('real business names stay out of tracked files', () => {
  it('finds a hashed name in any case, with punctuation and line breaks inside it, and not a different name', async () => {
    const probe: NameHash[] = [{ first: await sha256('zzprobe'), words: 2, whole: await sha256('zzprobe widgets') }];
    expect(await namesIn('Order from ZZProbe\n  Widgets, Inc.', probe)).toBe(1);
    expect(await namesIn('zzprobe-widgets and zzprobe widgets', probe)).toBe(2);
    expect(await namesIn('zzprobe gadgets', probe)).toBe(0);
  });

  const everything = { ...fixtures, ...code };
  for (const [path, text] of Object.entries(everything)) {
    it(`${path} holds none of the replaced business names`, async () => {
      expect(await namesIn(text, REPLACED_NAMES)).toBe(0);
    });
  }
});
