import { describe, expect, it } from 'vitest';
import { MAX_HTML_CHARS, toText } from '../src/text';

// The least elapsed time over three runs of the call, in ms. One slow run (a GC pause, a busy
// machine) does not fail a timing test; three slow runs in a row do.
function minElapsedMs(run: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe('toText', () => {
  it('turns block elements into lines and drops script content', () => {
    expect(toText('<p>A</p><script>x</script><td>B</td>')).toBe('A\nB');
  });

  it('drops style, head, noscript and comments', () => {
    const html =
      '<html><head><title>Registry</title><style>p{color:red}</style></head>' +
      '<body><!-- hidden note --><p>Visible</p><noscript>Enable JavaScript</noscript></body></html>';
    expect(toText(html)).toBe('Visible');
  });

  it('decodes the common entities, numeric and hex forms', () => {
    const html = '<p>Tom &amp; Jerry &lt;3 &quot;hi&quot; &#39;x&#39;&nbsp;y &#65;&#x42;</p>';
    expect(toText(html)).toBe('Tom & Jerry <3 "hi" \'x\' y AB');
  });

  it('treats each block element as a line break', () => {
    const html =
      '<div>One</div><div>Two</div><ul><li>Three</li></ul><h2>Four</h2>' +
      '<table><tr><th>Five</th><td>Six</td></tr></table><dl><dt>Seven</dt><dd>Eight</dd></dl>';
    expect(toText(html)).toBe('One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight');
  });

  it('collapses runs of spaces and tabs, trims lines and drops empty ones', () => {
    const html = '<p>  Name:\t\tJane   Doe  </p>\n\n<p>   </p><br/>';
    expect(toText(html)).toBe('Name: Jane Doe');
  });

  it('treats raw line breaks inside a paragraph as spaces', () => {
    expect(toText('<p>Jane\n   Doe</p>')).toBe('Jane Doe');
  });

  it('removes inline tags without adding spaces', () => {
    expect(toText('<span>Act</span><b>ive</b>')).toBe('Active');
  });

  it('handles a large page in one pass', () => {
    const rows = Array.from({ length: 1500 }, (_, i) => `<tr><td>Row ${i}</td><td>Active &amp; current</td></tr>`).join(
      '',
    );
    const out = toText(
      `<html><head><style>${'a{}'.repeat(2000)}</style></head><body><table>${rows}</table></body></html>`,
    );
    const lines = out.split('\n');
    expect(lines).toHaveLength(3000);
    expect(lines[0]).toBe('Row 0');
    expect(lines[1]).toBe('Active & current');
    expect(lines[2999]).toBe('Active & current');
  });

  it('returns quickly on 200,000 unclosed angle brackets', () => {
    const hostile = '<'.repeat(200_000);
    expect(minElapsedMs(() => toText(hostile))).toBeLessThan(100);
  });

  it('ignores input after MAX_HTML_CHARS', () => {
    const html = `<p>visible</p>${' '.repeat(MAX_HTML_CHARS)}<p>TAIL_MARKER</p>`;
    const out = toText(html);
    expect(out).toBe('visible');
    expect(out).not.toContain('TAIL_MARKER');
  });

  it('hides a script whose quoted attribute contains <', () => {
    expect(toText('<script data-x="a<b">var hidden = 1;</script><p>Shown</p>')).toBe('Shown');
  });

  it('hides a style whose quoted attribute contains <', () => {
    expect(toText('<style media="a<b">p{color:red}</style><p>Shown</p>')).toBe('Shown');
  });

  it('hides a script whose unbalanced quote is in the attribute', () => {
    expect(toText('<script a">x</script><p>Shown</p>')).toBe('Shown');
  });

  it('hides a script whose unquoted attribute holds an apostrophe', () => {
    expect(toText("<script data-x=it's>x</script><p>Shown</p>")).toBe('Shown');
  });

  it('lets an unterminated script swallow the rest of the input', () => {
    expect(toText('<p>Before</p><script>hidden<p>tail</p>')).toBe('Before');
  });

  it('does not take a longer tag name for head', () => {
    expect(toText('<header>Shown</header>')).toBe('Shown');
  });

  it('handles 300,000 characters of unterminated script openers quickly', () => {
    const hostile = '<script a="'.repeat(Math.floor(300_000 / '<script a="'.length));
    expect(minElapsedMs(() => toText(hostile))).toBeLessThan(100);
  });

  it('times a 300,000-character upper-case page under 100 ms', () => {
    const page = '<P>HELLO WORLD</P><SCRIPT>X</SCRIPT><DIV>ROW &AMP; MORE</DIV>'.repeat(Math.floor(300_000 / 62));
    expect(minElapsedMs(() => toText(page))).toBeLessThan(100);
  });

  it('ends a head block at <body> when there is no </head>', () => {
    expect(toText('<html><head><title>Registry</title><body><p>Body text</p></body></html>')).toBe('Body text');
  });

  it('turns the added block elements into line breaks', () => {
    const html =
      '<hr>One<form>Two</form><nav>Three</nav><main>Four</main><header>Five</header>' +
      '<footer>Six</footer><ul><li>Seven</li></ul><ol><li>Eight</li></ol>' +
      '<fieldset><legend>Nine</legend></fieldset>';
    expect(toText(html)).toBe('One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight\nNine');
  });

  it('hides a comment whose text starts with a letter', () => {
    expect(toText('<!--hidden-->Shown')).toBe('Shown');
  });
});
