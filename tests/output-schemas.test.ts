import { describe, expect, it } from 'vitest';
import { adapters } from '../src/registries';

// TinyFish rejects JSON Schema type arrays in output_schema ("Use a single type and nullable: true").
// Every schema an adapter exposes is walked: no type may be an array, and the fields the old
// schemas allowed to be null must be marked nullable.
const NULLABLE_BEFORE = [
  'ca-cslb record.output_schema #/properties/record/properties/discipline_flag',
  // The link-finder answer: url is null when the licence was not found.
  'fl-mqa search.output_schema #/properties/url',
  'fl-dbpr search.output_schema #/properties/url',
  // The health board's page-kind answer: total only on a list, url only on a licence page.
  'fl-mqa search.snapshot.output_schema #/properties/total',
  'fl-mqa search.snapshot.output_schema #/properties/url',
  // The contractor board's page-kind answer, the same shape.
  'fl-dbpr search.snapshot.output_schema #/properties/total',
  'fl-dbpr search.snapshot.output_schema #/properties/url',
];

function walk(node: unknown, path: string, onNode: (n: Record<string, unknown>, path: string) => void): void {
  if (typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}/${i}`, onNode));
    return;
  }
  const n = node as Record<string, unknown>;
  onNode(n, path);
  for (const [k, v] of Object.entries(n)) walk(v, `${path}/${k}`, onNode);
}

function schemasOf(): { where: string; schema: unknown }[] {
  const out: { where: string; schema: unknown }[] = [];
  for (const [id, adapter] of Object.entries(adapters)) {
    if (!adapter) continue;
    const search = adapter.search as { output_schema?: unknown; snapshot?: { output_schema?: unknown } };
    if (search.snapshot?.output_schema)
      out.push({ where: `${id} search.snapshot.output_schema`, schema: search.snapshot.output_schema });
    const record = adapter.record as { output_schema?: unknown };
    const discipline = adapter.discipline as { output_schema?: unknown };
    if (search.output_schema) out.push({ where: `${id} search.output_schema`, schema: search.output_schema });
    if (record.output_schema) out.push({ where: `${id} record.output_schema`, schema: record.output_schema });
    if (discipline.output_schema)
      out.push({ where: `${id} discipline.output_schema`, schema: discipline.output_schema });
  }
  return out;
}

describe('output schemas', () => {
  it('finds the schemas', () => {
    expect(schemasOf().length).toBeGreaterThanOrEqual(5);
  });

  // Seen live: a run request whose schema carried "description" on a field was refused
  // (HTTP 400, "output_schema field \"description\" is not supported"). Only the keywords seen to be
  // accepted in real runs are allowed; a property may still be named anything.
  it('uses only the schema keywords TinyFish has accepted', () => {
    const allowed = new Set(['type', 'properties', 'required', 'items', 'nullable']);
    const bad: string[] = [];
    const check = (schema: unknown, where: string): void => {
      if (typeof schema !== 'object' || schema === null) return;
      const n = schema as Record<string, unknown>;
      for (const key of Object.keys(n)) if (!allowed.has(key)) bad.push(`${where} keyword ${key}`);
      for (const [name, child] of Object.entries((n.properties ?? {}) as Record<string, unknown>))
        check(child, `${where}/properties/${name}`);
      if (n.items !== undefined) check(n.items, `${where}/items`);
    };
    for (const { where, schema } of schemasOf()) check(schema, `${where} #`);
    expect(bad).toEqual([]);
  });

  it('uses no type arrays', () => {
    const arrays: string[] = [];
    for (const { where, schema } of schemasOf()) {
      walk(schema, '#', (n, path) => {
        if (Array.isArray(n.type)) arrays.push(`${where} ${path}`);
      });
    }
    expect(arrays).toEqual([]);
  });

  it('marks exactly the fields that used to allow null as nullable', () => {
    const nullable: string[] = [];
    for (const { where, schema } of schemasOf()) {
      walk(schema, '#', (n, path) => {
        if (n.nullable === true) nullable.push(`${where} ${path}`);
      });
    }
    expect(nullable.sort()).toEqual([...NULLABLE_BEFORE].sort());
  });
});
