#!/usr/bin/env bun
/**
 * Route-ordering collision checker.
 *
 * This engine's Hono router resolves routes in REGISTRATION ORDER —
 * a static path registered AFTER a same-method parameterized path that
 * could match it is unreachable. The param route wins, captures the
 * static segment as its param, and (because most :id columns are UUID)
 * the DB cast throws → 500.
 *
 * Real bug this caught: `GET /api/flows/dlq` matched `GET /:id`
 * (id="dlq"), and `WHERE id = 'dlq'` on a UUID column 500'd. Same for
 * /notifications/push-tokens, /backup/pitr/status, /translations/glossary,
 * and several extension /stats routes.
 *
 * Fix is always: register the static route BEFORE the param route.
 *
 * Scope handling: a single file may define multiple independent routers
 * (e.g. publicPagesRoutes + adminPagesRoutes), each mounted at a
 * different base path. Routes only collide within the SAME router, so
 * we split each file into router scopes at `new Hono()` boundaries and
 * compare within each scope only.
 *
 * Exits non-zero on any collision so CI blocks the merge.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const EXT_ROOT = process.env.EXTENSIONS_ROOT ?? join(ROOT, '..', 'zveltio-extensions');

type Route = { method: string; path: string; line: number; segs: string[]; scope: number };

function walkRouteFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git' || e === 'dist' || e === 'build') continue;
    const full = join(dir, e);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) out.push(...walkRouteFiles(full));
    else {
      const norm = full.replace(/\\/g, '/');
      if (
        norm.endsWith('.ts') &&
        (norm.includes('/routes/') || /routes?\.ts$/.test(norm) || norm.endsWith('-routes.ts'))
      ) {
        out.push(full);
      }
    }
  }
  return out;
}

function parseRoutes(file: string): Route[] {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const routes: Route[] = [];
  // Each `new Hono()` opens a fresh routing scope.
  const newRouterRe = /new\s+Hono\s*\(/;
  const routeRe = /\.(get|post|put|patch|delete|all)\(\s*['"]([^'"]+)['"]/;
  let scope = 0;
  lines.forEach((ln, i) => {
    if (newRouterRe.test(ln)) scope++;
    const m = ln.match(routeRe);
    if (m) {
      const path = m[2];
      if (!path.startsWith('/')) return; // skip c.get('user') etc.
      routes.push({
        method: m[1].toUpperCase(),
        path,
        line: i + 1,
        segs: path.split('/').filter(Boolean),
        scope,
      });
    }
  });
  return routes;
}

// Param route P (registered earlier) shadows static route S (registered
// later, same method, same scope, same segment count) when every P
// segment is identical to S or is a `:param`, and S is fully static.
function shadows(p: Route, s: Route): boolean {
  if (p.method !== s.method) return false;
  if (p.scope !== s.scope) return false;
  if (p.segs.length !== s.segs.length) return false;
  if (s.segs.some((x) => x.startsWith(':'))) return false; // S must be static
  let hasParam = false;
  for (let i = 0; i < p.segs.length; i++) {
    if (p.segs[i].startsWith(':')) {
      hasParam = true;
      continue;
    }
    if (p.segs[i] !== s.segs[i]) return false;
  }
  return hasParam;
}

const files = new Set<string>();
for (const f of walkRouteFiles(join(ROOT, 'packages', 'engine', 'src', 'routes'))) files.add(f);
for (const f of walkRouteFiles(EXT_ROOT)) files.add(f);

let count = 0;
for (const file of [...files].sort()) {
  const routes = parseRoutes(file);
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      if (shadows(routes[i], routes[j])) {
        const rel = file.replace(`${ROOT}/`, '').replace(`${ROOT}\\`, '').replace(/\\/g, '/');
        console.error(`❌ ${rel}`);
        console.error(
          `   ${routes[j].method} ${routes[j].path} (line ${routes[j].line}) is unreachable —`,
        );
        console.error(
          `   shadowed by ${routes[i].method} ${routes[i].path} (line ${routes[i].line}).`,
        );
        console.error(`   Fix: register the static route BEFORE the param route.\n`);
        count++;
      }
    }
  }
}

if (count > 0) {
  console.error(`Total route-ordering collisions: ${count}`);
  process.exit(1);
}
console.log('✅ No route-ordering collisions.');
