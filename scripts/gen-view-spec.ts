/**
 * Derives the `zveltio.view/2` artefacts from their single source,
 * `packages/sdk/src/view/schema.ts` (ADR 0042):
 *
 *   packages/sdk/src/view/types.generated.ts — the TypeScript types
 *   packages/sdk/schemas/view-2.schema.json  — the published JSON Schema
 *
 * Run: `bun run scripts/gen-view-spec.ts`; `--check` (CI, `check:view-spec`)
 * fails when either file is stale.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VIEW_SCHEMA } from '../packages/sdk/src/view/schema.ts';

type Schema = Record<string, unknown>;

const ROOT = join(import.meta.dir, '..');
const TYPES = join(ROOT, 'packages/sdk/src/view/types.generated.ts');
const JSON_SCHEMA = join(ROOT, 'packages/sdk/schemas/view-2.schema.json');

const PRIMS: Record<string, string> = {
  string: 'string',
  number: 'number',
  integer: 'number',
  boolean: 'boolean',
  null: 'null',
};

const doc = (s: Schema, indent: string) =>
  typeof s.description === 'string' ? `${indent}/** ${s.description} */\n` : '';

function ts(s: Schema, indent = ''): string {
  if (typeof s.$ref === 'string') return s.$ref.replace('#/$defs/', '');
  // `{ not: {} }` matches nothing: a key that must be absent.
  if (typeof s.not === 'object' && s.not !== null && Object.keys(s.not).length === 0)
    return 'never';
  if ('const' in s) return JSON.stringify(s.const).replace(/"/g, "'");
  if (Array.isArray(s.enum))
    return s.enum.map((e) => JSON.stringify(e).replace(/"/g, "'")).join(' | ');
  const union = (s.anyOf ?? (s.type === undefined ? s.oneOf : undefined)) as Schema[] | undefined;
  if (union) return union.map((b) => ts(b, indent)).join(' | ');
  if (Array.isArray(s.type)) return s.type.map((t) => PRIMS[t as string]).join(' | ');
  if (s.type === 'array') {
    const item = ts(s.items as Schema, indent);
    return item.includes(' ') ? `Array<${item}>` : `${item}[]`;
  }
  if (s.type === 'object') {
    if (!s.properties) return `Record<string, ${ts(s.additionalProperties as Schema, indent)}>`;
    const required = new Set((s.required ?? []) as string[]);
    const inner = `${indent}  `;
    const lines = Object.entries(s.properties as Record<string, Schema>).map(([k, p]) => {
      const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`;
      return `${doc(p, inner)}${inner}${key}${required.has(k) ? '' : '?'}: ${ts(p, inner)};`;
    });
    // An open object (no `additionalProperties`) takes other keys too.
    if (s.additionalProperties === undefined) lines.push(`${inner}[key: string]: unknown;`);
    return `{\n${lines.join('\n')}\n${indent}}`;
  }
  return PRIMS[s.type as string] ?? 'unknown';
}

const defs = VIEW_SCHEMA.$defs as Record<string, Schema>;
const types = `// GENERATED from src/view/schema.ts by scripts/gen-view-spec.ts — do not edit.

${Object.entries(defs)
  .map(([name, s]) => `${doc(s, '')}export type ${name} = ${ts(s)};`)
  .join('\n\n')}
`;
const json = `${JSON.stringify(VIEW_SCHEMA, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const stale = [
    [TYPES, types],
    [JSON_SCHEMA, json],
  ].filter(([path, body]) => {
    try {
      return readFileSync(path as string, 'utf8') !== body;
    } catch {
      return true;
    }
  });
  if (stale.length > 0) {
    console.error(
      `❌ view/2 spec drift: ${stale.map(([p]) => (p as string).replace(`${ROOT}/`, '')).join(', ')} stale.\n` +
        '   packages/sdk/src/view/schema.ts changed. Run: bun run scripts/gen-view-spec.ts',
    );
    process.exit(1);
  }
  console.log('✅ view/2 spec: types and JSON Schema in sync.');
  process.exit(0);
}

writeFileSync(TYPES, types);
writeFileSync(JSON_SCHEMA, json);
console.log('✓ wrote types.generated.ts and view-2.schema.json');
