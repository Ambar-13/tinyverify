import { describe, expect, it } from 'vitest';

// Each register's record page has two readers, and a record is trusted only when they agree. That check is
// worth something only if the readers fail in different ways, so they must share no parsing code: a parser
// may import the text helper, the types, node-html-parser and the status tables, and nothing else. A dom
// reader never imports a lines reader, nor the reverse.
//
// The files end in .dom.ts and .lines.ts, never .html.ts or .text.ts: wrangler bundles those two endings as
// text modules, and the exports vanish.
const parsers = import.meta.glob('../src/registries/parsers/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// Parsers also read the status tables. They never read shared.ts, the adapter helpers.
const ALLOWED = new Set(['../../text', '../../types', 'node-html-parser', '../status-tables']);

// Every module specifier in a file: `import ... from 'x'`, `export ... from 'x'` and `import 'x'`.
function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/\b(?:from|import)\s+['"]([^'"]+)['"]/g)) found.push(m[1]);
  return found;
}

const isLinesReader = (spec: string): boolean => /\.lines(\.ts|\.js)?$/.test(spec);
const isDomReader = (spec: string): boolean => /\.dom(\.ts|\.js)?$/.test(spec);

describe('parser independence', () => {
  it('finds the parser files', () => {
    const names = Object.keys(parsers).map((p) => p.split('/').pop());
    expect(names).toContain('fl-mqa.dom.ts');
    expect(names).toContain('fl-mqa.lines.ts');
    expect(names).toContain('fl-dbpr-complaints.lines.ts');
  });

  for (const [path, source] of Object.entries(parsers)) {
    const name = path.split('/').pop() ?? path;
    const isDom = name.endsWith('.dom.ts');
    const isLines = name.endsWith('.lines.ts');

    it(`${name} is named .dom.ts or .lines.ts`, () => {
      expect(isDom || isLines).toBe(true);
    });

    it(`${name} imports only the text helper, the types, node-html-parser and the status tables`, () => {
      const outside = specifiers(source).filter((s) => !ALLOWED.has(s));
      expect(outside).toEqual([]);
    });

    if (isDom) {
      it(`${name} never imports a lines reader`, () => {
        expect(specifiers(source).filter(isLinesReader)).toEqual([]);
      });
    }

    if (isLines) {
      it(`${name} never imports a dom reader`, () => {
        expect(specifiers(source).filter(isDomReader)).toEqual([]);
      });
    }
  }
});
