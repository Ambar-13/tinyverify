/**
 * The demo page at GET /. One search bar over a halftone picture, the latest answer in one card, and the watched
 * licences in a side panel. The page is server-rendered with one inline style and two inline scripts: the picture
 * (scene.ts) and the page script below. The page script talks to this same origin only.
 *
 * Answers are built with DOM calls and textContent, never innerHTML, so registry text cannot inject markup.
 * PURE_SOURCE holds the functions that read typed text and write the sentences. It has no DOM, so tests run it as it
 * is.
 */

import { Hono } from 'hono';
import golden from '../golden.json';
import { COUNTRY_NAMES, STATE_NAMES } from '../lookup/places';
import { registries } from '../registries/catalog';
import type { Jurisdiction, RecordType, RegistryId } from '../types';
import { SCENE_SOURCE } from './scene';
// Loading the adapters is what tells the support table which registries are connected.
import '../registries/index';

/** The example presses check golden records (src/golden.json), found by registry and leading letters. */
const goldenNumber = (registry: string, prefix: string): string => {
  const found = golden.records.find((r) => r.registry === registry && r.licence_number.startsWith(prefix));
  if (!found) throw new Error(`src/golden.json has no ${registry} record starting ${prefix}`);
  return found.licence_number;
};

export const EXAMPLES: { label: string; number: string; kind: RecordType; place: Jurisdiction }[] = [
  { label: 'A doctor in Florida', number: goldenNumber('fl-mqa', 'ME'), kind: 'physician', place: 'US-FL' },
  { label: 'A nurse in Florida', number: goldenNumber('fl-mqa', 'RN'), kind: 'nurse', place: 'US-FL' },
  { label: 'A contractor in California', number: goldenNumber('ca-cslb', ''), kind: 'contractor', place: 'US-CA' },
];

const KIND_LABELS: Record<RecordType, string> = {
  physician: 'Doctor',
  nurse: 'Nurse',
  dentist: 'Dentist',
  pharmacist: 'Pharmacist',
  contractor: 'Contractor',
  company: 'Company',
};
const KIND_ORDER: RecordType[] = ['physician', 'nurse', 'dentist', 'pharmacist', 'contractor', 'company'];

const PLACE_LABELS: Record<Jurisdiction, string> = { 'US-FL': 'Florida', 'US-CA': 'California', AU: 'Australia' };

/** How a visitor hears about each registry: the board that runs it, and what its licences are called. */
const PLAIN: Record<RegistryId, { board: string; licence: string }> = {
  'fl-mqa': { board: "Florida's health board", licence: 'Florida health licence' },
  'fl-dbpr': { board: "Florida's contractor board", licence: 'Florida contractor licence' },
  'ca-cslb': { board: "California's contractor board", licence: 'California contractor licence' },
  'au-ahpra': { board: "Australia's health board", licence: 'Australian health licence' },
};

const esc = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const connected = () => registries.filter((r) => r.connected);

/** The facts the script reads. Read on each request, because a registry can be connected after this module loads. */
export function scriptFacts() {
  return {
    registries: connected().map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      jurisdiction: r.jurisdiction,
      types: r.types,
      read_route: r.read_route,
    })),
    plain: Object.fromEntries(connected().map((r) => [r.id, PLAIN[r.id]])),
  };
}

/**
 * The places in the list. A place this service reads by itself is sent as its code and listed first. A country whose
 * registry is known but not connected yet is left out, so the list holds only places a check can run for.
 */
export function listedPlaces(): { states: { value: string; label: string }[]; countries: string[] } {
  const own = new Map<string, Jurisdiction>(connected().map((r) => [PLACE_LABELS[r.jurisdiction], r.jurisdiction]));
  const waiting = new Set(registries.filter((r) => !r.connected).map((r) => PLACE_LABELS[r.jurisdiction]));
  const rest = STATE_NAMES.filter((name) => !own.has(name)).map((name) => ({ value: name, label: name }));
  return {
    states: [...[...own].map(([label, value]) => ({ value, label })), ...rest],
    countries: COUNTRY_NAMES.filter((name) => !waiting.has(name)),
  };
}

const STYLE = `
:root{--paper:#fffffe;--card:#ffffff;--ink:#1c1a17;--muted:#6f675f;--line:#e3e3e3;--wash:#f6f6f6;--grad:linear-gradient(90deg,#c2410c 0%,#be185d 42%,#6d28d9 100%);--display:'Bricolage Grotesque',system-ui,sans-serif;--text:'Hanken Grotesk',system-ui,sans-serif;--expo:cubic-bezier(.16,1,.3,1);color-scheme:light}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{height:100%}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--text);font-size:16px;line-height:1.5;overflow:hidden;overflow-wrap:anywhere}
button,input,select{font:inherit;color:inherit}
button{cursor:pointer}
:where(button,a,input,select){border-radius:0;-webkit-tap-highlight-color:transparent}
:where(button,a,input,select):focus{outline:none}
a{color:inherit;text-underline-offset:3px}
a:focus-visible{text-decoration-thickness:2px}
p{margin:0}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
#ht{position:fixed;inset:0;width:100%;height:100%;display:block;z-index:0}
.ui{position:relative;z-index:2}
.rise{animation:rise 1.2s var(--expo) both}
.arrive{animation:rise .9s var(--expo) both}
@keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
.top{position:fixed;top:0;left:0;right:0;z-index:5;display:flex;justify-content:space-between;align-items:center;padding:22px 4vw}
.mark{font-family:var(--display);font-weight:700;font-size:22px;letter-spacing:-0.03em;text-decoration:none}
.pill{border:1px solid var(--line);background:var(--card);padding:8px 14px;font-size:15px;transition:border-color .3s}
.pill:hover,.pill:focus-visible{border-color:#bdbdbd}
.pill .n{display:inline-grid;place-items:center;min-width:22px;height:22px;margin-left:8px;background:var(--ink);color:var(--paper);font-size:13px;font-variant-numeric:tabular-nums}
.ask{position:fixed;z-index:4;left:50%;top:21vh;translate:-50% 0;width:min(720px,calc(100vw - 32px))}
.bar{display:flex;align-items:stretch;padding:6px;background:var(--card);border:1px solid var(--line);box-shadow:0 8px 24px rgba(0,0,0,.06);transition:border-color .3s,box-shadow .5s var(--expo)}
.bar:focus-within{border-color:#c9c9c9;box-shadow:0 10px 30px rgba(0,0,0,.09)}
.bar label{display:flex;flex-direction:column;justify-content:center;padding:4px 16px;transition:background .3s}
.bar label+label{border-left:1px solid var(--line)}
.bar label:focus-within{background:var(--wash)}
.bar label>span{font-size:13px;color:var(--muted);line-height:1.2}
.bar input,.bar select{border:0;background:transparent;padding:1px 0;font-size:16px;width:100%;min-width:0}
input::placeholder{color:#a39a90}
.bar select{appearance:none;-webkit-appearance:none;cursor:pointer;padding-right:16px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='7' viewBox='0 0 10 7'%3E%3Cpath d='M1 1.2l4 4 4-4' fill='none' stroke='%231c1a17' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 1px center}
.q{flex:1.6}.prof{flex:1}.place{flex:1.05}
.go{flex:none;border:0;background:var(--grad);background-size:180% 100%;background-position:0% 0;color:#fff;padding:0 24px;font-size:16px;font-weight:500;display:flex;align-items:center;gap:10px;transition:background-position .8s var(--expo)}
.go:hover,.go:focus-visible{background-position:100% 0}
.go:disabled{opacity:.6;cursor:progress}
.go svg{transition:translate .5s var(--expo)}
.go:hover svg{translate:3px 0}
.narrow{display:flex;gap:8px;margin-top:14px}
.narrow input,.panel input{flex:1;width:100%;min-width:0;border:1px solid var(--line);background:var(--card);padding:9px 14px;font-size:15px}
.narrow input:focus,.panel input:focus{border-color:#bdbdbd}
.under{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:8px;margin:12px 0 0;text-align:center;font-size:15px;color:var(--muted);min-height:24px}
.under,.claim,.foot,.mark{text-shadow:-1.5px 0 var(--paper),1.5px 0 var(--paper),0 -1.5px var(--paper),0 1.5px var(--paper),-1px -1px var(--paper),1px 1px var(--paper),-1px 1px var(--paper),1px -1px var(--paper),0 0 6px var(--paper)}
.chip{border:1px solid var(--line);background:var(--card);padding:7px 12px;font-size:15px;color:var(--ink);text-shadow:none;box-shadow:0 2px 8px rgba(0,0,0,.05);transition:border-color .3s,background .3s}
.chip:hover,.chip:focus-visible{border-color:#bdbdbd;background:#fafafa}
#now{color:var(--ink)}
#own-line{margin-top:8px}
.claim{position:fixed;z-index:2;right:4vw;top:47vh;text-align:right;font-size:19px;line-height:1.35;max-width:22ch}
.claim span{color:var(--muted)}
.card{position:fixed;z-index:4;right:4vw;top:calc(21vh + 178px);width:380px;max-height:calc(79vh - 202px);overflow:auto;background:var(--card);border:1px solid var(--line);padding:24px 24px 20px;box-shadow:0 12px 36px rgba(0,0,0,.08)}
.rec+.rec{margin-top:24px;padding-top:24px;border-top:1px solid var(--line)}
.k{font-size:14px;color:var(--muted)}
.card h2{font-family:var(--display);font-weight:700;font-size:34px;line-height:1;letter-spacing:-0.035em;margin:6px 0 4px}
.role{color:var(--muted)}
.say{font-weight:600;margin-top:12px}
.card dl{display:grid;grid-template-columns:1fr 1fr;gap:14px 18px;margin:16px 0 0;padding-top:16px;border-top:1px solid var(--line)}
dt{font-size:13px;color:var(--muted)}
dd{margin:2px 0 0;font-weight:500;font-variant-numeric:tabular-nums}
.disc{margin:14px 0 0;padding-top:14px;border-top:1px solid var(--line)}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.actions:empty{display:none}.actions+.small{margin-top:12px}
.btn{display:inline-block;border:1px solid var(--line);background:var(--card);padding:9px 15px;font-size:15px;text-decoration:none;transition:background .3s,border-color .3s,color .3s}
.btn:hover,.btn:focus-visible{border-color:#bdbdbd}
.btn.dark{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.choice{display:block;width:100%;text-align:left;border:1px solid var(--line);background:var(--card);padding:12px 14px;margin-top:10px;transition:background .3s,border-color .3s}
.choice:hover,.choice:focus-visible{border-color:#bdbdbd;background:#fafafa}
.choice b{display:block;font-weight:600}
.choice span,.small{font-size:14px;color:var(--muted)}
.extract{margin-top:16px;padding:14px 16px;background:var(--wash);font-size:14px}
.extract p{margin:0 0 8px}
blockquote{margin:0 0 8px 12px;color:var(--muted)}
figure{margin:8px 0 0}
img{max-width:100%;height:auto;border:1px solid var(--line)}
figcaption{color:var(--muted)}
.panel{position:fixed;z-index:8;top:12px;right:12px;bottom:12px;width:min(400px,calc(100vw - 24px));background:var(--card);border:1px solid var(--line);box-shadow:0 16px 48px rgba(0,0,0,.12);padding:22px;display:flex;flex-direction:column}
.panel header{display:flex;justify-content:space-between;align-items:center}
.panel h2{font-family:var(--display);font-weight:700;font-size:30px;letter-spacing:-0.03em;margin:0}
.panel h3{font-size:16px;font-weight:600;margin:0 0 6px}
.sub{margin:6px 0 10px;color:var(--muted);font-size:15px}
.scroll{overflow:auto;margin-right:-10px;padding-right:10px}
.w,.sec{padding:14px 0;border-top:1px solid var(--line)}#watched>p{padding-bottom:14px}
.w b{display:block;font-weight:600}
.changed{color:#9a5b16}
.panel label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}
.watch .small{margin-top:10px}
.x{border:0;background:transparent;width:38px;height:38px;display:grid;place-items:center;transition:background .3s}
.x:hover,.x:focus-visible{background:#f2f2f2}
.foot{position:fixed;z-index:2;right:4vw;bottom:24px;font-size:14px;color:var(--muted)}
@media (max-width:860px){
.top{padding:16px}
.ask{top:76px}
.bar{display:grid;grid-template-columns:1fr 1fr;padding:0}
.bar label{padding:10px 14px}
.bar label+label{border-left:0}
.q{grid-column:1;grid-row:1}
.go{grid-column:2;grid-row:1;justify-content:center;padding:0 16px;margin:-1px -1px 0 0}
.prof{grid-column:1;grid-row:2;border-top:1px solid var(--line)}
.bar .place{grid-column:2;grid-row:2;border-top:1px solid var(--line);border-left:1px solid var(--line)}
.claim,.foot{display:none}
.card{left:16px;right:16px;width:auto;top:auto;bottom:16px;max-height:52vh;padding:18px 18px 16px}
.card h2{font-size:28px}
.card dl{margin-top:12px;padding-top:12px;gap:10px 14px}
.actions{margin-top:14px}
.choice{padding:10px 12px;margin-top:8px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`.replace(/\n/g, '');

const ARROW =
  '<svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true"><path d="M1 6h13m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CROSS =
  '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2 2 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

const option = (value: string, label: string): string => `<option value="${esc(value)}">${esc(label)}</option>`;

function placeOptions(): string {
  const { states, countries } = listedPlaces();
  const group = (label: string, options: string[]): string =>
    `<optgroup label="${label}">${options.join('')}</optgroup>`;
  return (
    group(
      'United States',
      states.map((s) => option(s.value, s.label)),
    ) +
    group(
      'Other countries',
      countries.map((name) => option(name, name)),
    )
  );
}

function exampleLine(): string {
  const chips = EXAMPLES.map((e, i) => `<button type="button" class="chip" id="eg${i}">${esc(e.label)}</button>`);
  return `<span>Try</span>${chips.join('')}`;
}

const bodyHtml = (): string => `
<canvas id="ht" aria-hidden="true"></canvas>
<h1 class="sr-only">TinyVerify: professional licences, checked at the official registry</h1>
<header class="top ui rise">
<a class="mark" href="/" id="home">TinyVerify</a>
<button class="pill" id="watchBtn" type="button" aria-haspopup="dialog">Watched licences<span class="n" id="wc">0</span></button>
</header>
<div class="ask ui rise" id="ask">
<form class="bar" id="lookup" novalidate>
<label class="q"><span>Name or licence number</span><input id="q" type="text" placeholder="Alex Morgan" autocomplete="off" spellcheck="false"></label>
<label class="prof"><span>Who or what</span><select id="kind">${KIND_ORDER.map((k) => option(k, KIND_LABELS[k])).join('')}</select></label>
<label class="place"><span>Place</span><select id="place">${placeOptions()}</select></label>
<button class="go" id="go" type="submit"><span id="go-label">Check</span>${ARROW}</button>
</form>
<div class="under" id="eg">${exampleLine()}</div>
<p class="under" id="now" aria-live="polite" hidden></p>
<p class="under" id="own-line"><span id="own-say">Free checks are limited each day.</span> <button type="button" class="chip" id="ownBtn" aria-haspopup="dialog">Use your own TinyFish key</button></p>
<noscript><p class="under">This page needs JavaScript to check a licence.</p></noscript>
</div>
<p class="claim ui rise">Professional licences,<br><span>checked at the official registry. Any US state, and six countries.</span></p>
<section class="card ui" id="card" aria-live="polite" hidden></section>
<aside class="panel ui" id="panel" role="dialog" aria-modal="false" aria-labelledby="panelTitle" hidden>
<header><h2 id="panelTitle">Watched licences</h2><button class="x" id="panelClose" type="button" aria-label="Close">${CROSS}</button></header>
<div class="scroll">
<div id="view-watch">
<p class="sub">Each licence here is read again every day. A change of status is recorded.</p>
<div id="watched"><p class="small">Loading the watched licences.</p></div>
<div class="sec"><button type="button" class="btn" id="statusBtn">Is everything answering?</button></div>
</div>
<div id="view-key" hidden>
<p class="sub">Free checks share a small daily allowance. With your own TinyFish key there is no limit: each check is charged to your TinyFish account, usually 10 to 60 cents.</p>
<p class="sub">The key is used for your check only, held encrypted while that check is under way, and deleted when it ends.</p>
<label for="own">TinyFish key</label><input id="own" type="password" autocomplete="off">
<p id="own-msg" class="small" aria-live="polite">Kept in this tab only.</p>
</div>
<div id="view-status" hidden>
<div id="health"><p class="small">Loading the service status.</p></div>
<p class="sub">Any other US state or country has no line here. Its registry is found and read at the time of each check.</p>
</div>
</div>
</aside>
<p class="foot ui rise">Built with <a href="https://www.tinyfish.ai" target="_blank" rel="noopener noreferrer">TinyFish</a>. Read live from the official registry.</p>
`;

/**
 * Reads typed text and writes every sentence the page shows. No DOM here. F is the facts object; now is always passed in.
 */
export const PURE_SOURCE = String.raw`
var TV = (function () {
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var GENERIC = 'Something went wrong on our side. Nothing was checked.';
  var STATUS = {
    probation: 'Licensed, on probation.',
    suspended: 'Not in good standing. This licence is suspended.',
    revoked: 'Not in good standing. This licence was revoked.',
    delinquent: 'Not in good standing. This licence is delinquent.',
    expired: 'This licence has expired.',
    surrendered: 'This licence was given up.',
    inactive: 'This licence is inactive.',
    pending: 'This licence has not been issued yet.'
  };
  var FIELD = { name: 'name', record_type: 'kind', jurisdiction: 'place', city: 'city' };
  var COMPLAINTS_UNCHECKED = 'Complaints could not be checked.';

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function dayKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function dateWords(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    if (!m || !MONTHS[+m[2] - 1]) return String(iso || '');
    return MONTHS[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1];
  }

  function clock(d) {
    var h = d.getHours();
    return (h % 12 || 12) + ':' + pad(d.getMinutes()) + ' ' + (h < 12 ? 'AM' : 'PM');
  }

  // "today at 8:21 PM", "tomorrow at 3:00 AM", or "November 5 at 9:02 AM".
  function when(iso, now) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var day = dayKey(d);
    var t = clock(d);
    if (day === dayKey(now)) return 'today at ' + t;
    if (day === dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))) return 'tomorrow at ' + t;
    if (day === dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'yesterday at ' + t;
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ' at ' + t;
  }

  function safeUrl(value) { return typeof value === 'string' && /^https:\/\/[^\s]+$/i.test(value) ? value : null; }

  // ---- reading typed text

  // A text is a licence number when it holds a digit and, without its spaces, dots and dashes, is letters and digits
  // with at most four letters. "ME 123456" is a number; "21st Century Roofing" is a name.
  function readQuery(raw) {
    var text = (raw || '').replace(/\s+/g, ' ').trim();
    if (!text) return { mode: 'empty' };
    var compact = text.replace(/[\s.-]/g, '').toUpperCase();
    var letters = compact.replace(/[^A-Z]/g, '').length;
    if (/\d/.test(compact) && /^[A-Z0-9]+$/.test(compact) && letters <= 4) return { mode: 'number', number: compact };
    return { mode: 'name', name: text };
  }

  // ---- the record

  function pastExpiry(expires, now) { return /^\d{4}-\d{2}-\d{2}/.test(expires || '') && expires.slice(0, 10) < dayKey(now); }

  // A company has a registration where a person has a licence. The sentences are the same with that one word changed.
  function isCompany(r) { return ((r || {}).query || {}).record_type === 'company'; }
  function forCompany(sentence) { return sentence.replace('This licence', 'This registration').replace('the licence', 'the registration').replace('this licence', 'this registration'); }

  function verdict(rec, now, company) {
    var l = rec.licence;
    var said;
    if (l.status === 'active') {
      if (!pastExpiry(l.expires, now)) return company ? 'Registered and active.' : 'Licensed and active.';
      said = 'Listed as active, but the licence passed its expiry date.';
    } else if (STATUS.hasOwnProperty(l.status)) said = STATUS[l.status];
    else if (!l.status_raw) said = 'The registry gives no status for this licence.';
    else said = 'The registry lists a status this service does not know: \u201c' + l.status_raw + '\u201d.';
    return company ? forCompany(said) : said;
  }

  // The line under the name: what the licence is, and the city when the registry gives one.
  function role(rec) { return [rec.licence.type, rec.subject.city].filter(Boolean).join(', '); }

  // The facts of the record as label and value. A date the registry does not show is left out.
  function rows(rec, now, company) {
    var l = rec.licence, out = [[company ? 'Registration number' : 'Licence', rec.key.licence_number]];
    if (l.status_raw) out.push(['Status on the registry', l.status_raw]);
    if (l.expires) out.push([pastExpiry(l.expires, now) ? 'Expired' : 'Valid until', dateWords(l.expires)]);
    if (l.issued) out.push(['First issued', dateWords(l.issued)]);
    return out;
  }

  // The large word behind the page and what the fish do: a tick only for a licence in good standing.
  var WORD = {
    probation: 'On probation.', suspended: 'Suspended.', revoked: 'Revoked.', delinquent: 'Delinquent.',
    expired: 'Expired.', surrendered: 'Given up.', inactive: 'Inactive.', pending: 'Not issued.'
  };
  var OUTCOME_WORD = {
    multiple_matches: 'Which one?', no_match: 'Not found.', needs_review: 'No answer.',
    source_unavailable: 'No answer.', unsupported: 'Not covered.'
  };
  function picture(r, now) {
    var rec = (r.records || [])[0];
    if (rec) {
      var l = rec.licence;
      if (l.status === 'active') return pastExpiry(l.expires, now) ? { word: 'Past expiry.', fish: 'hide' } : { word: 'Active.', fish: 'check' };
      return { word: WORD.hasOwnProperty(l.status) ? WORD[l.status] : 'Unclear.', fish: 'hide' };
    }
    if (OUTCOME_WORD.hasOwnProperty(r.outcome)) return { word: OUTCOME_WORD[r.outcome], fish: r.outcome === 'multiple_matches' ? 'orbit' : 'hide' };
    return { word: 'TinyVerify', fish: 'swim' };
  }

  function discipline(d, partial) {
    if (partial) return { head: 'Checking public complaints\u2026', actions: [] };
    if (!d || !d.checked || d.on_file === null) {
      var plain = d && d.reason && /^[A-Z][^_]*\.$/.test(d.reason);
      return { head: COMPLAINTS_UNCHECKED + (plain ? ' ' + d.reason : ''), actions: [] };
    }
    if (!d.on_file) return { head: 'No discipline or complaints on file.', actions: [] };
    var n = (d.actions || []).length;
    return { head: n ? n + (n === 1 ? ' complaint' : ' complaints') + ' on file.' : 'Complaints are on file.', actions: d.actions || [] };
  }

  function warnings(rec, now) {
    var out = [], l = rec.licence, w = rec.warnings || [];
    if (l.status === 'active' && l.expires && /^\d{4}-\d{2}-\d{2}/.test(l.expires) && !pastExpiry(l.expires, now)) {
      var e = l.expires.split('-');
      var days = (Date.UTC(+e[0], +e[1] - 1, +e[2].slice(0, 2)) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000;
      if (days <= 60) out.push('This licence expires soon.');
    }
    if (w.indexOf('no_expiry_on_record') >= 0) out.push('The registry shows no expiry date.');
    if (w.indexOf('agent_answer_differs') >= 0) out.push("The page was read directly; a helper's summary of it differed and was ignored.");
    return out;
  }

  function quiet(rec, checkedAt, now) {
    var n = ((rec.verification || {}).readers || []).length;
    var routed = (rec.registry || {}).id === 'generic';
    var how = routed ? 'A helper found this record; every value shown was then checked against the official page.' : n === 1 ? 'Read once from the official page.' : n === 2 ? 'Read twice from the official page; both readings agree.' : 'Read ' + n + ' times from the official page; all readings agree.';
    return checkedAt ? how + ' Checked ' + when(checkedAt, now) + '.' : how;
  }

  // ---- the other outcomes: head, optional sub line, candidate rows, and a link

  function registryLink(id, text) {
    var info = F.registries.filter(function (r) { return r.id === id; })[0];
    var href = info && safeUrl(info.url);
    return href ? { href: href, text: text } : undefined;
  }

  function outcome(r, now) {
    var first = (r.searched && r.searched.registries || [])[0];
    var company = isCompany(r);
    switch (r.outcome) {
      case 'multiple_matches':
        var list = r.candidates || [];
        var total = r.candidates_total || list.length;
        return {
          head: 'Found ' + total + (company ? (total === 1 ? ' company' : ' companies') : total === 1 ? ' licence' : ' licences') + ' under that name. Pick the one you mean.',
          sub: total > list.length ? 'Showing the first ' + list.length + '. Add a city or use the ' + (company ? 'registration' : 'licence') + ' number to narrow it.' : undefined,
          rows: list.map(function (c) {
            return { id: c.candidate_id, name: c.name, meta: [c.licence_type, c.city, c.status_raw].filter(Boolean).join(', ') };
          })
        };
      case 'no_match':
        var thing = company ? 'company' : 'licence';
        return (r.query || {}).licence_number
          ? { head: 'No ' + thing + ' found with that number.', sub: 'Check the number, or try searching by name.' }
          : { head: 'No ' + thing + ' found for that name.', sub: 'Check the spelling, or try the ' + (company ? 'registration' : 'licence') + ' number.' };
      case 'needs_review':
        var found = r.unsupported || {};
        var official = safeUrl(found.registry_url);
        var open = official ? { href: official, text: 'Open the official registry' } : undefined;
        var marks = r.warnings || [];
        if (marks.indexOf('several_results') >= 0) return { head: found.message || 'The registry lists several records under that name.', link: open };
        if (marks.indexOf('not_grounded') >= 0) return { head: 'No answer. The official page could not be read with confidence, so nothing is shown.', link: open };
        return { head: 'No answer. The two readings of the official page did not agree, so nothing is shown.', link: registryLink(first, 'Open the official record') };
      case 'source_unavailable':
        // A place this service does not read by itself keeps the link to its official registry, whatever went wrong.
        var u = r.unavailable || {};
        var official = safeUrl((r.unsupported || {}).registry_url);
        var toRegistry = official ? { href: official, text: 'Open the official registry' } : undefined;
        if (u.reason === 'maintenance') {
          var board = F.plain[first] ? F.plain[first].board : 'The registry';
          return { head: board + ' is closed for maintenance' + (u.retry_after ? ' until ' + when(u.retry_after, now) : '') + '.', link: toRegistry };
        }
        if (u.reason === 'budget') return { head: "Today's free checks are used up. They start again tomorrow.", link: toRegistry };
        if (u.reason === 'rate_limited') return { head: 'Too many checks are under way. Try again in a minute.', link: toRegistry };
        return { head: 'The registry is not answering right now.', link: toRegistry };
      case 'unsupported':
        var s = r.unsupported || {};
        var href = safeUrl(s.registry_url);
        return { head: company ? 'This service could not find the official company register there.' : 'This service does not read that kind of licence there yet.', link: href ? { href: href, text: 'Open the official registry' } : undefined };
      case 'invalid_input':
        var v = r.invalid || {};
        if (/[a-z]+_[a-z]+/.test(v.expected || '') || !v.expected) return { head: GENERIC };
        return { head: v.field === 'licence_number' ? v.expected + '.' : 'The ' + (FIELD[v.field] || 'input') + ' needs ' + v.expected + '.' };
      default:
        return { head: GENERIC };
    }
  }

  function limitText(resetsAt, now) {
    return 'The free checks from this address are used up for now. They start again ' + (resetsAt ? when(resetsAt, now) : 'within the hour') + '.';
  }

  function waitText(state) { return state === 'reading' ? 'Found the record. Reading it\u2026' : 'Looking on the official registry\u2026'; }

  // ---- watches and status

  function statusWord(f) {
    if (!f) return '';
    return f.status && f.status !== 'other' ? f.status : f.status_raw || '';
  }

  function eventLine(ev, now) {
    var t = cap(when(ev.created_at, now)) + ': ';
    if (ev.kind === 'unchanged') return t + 'no change.';
    if (ev.kind === 'status_change') {
      var before = statusWord(ev.before), after = statusWord(ev.after);
      return t + (before && after ? 'status changed from ' + before + ' to ' + after + '.' : 'status changed.');
    }
    return t + 'the check could not be completed.';
  }

  function watchTitle(w) { return (F.plain[w.registry] ? F.plain[w.registry].licence : 'Licence') + ' ' + w.licence_number; }

  function healthLine(id, health) {
    var board = F.plain[id] ? F.plain[id].board : 'The registry';
    return board + ': ' + (health === 'ok' ? 'answering' : health === 'degraded' ? 'not answering' : 'not checked yet today') + '.';
  }

  function statusLines(s) {
    var byId = {};
    (s.registries || []).forEach(function (r) { byId[r.id] = r.health; });
    var lines = F.registries.map(function (r) { return healthLine(r.id, byId[r.id]); });
    lines.push('TinyFish: ' + (s.tinyfish === 'ok' ? 'answering' : s.tinyfish === 'unreachable' ? 'not answering' : 'not checked yet today') + '.');
    var left = (s.budget || {}).public;
    lines.push('Free checks left today: ' + (left === 'ok' ? 'yes' : left === 'low' ? 'running low' : 'not known') + '.');
    return lines;
  }

  return {
    GENERIC: GENERIC, readQuery: readQuery, isCompany: isCompany, verdict: verdict, role: role, rows: rows, picture: picture,
    discipline: discipline, warnings: warnings, quiet: quiet, outcome: outcome, limitText: limitText, waitText: waitText,
    eventLine: eventLine, watchTitle: watchTitle, healthLine: healthLine, statusLines: statusLines,
    clock: clock, when: when, safeUrl: safeUrl
  };
})();
`;

/**
 * The part that touches the page. It is plain JavaScript, written with String.raw so the backslashes stay.
 * Scene is the picture behind the page (scene.ts): Scene.word prints a word, Scene.mode moves the fish.
 */
const UI_SOURCE = String.raw`
(function () {
  'use strict';
  var POLL_MS = 3000;
  var NETWORK = 'The service could not be reached. Check the connection and try again.';
  var key = '', ownKey = '', token = 0, pollTimer = null, view = 'watch';
  var current = null, reading = '', slow = false, city = '';

  function $(id) { return document.getElementById(id); }
  var q = $('q'), go = $('go'), card = $('card'), panel = $('panel');

  function h(tag, props, kids) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (name) {
      var value = props[name];
      if (name === 'text') node.textContent = value;
      else if (name === 'className') node.className = value;
      else if (name === 'onclick') node.addEventListener('click', value);
      else if (value !== null && value !== undefined && value !== false) node.setAttribute(name, value === true ? '' : value);
    });
    (kids || []).forEach(function (kid) {
      if (kid === null || kid === undefined || kid === false) return;
      node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function p(text, className) { return h('p', { text: text, className: className || '' }); }
  function press(label, onclick) { return h('button', { type: 'button', className: 'btn', text: label, onclick: onclick }); }
  function newTab(href, text, className) { return h('a', { href: href, target: '_blank', rel: 'noopener noreferrer', text: text, className: className || '' }); }

  function api(method, path, body) {
    var opts = { method: method, headers: {} };
    if (key) opts.headers.Authorization = 'Bearer ' + key;
    // The visitor's own TinyFish key goes with a check and with nothing else.
    if (ownKey && method === 'POST' && path === '/verify') opts.headers['X-TinyFish-Key'] = ownKey;
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (res) {
      return res.json().then(
        function (data) { return { status: res.status, ok: res.ok, data: data || {} }; },
        function () { return { status: res.status, ok: res.ok, data: {} }; }
      );
    });
  }

  // ---- the line under the search bar: the examples, or what is happening now

  function tell(kids) {
    var now = clear($('now'));
    kids.forEach(function (kid) { if (kid) now.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid); });
    now.hidden = false;
    $('eg').hidden = true;
  }

  function idle() {
    $('now').hidden = true;
    $('eg').hidden = false;
  }

  function setBusy(on) {
    go.disabled = on;
    if (on) go.setAttribute('aria-disabled', 'true'); else go.removeAttribute('aria-disabled');
    $('go-label').textContent = on ? 'Checking…' : 'Check';
  }

  function showWait(r) {
    var live = r && r.streaming_url ? TV.safeUrl(r.streaming_url) : null;
    var long = slow ? 'This can take up to three minutes.' : 'This can take up to a minute.';
    tell([reading + TV.waitText(r ? r.state : 'queued') + ' ' + long + (live ? ' ' : ''), live ? newTab(live, 'Watch it work') : null]);
  }

  // ---- asking

  // Only a licence number on a registry whose record page is read directly answers within a minute. A name search,
  // and any place this service does not read by itself, has a form worked on the spot and can take about three.
  function isQuick(mode, kind, place) {
    return mode === 'number' && F.registries.some(function (r) {
      return r.jurisdiction === place && r.types.indexOf(kind) >= 0 && r.read_route === 'fetch';
    });
  }

  // A person is searched by last name and first name. A business can have a one-word name.
  function needsFullName(r, kind) {
    return r.mode === 'name' && kind !== 'contractor' && kind !== 'company' && r.name.indexOf(' ') < 0;
  }

  function run() {
    var r = TV.readQuery(q.value);
    if (r.mode === 'empty') { tell(['Type a name or a licence number first.']); q.focus(); return; }
    if (needsFullName(r, $('kind').value)) { tell(['Type the first and last name, or the licence number.']); q.focus(); return; }
    var body = { record_type: $('kind').value, jurisdiction: $('place').value, include_complaints: true };
    if (r.mode === 'number') body.licence_number = r.number;
    else {
      body.name = r.name;
      if (city) body.city = city;
    }
    reading = r.mode === 'number' ? 'Read as a licence number. ' : 'Read as a name. ';
    slow = !isQuick(r.mode, body.record_type, body.jurisdiction);
    begin(function () { return api('POST', '/verify', body); });
  }

  function refine(checkId, candidateId) {
    reading = '';
    begin(function () { return api('POST', '/verify', { check_id: checkId, candidate_id: candidateId }); });
  }

  // ---- the card

  function showCard(nodes) {
    clear(card);
    nodes.forEach(function (n) { if (n) card.appendChild(n); });
    card.className = 'card ui arrive';
    card.scrollTop = 0;
    card.hidden = false;
  }

  function hideCard() { card.hidden = true; }

  function paint(r) {
    var pic = TV.picture(r, new Date());
    Scene.word(pic.word);
    Scene.mode(pic.fish);
    return pic;
  }

  function showText(text) {
    current = null;
    paint({});
    idle();
    showCard([p(text, 'say')]);
  }

  function evidencePath(url) {
    if (!url) return null;
    try {
      var u = new URL(url, location.href);
      return u.origin === new URL(location.href).origin && u.pathname.indexOf('/evidence/') === 0 ? u.pathname : null;
    } catch (e) { return null; }
  }

  // The proof: the link to the official record, what the page says, and the picture of the page when one was kept.
  function proofView(rec) {
    var kids = [];
    var href = TV.safeUrl(rec.source_url);
    if (href) kids.push(h('p', null, [newTab(href, 'Open the official record'), h('span', { className: 'small', text: ' ' + rec.registry.name })]));
    else if (rec.source_lookup) kids.push(p(rec.source_lookup));
    var quotes = ((rec.evidence || {}).quotes || []).filter(function (x, i, all) { return all.indexOf(x) === i; }).slice(0, 8);
    if (quotes.length) {
      kids.push(p('What the page says:'));
      quotes.forEach(function (x) { kids.push(h('blockquote', { text: x })); });
    }
    var shot = (rec.discipline || {}).screenshot_url, caption = 'The complaints page as it was read';
    if (!shot) { shot = (rec.evidence || {}).screenshot_url; caption = 'The official page as it was read'; }
    var path = evidencePath(shot);
    if (path) kids.push(h('figure', null, [h('img', { src: path, alt: caption, loading: 'lazy' }), h('figcaption', { text: caption })]));
    TV.warnings(rec, new Date()).forEach(function (w) { kids.push(p(w)); });
    var box = h('div', { className: 'extract', hidden: true }, kids);
    var toggle = press('See the proof', function () {
      box.hidden = !box.hidden;
      toggle.setAttribute('aria-expanded', box.hidden ? 'false' : 'true');
      toggle.textContent = box.hidden ? 'See the proof' : 'Hide the proof';
    });
    toggle.setAttribute('aria-expanded', 'false');
    return { toggle: toggle, box: box };
  }

  // A watch needs a registry this service reads by itself.
  function watchable(rec) { return rec.registry.id !== 'generic'; }

  function fillDisc(box, d, partial) {
    var found = TV.discipline(d, partial);
    clear(box).appendChild(p(found.head, partial ? 'small' : ''));
    found.actions.forEach(function (a) { box.appendChild(p(a, 'small')); });
  }

  // The proof and the watch press are added once the answer is final.
  function finish(block, rec) {
    var proof = proofView(rec);
    var watch = watchable(rec) ? watchRow(rec) : null;
    block.actions.appendChild(proof.toggle);
    if (watch) block.actions.appendChild(press('Watch this licence', watch.start));
    if (watch) block.box.appendChild(watch.box);
    block.box.appendChild(proof.box);
  }

  function recordBlock(rec, r, partial) {
    var now = new Date();
    var disc = h('div', { className: 'disc' }, []);
    fillDisc(disc, rec.discipline, partial);
    var quiet = p(TV.quiet(rec, partial ? null : r.checked_at, now), 'small');
    var actions = h('div', { className: 'actions' }, []);
    var role = TV.role(rec);
    var company = TV.isCompany(r);
    var facts = TV.rows(rec, now, company).map(function (row) { return h('div', null, [h('dt', { text: row[0] }), h('dd', { text: row[1] })]); });
    var box = h('div', { className: 'rec' }, [
      p(rec.registry.name, 'k'),
      h('h2', { text: rec.subject.name || 'Licence ' + rec.key.licence_number }),
      role ? p(role, 'role') : null,
      p(TV.verdict(rec, now, company), 'say'),
      h('dl', null, facts),
      disc,
      actions,
      quiet
    ]);
    var block = { box: box, disc: disc, quiet: quiet, actions: actions };
    if (!partial) finish(block, rec);
    return block;
  }

  // The final answer for a record already on screen: only the complaints, the time line and the proof change.
  function fillIn(block, rec, r) {
    fillDisc(block.disc, rec.discipline, false);
    block.quiet.textContent = TV.quiet(rec, r.checked_at, new Date());
    finish(block, rec);
  }

  function isPartial(r) {
    return r.state !== 'done' && r.outcome === null && Array.isArray(r.records) && r.records.length > 0 &&
      Array.isArray(r.pending) && r.pending.indexOf('complaints') >= 0;
  }

  function showRecords(r, partial) {
    var blocks = r.records.map(function (rec) { return recordBlock(rec, r, partial); });
    current = { id: r.check_id, block: blocks[0] };
    paint(r);
    showCard(blocks.map(function (b) { return b.box; }));
  }

  // A common name gives many records. A city narrows the same search.
  function narrowRow() {
    var input = h('input', { type: 'text', placeholder: 'City', 'aria-label': 'City', autocomplete: 'off' });
    input.value = city;
    return h('div', { className: 'narrow' }, [input, press('Search in this city', function () { city = input.value.trim(); run(); })]);
  }

  // Every answer that is not a record: a short heading, the sentence, the records to choose from, and a link.
  function showOutcome(r) {
    var o = TV.outcome(r, new Date());
    var pic = paint(r);
    // The heading already says "No answer.", so the sentence under it does not say it again.
    var head = o.head.indexOf(pic.word + ' ') === 0 ? o.head.slice(pic.word.length + 1) : o.head;
    var kids = [pic.fish === 'swim' ? null : h('h2', { text: pic.word }), p(head, 'say')];
    if (o.sub) kids.push(p(o.sub, 'role'));
    if (r.outcome === 'multiple_matches') kids.push(narrowRow());
    (o.rows || []).forEach(function (row) {
      kids.push(h('button', { type: 'button', className: 'choice', onclick: function () { refine(r.check_id, row.id); } },
        [h('b', { text: row.name }), row.meta ? h('span', { text: row.meta }) : null]));
    });
    var spent = (r.unavailable || {}).reason === 'budget' && !ownKey;
    if (o.link || spent) {
      kids.push(h('div', { className: 'actions' }, [
        o.link ? newTab(o.link.href, o.link.text, 'btn') : null,
        spent ? press('Use my own TinyFish key', askOwnKey) : null
      ]));
    }
    current = null;
    showCard(kids);
  }

  // ---- checking

  function stopPolling() {
    if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
  }

  function failText(res) {
    var message = res.data && res.data.error && res.data.error.message;
    // With the visitor's own key the limit is not about free checks, so the service's own sentence is shown.
    if (res.status === 429) return ownKey && message ? message : TV.limitText(res.data.resets_at, new Date());
    return res.status === 400 && message ? message : TV.GENERIC;
  }

  // A check refused for its input answers 400 with the result as the body; the page shows that result.
  function refusedForInput(res) {
    return res.status === 400 && res.data.outcome === 'invalid_input' && !!res.data.check_id;
  }

  function fail(text) {
    setBusy(false);
    showText(text);
  }

  function begin(send) {
    var t = ++token;
    stopPolling();
    setBusy(true);
    current = null;
    hideCard();
    Scene.mode('search');
    showWait(null);
    send().then(function (res) {
      if (t !== token) return;
      if (!res.ok && !refusedForInput(res)) { fail(failText(res)); return; }
      handle(res.data, t);
    }, function () {
      if (t === token) fail(NETWORK);
    });
  }

  function poll(checkId, t) {
    stopPolling();
    pollTimer = setTimeout(function () {
      pollTimer = null;
      api('GET', '/verify/' + encodeURIComponent(checkId)).then(function (res) {
        if (t !== token) return;
        if (!res.ok) { fail(failText(res)); return; }
        handle(res.data, t);
      }, function () {
        if (t === token) poll(checkId, t);
      });
    }, POLL_MS);
  }

  function handle(r, t) {
    if (t !== token) return;
    if (!r || !r.check_id) { fail(TV.GENERIC); return; }
    if (r.state !== 'done') {
      if (isPartial(r)) { if (!current || current.id !== r.check_id) showRecords(r, true); }
      else if (!current) showWait(r);
      poll(r.check_id, t);
      return;
    }
    stopPolling();
    setBusy(false);
    idle();
    if (r.outcome === 'match' && r.records.length) {
      if (current && current.id === r.check_id && r.records.length === 1) fillIn(current.block, r.records[0], r);
      else showRecords(r, false);
    } else {
      showOutcome(r);
    }
    loadStatus();
  }

  // Back to the first screen. A check still under way is dropped.
  function home() {
    token++;
    stopPolling();
    setBusy(false);
    current = null;
    hideCard();
    idle();
    paint({});
  }

  // ---- the side panel: the watched licences, the visitor's own TinyFish key, or the service status

  var TITLES = { watch: 'Watched licences', key: 'Your own TinyFish key', status: 'Is everything answering?' };

  function openPanel(which) {
    view = which;
    $('panelTitle').textContent = TITLES[which];
    Object.keys(TITLES).forEach(function (name) { $('view-' + name).hidden = name !== which; });
    panel.className = 'panel ui arrive';
    panel.hidden = false;
    if (which === 'key') $('own').focus(); else $('panelClose').focus();
  }

  function closePanel() { panel.hidden = true; }

  function askOwnKey() { openPanel('key'); }

  function loadStatus() {
    api('GET', '/status').then(function (res) {
      var box = clear($('health'));
      if (!res.ok) { box.appendChild(p('The service status could not be loaded.', 'small')); return; }
      TV.statusLines(res.data).forEach(function (line) { box.appendChild(p(line, 'small')); });
    }, function () { clear($('health')).appendChild(p(NETWORK, 'small')); });
  }

  function loadWatches() {
    api('GET', '/watches/public').then(function (res) {
      var box = clear($('watched'));
      if (!res.ok) { box.appendChild(p('The watched licences could not be loaded.', 'small')); return; }
      var list = res.data.watches || [], now = new Date();
      $('wc').textContent = String(list.length);
      if (!list.length) box.appendChild(p('No licences are being watched.', 'small'));
      list.forEach(function (w) {
        var events = (w.events || []).slice(0, 3).map(function (e) {
          return p(TV.eventLine(e, now), e.kind === 'status_change' ? 'small changed' : 'small');
        });
        box.appendChild(h('div', { className: 'w' }, [h('b', { text: TV.watchTitle(w) })].concat(events)));
      });
    }, function () { clear($('watched')).appendChild(p(NETWORK, 'small')); });
  }

  // ---- watching the licence on the card

  var WATCH_NEEDS_KEY = 'Watching checks the official record every day and records what changed. It costs money to run, so it needs a key. Ask the owner of this service for one.';

  function reason(res, fallback) {
    var e = res.data && res.data.error;
    var text = e && e.message ? e.message : fallback;
    if (res.data && res.data.resets_at) text += ' Try again ' + TV.when(res.data.resets_at, new Date()) + '.';
    return text;
  }

  // The lines under a record for watching it: what is happening, the key when one is needed, and the two presses
  // once a watch exists. The key is asked for here, at the moment it is needed, and kept for the tab.
  function watchRow(rec) {
    var watchId = null;
    var note = p('', 'small');
    var input = h('input', { type: 'password', placeholder: 'Access key', 'aria-label': 'Access key for watching', autocomplete: 'off' });
    var ask = h('div', { className: 'narrow', hidden: true }, [input, press('Start watching', function () { key = input.value.trim(); start(); })]);
    var controls = h('div', { className: 'actions', hidden: true }, [press('Check it now', checkNow), press('Stop watching', stop)]);
    function tell(text) { note.textContent = text; }

    function start() {
      if (!key) {
        ask.hidden = false;
        tell(WATCH_NEEDS_KEY);
        input.focus();
        return;
      }
      ask.hidden = true;
      tell('Starting the watch…');
      api('POST', '/watch', { registry: rec.registry.id, licence_number: rec.key.licence_number, kind: 'record', name: rec.subject.name }).then(function (res) {
        if (!res.ok) {
          // A key the service does not know is asked for again.
          if (res.status === 401) { key = ''; ask.hidden = false; }
          tell(reason(res, 'The watch could not be started.'));
          return;
        }
        watchId = res.data.watch_id;
        controls.hidden = false;
        tell(res.data.pending ? 'Watching started. The record link is still being found.' : 'Watching started. It checks this licence every day.');
      }, function () { tell(NETWORK); });
    }

    function checkNow() {
      tell('Checking now…');
      api('POST', '/watch/' + encodeURIComponent(watchId) + '/check-now').then(function (res) {
        if (!res.ok) { tell(reason(res, 'The watch could not be checked now.')); return; }
        if (res.data.queued === false) tell(res.data.message || 'This licence was checked recently.');
        else if (res.data.queued === true) tell('It will be checked shortly.');
        else tell('Checked just now.');
      }, function () { tell(NETWORK); });
    }

    function stop() {
      api('DELETE', '/watch/' + encodeURIComponent(watchId)).then(function (res) {
        if (!res.ok) { tell(reason(res, 'The watch could not be stopped.')); return; }
        watchId = null;
        controls.hidden = true;
        tell('Watching stopped.');
      }, function () { tell(NETWORK); });
    }

    return { start: start, box: h('div', { className: 'watch' }, [note, ask, controls]) };
  }

  // ---- wiring

  $('lookup').addEventListener('submit', function (ev) { ev.preventDefault(); run(); });
  q.addEventListener('input', function () {
    if (!go.disabled) idle();
    city = '';
  });
  EXAMPLES.forEach(function (e, i) {
    $('eg' + i).addEventListener('click', function () {
      q.value = e.number;
      $('kind').value = e.kind;
      $('place').value = e.place;
      city = '';
      run();
    });
  });
  $('home').addEventListener('click', function (ev) { ev.preventDefault(); home(); });
  $('watchBtn').addEventListener('click', function () { if (panel.hidden || view !== 'watch') openPanel('watch'); else closePanel(); });
  $('ownBtn').addEventListener('click', askOwnKey);
  $('statusBtn').addEventListener('click', function () { openPanel('status'); });
  $('panelClose').addEventListener('click', closePanel);
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closePanel(); });
  $('own').addEventListener('input', function () {
    ownKey = $('own').value.trim();
    $('own-msg').textContent = ownKey ? 'Checks from this tab now use your key.' : 'Kept in this tab only.';
    $('own-say').textContent = ownKey ? 'Checks from this tab use your own TinyFish key.' : 'Free checks are limited each day.';
    $('ownBtn').textContent = ownKey ? 'Change it' : 'Use your own TinyFish key';
  });
  loadStatus();
  loadWatches();
})();
`;

/** A "</" inside a JSON string would end the script early, so "<" is escaped. */
const json = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

/** Indentation and whole-line comments are dropped from what is served; the source files keep them. */
const squeeze = (code: string): string =>
  code
    .replace(/^\s*\/\/.*\n/gm, '')
    .replace(/^[ \t]+/gm, '')
    .replace(/\n{2,}/g, '\n');

const examplesForScript = () => EXAMPLES.map(({ number, kind, place }) => ({ number, kind, place }));

const script = (): string =>
  `var F = ${json(scriptFacts())};\nvar EXAMPLES = ${json(examplesForScript())};\n${squeeze(PURE_SOURCE + UI_SOURCE)}`;

const FONTS =
  'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Hanken+Grotesk:wght@400;500;600&display=swap';

const renderPage = (): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="description" content="Check a professional licence at the official registry, and see the page the answer was read from.">
<title>TinyVerify</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONTS}" rel="stylesheet">
<style>${STYLE}</style>
</head>
<body>
${bodyHtml()}
<script id="scene">${squeeze(SCENE_SOURCE)}</script>
<script id="page">${script()}</script>
</body>
</html>
`;

export const pageApp = new Hono();

pageApp.get('/', (c) => c.html(renderPage()));
