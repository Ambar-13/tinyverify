/**
 * Turns an HTML page into plain visible text, one line per block element. Hidden blocks are removed by a hand-written
 * scanner, not by regex, so the work stays linear in the input length. Runs inside the Worker's CPU budget.
 */

const BLOCK_BREAK =
  /<\/?(?:p|div|tr|td|th|li|br|h[1-6]|dt|dd|table|section|article|hr|form|legend|nav|main|header|footer|ul|ol|fieldset)\b[^<>]*>/gi;

const ANY_TAG = /<[^<>]*>/g;

/**
 * Registry pages are untrusted input. Cap the work so a hostile page cannot
 * exceed the CPU budget; anything past the cap is ignored.
 */
export const MAX_HTML_CHARS = 300_000;

interface HiddenOpener {
  open: string;
  /** Closing tag prefix, or null for a comment (which ends at "-->" and takes no name check). */
  close: string | null;
  /** A tag that ends the block early without being removed, e.g. <body> ends <head>. */
  endsAt?: string;
}

const HIDDEN_OPENERS: HiddenOpener[] = [
  { open: '<script', close: '</script' },
  { open: '<style', close: '</style' },
  { open: '<noscript', close: '</noscript' },
  { open: '<head', close: '</head', endsAt: '<body' },
  { open: '<!--', close: null },
];

/** A tag name must not run on into a longer name, so <header> is not <head>. */
function nameEnds(lower: string, at: number): boolean {
  const c = lower.charCodeAt(at);
  if (Number.isNaN(c)) return true;
  const isLetterOrDigit = (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
  return !(isLetterOrDigit || c === 45 || c === 95 || c === 58); // - _ :
}

/**
 * Finds `needle` at or after a moving `from`. The answer is cached, and it is
 * recomputed only once `from` passes it. Searches then cover disjoint stretches.
 */
class Finder {
  private readonly lower: string;
  private readonly needle: string;
  private readonly tagName: boolean;
  private pos = -2; // -2: not searched yet; -1: none left

  constructor(lower: string, needle: string, tagName: boolean) {
    this.lower = lower;
    this.needle = needle;
    this.tagName = tagName;
  }

  at(from: number): number {
    if (this.pos === -1) return -1;
    if (this.pos === -2 || this.pos < from) this.pos = this.search(from);
    return this.pos;
  }

  private search(from: number): number {
    let i = from;
    for (;;) {
      const j = this.lower.indexOf(this.needle, i);
      if (j === -1) return -1;
      if (!this.tagName || nameEnds(this.lower, j + this.needle.length)) return j;
      i = j + 1;
    }
  }
}

/**
 * Removes script, style, noscript, head and comment blocks. An opening tag ends
 * at the first '>' (quotes are not honoured), and the block ends at its closing
 * tag or at end of input. Every step moves the cursor forward.
 */
export function stripHidden(html: string): string {
  // Native lower-casing keeps every index when its length matches. Otherwise fall
  // back to ASCII-only lower-casing, which always keeps the length.
  const native = html.toLowerCase();
  const lower = native.length === html.length ? native : html.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const len = html.length;

  const plan = HIDDEN_OPENERS.map((o) => ({
    opener: o,
    closer: o.close === null ? null : new Finder(lower, o.close, true),
    ender: o.endsAt === undefined ? null : new Finder(lower, o.endsAt, true),
  }));

  // nextAt[k]: where opener k next occurs at or after `from` (-1 = never).
  // -2 means "not searched yet". An entry is recomputed only once `from` passes
  // it, so each opener's searches cover disjoint stretches of input.
  const nextAt = HIDDEN_OPENERS.map(() => -2);

  const out: string[] = [];
  // `cursor` is where unemitted text starts; `from` is where the next search starts.
  let cursor = 0;
  let from = 0;
  for (;;) {
    let start = -1;
    let which = -1;
    for (let k = 0; k < HIDDEN_OPENERS.length; k++) {
      if (nextAt[k] !== -1 && nextAt[k] < from) {
        nextAt[k] = lower.indexOf(HIDDEN_OPENERS[k].open, from);
      }
      if (nextAt[k] !== -1 && (start === -1 || nextAt[k] < start)) {
        start = nextAt[k];
        which = k;
      }
    }
    if (start === -1) break;

    const { opener, closer, ender } = plan[which];
    if (closer !== null && !nameEnds(lower, start + opener.open.length)) {
      from = start + 1; // a longer name such as <header>: not a hidden block
      continue;
    }

    let end: number;
    if (closer === null) {
      const close = lower.indexOf('-->', start + 4);
      end = close === -1 ? len : close + 3;
    } else {
      const openEnd = lower.indexOf('>', start);
      if (openEnd === -1) {
        end = len;
      } else {
        const closeAt = closer.at(openEnd + 1);
        const endAt = ender === null ? -1 : ender.at(openEnd + 1);
        if (endAt !== -1 && (closeAt === -1 || endAt < closeAt)) {
          end = endAt; // the block stops before this tag, which stays in the text
        } else if (closeAt === -1) {
          end = len;
        } else {
          const closeEnd = lower.indexOf('>', closeAt);
          end = closeEnd === -1 ? len : closeEnd + 1;
        }
      }
    }

    out.push(html.slice(cursor, start), ' ');
    cursor = end;
    from = end;
  }
  out.push(html.slice(cursor));
  return out.join('');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const ENTITY = /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi;

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function toText(html: string): string {
  let s = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  s = stripHidden(s);

  // A raw line break in HTML source is just whitespace, so it becomes a space
  // before block elements add the real line breaks.
  s = s.replace(/[\r\n]+/g, ' ');
  s = s.replace(BLOCK_BREAK, '\n');
  s = s.replace(ANY_TAG, '');

  const lines: string[] = [];
  for (const raw of s.split('\n')) {
    const line = decodeEntities(raw).replace(/\s+/g, ' ').trim();
    if (line !== '') lines.push(line);
  }
  return lines.join('\n');
}

/**
 * True when a line the agent says it copied from a page really is on that page. Both sides are read as
 * plain text, with whitespace collapsed and letters lower-cased. No page, or an empty line, is never a match.
 */
export function lineOnPage(line: string, html: string | null): boolean {
  if (html === null || html === '') return false;
  const flat = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();
  const wanted = flat(line);
  return wanted !== '' && flat(toText(html)).includes(wanted);
}
