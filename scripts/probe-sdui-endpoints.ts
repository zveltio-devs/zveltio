#!/usr/bin/env bun
/**
 * Live runtime contract probe for declarative (SDUI) extensions.
 *
 * For every extension schema's primary resource it: enables the extension, calls
 * the resource's `dataSource` on a running engine, and asserts the response
 * resolves `dataPath` to a defined value. This is the only check that catches the
 * "wrong dataPath KEY" class — a 200 response whose payload is shaped `{ data }`
 * while the schema reads `templates`, so the table renders empty. Static
 * validation (route exists) and `extension validate` both pass for that bug.
 *
 * Failure model (so the gate is meaningful but not flaky):
 *   HARD (exit 1): 404 route not mounted · 5xx server error · 2xx but the
 *                  declared dataPath key is missing from the payload.
 *   SOFT (warn):   401/403 (admin probe shouldn't hit these, but some sources are
 *                  POST-only / need params) and other 4xx — reported, not fatal.
 *
 * Usage: BASE_URL=… bun scripts/probe-sdui-endpoints.ts [extensions-root]
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';

const EXT_ROOT = process.argv[2] ?? join(import.meta.dir, '../../zveltio-extensions');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.TEST_EMAIL ?? 'admin@zveltio.com';
const PASS = process.env.TEST_PASS ?? 'Test12345';

function findManifests(dir: string, acc: string[] = []): string[] {
  for (const ent of readdirSync(dir)) {
    if (ent === 'node_modules' || ent === '.git') continue;
    const p = join(dir, ent);
    if (statSync(p).isDirectory()) findManifests(p, acc);
    else if (ent === 'manifest.json') acc.push(p);
  }
  return acc;
}

async function signIn(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  if (!cookie) throw new Error('sign-in failed');
  return cookie;
}

type Pair = { dataSource: string; dataPath?: string };

/** Collect every { dataSource, dataPath } sibling pair from a schema tree. */
function collectPairs(node: unknown, acc: Pair[]): void {
  if (Array.isArray(node)) {
    for (const x of node) collectPairs(x, acc);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj.dataSource === 'string') {
      acc.push({ dataSource: obj.dataSource.split('?')[0], dataPath: obj.dataPath as string });
    }
    for (const v of Object.values(obj)) collectPairs(v, acc);
  }
}

/** Resolve a possibly-dotted path; returns `undefined` if any segment is missing. */
function getPath(body: unknown, path?: string): unknown {
  if (!path) return body;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  let cur: any = body;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

const cookie = await signIn();
const headers = { Cookie: cookie };

type Sev = 'OK' | 'HARD' | 'SOFT';
type Row = { name: string; endpoint: string; status: number; sev: Sev; note: string };
const rows: Row[] = [];

for (const manifestPath of findManifests(EXT_ROOT).sort()) {
  const dir = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const name = manifest.name;
  const pages = manifest.studio?.pages ?? [];
  for (const p of pages) {
    if (!p?.schema) continue;
    const schemaPath = join(dir, 'studio', p.schema);
    if (!existsSync(schemaPath)) continue;
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

    // Primary resource: prefer resources[0].master (its dataSource + dataPath),
    // else the first non-templated pair found anywhere in the schema.
    const pairs: Pair[] = [];
    collectPairs(schema, pairs);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const master = (schema as any).resources?.[0]?.master;
    const primary: Pair | undefined =
      master?.dataSource && typeof master.dataSource === 'string'
        ? { dataSource: (master.dataSource as string).split('?')[0], dataPath: master.dataPath }
        : (pairs.find((x) => !x.dataSource.includes('{')) ?? pairs[0]);
    if (!primary) continue;

    // Enable the extension before probing. An enable failure is a SOFT result,
    // not a contract failure: in CI it usually means a missing Postgres
    // extension (postgis / pg_trgm) the image doesn't ship — an environment
    // limitation, not a broken extension. The gate hard-fails only on an
    // extension that enabled but whose dataSource/dataPath contract is wrong.
    const enc = encodeURIComponent(name);
    const enableRes = await fetch(`${BASE}/api/marketplace/${enc}/enable`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}',
    });
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const enableBody = (await enableRes.json().catch(() => ({}))) as any;
    if (!enableBody?.success) {
      rows.push({
        name,
        endpoint: primary.dataSource,
        status: enableRes.status,
        sev: 'SOFT',
        note: `enable failed (env?): ${(enableBody?.error ?? enableBody?.message ?? '').toString().slice(0, 60)}`,
      });
      continue;
    }

    const res = await fetch(`${BASE}${primary.dataSource}`, { headers });
    const text = await res.text();
    let sev: Sev = 'OK';
    let note = '';

    if (res.status === 404) {
      sev = 'HARD';
      note = 'route not mounted';
    } else if (res.status >= 500) {
      sev = 'HARD';
      note = `server error: ${text.slice(0, 60).replace(/\s+/g, ' ')}`;
    } else if (
      res.status === 401 ||
      res.status === 403 ||
      (res.status >= 400 && res.status < 500)
    ) {
      sev = 'SOFT';
      note = `auth/4xx (${res.status}) — not gating`;
    } else {
      // 2xx: assert the declared dataPath resolves to a defined value.
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const resolved = getPath(body, primary.dataPath);
      if (primary.dataPath && resolved === undefined) {
        sev = 'HARD';
        note = `dataPath "${primary.dataPath}" missing from payload (keys: ${Object.keys(
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
          (body as any) ?? {},
        )
          .join(',')
          .slice(0, 60)})`;
      } else {
        note = primary.dataPath
          ? `dataPath "${primary.dataPath}" → ${Array.isArray(resolved) ? `array[${resolved.length}]` : typeof resolved}`
          : '2xx';
      }
    }
    rows.push({ name, endpoint: primary.dataSource, status: res.status, sev, note });
  }
}

const hard = rows.filter((r) => r.sev === 'HARD');
const soft = rows.filter((r) => r.sev === 'SOFT');
const ok = rows.filter((r) => r.sev === 'OK');

console.log(`\n=== SDUI dataSource live contract probe (${rows.length} schemas) ===`);
console.log(`OK: ${ok.length} | HARD fail: ${hard.length} | SOFT warn: ${soft.length}\n`);
for (const r of rows) {
  console.log(`${r.sev}\t${r.status}\t${r.name}\t${r.endpoint}\t${r.note}`);
}
if (hard.length) {
  console.log(`\n--- HARD FAILURES (${hard.length}) ---`);
  for (const r of hard) console.log(`  ${r.name}\t${r.endpoint}\t${r.note}`);
}

process.exit(hard.length > 0 ? 1 : 0);
