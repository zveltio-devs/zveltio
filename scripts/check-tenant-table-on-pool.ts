#!/usr/bin/env bun
/**
 * A route handler must not query a tenant-scoped table on `poolDb`.
 *
 * Routers are handed TWO database handles, and the difference is the whole
 * point: `registerCoreRoutes(app, { db: scopedDb, poolDb: db, auth })`. The
 * `db` a route receives is `createRequestScopedDb` — a proxy that resolves the
 * request's transaction per access, so `db.selectFrom(...)` is already bound by
 * the tenant policies. `poolDb` is the raw pool, running as the engine's own
 * role, and a tenant-scoped query on it sees every tenant's rows.
 *
 * Scope: `routes/` only, and that boundary is a finding rather than an oversight.
 * Extending it to `lib/` was tried while the gate still matched names, and reverted.
 * There, the unscoped handle is spelled `db` — the name a transaction is passed under —
 * so the gate either caught nothing (matching only `poolDb`, which `lib/` does not
 * use) or drowned in false positives (matching `db`, usually the request one). The
 * first version of the extension took the harmless option and shipped four
 * "reviewed exceptions" for violations that could never fire. A gate whose
 * exception list is the only thing it produces is worse than no gate.
 *
 * The background access it would have covered is real and was inventoried:
 * `repairUnsignedWebhooksAtBoot` reads every tenant's webhooks; `flow-executor`
 * looks up a flow's tenant in order to learn which one to run as; the boot
 * reconciles walk every tenant's tables. All of them need to see across tenants by
 * design, which is why the engine's own role is not restricted.
 *
 * `poolDb` exists for good reasons — the four routers in `TXN_SKIP_PREFIXES`
 * would otherwise pin one connection and reach for a second, which deadlocks at
 * a concurrency equal to the pool size. This gate does not object to `poolDb`.
 * It objects to `poolDb` plus a table that carries a tenant.
 *
 * "`poolDb`" is a binding, not a spelling. The pool is followed from
 * `registerCoreRoutes` into every router and helper it is passed to, under
 * whatever name the parameter has (`backupRoutes(db)`, `sqlEditorRoutes(db)`),
 * into `const` aliases, and into the callback of a transaction opened on it.
 * Until 2026-10-12 the gate matched the text `poolDb.` and so never judged
 * `backup` or `sql-editor`. It now refuses to pass when it can see nothing.
 *
 * The first version of this gate had the premise backwards: it flagged `db.`,
 * on the belief that a route's `db` was the raw pool. It reported three
 * findings, all of them correct code, and one was waved through with a baseline
 * entry — a gate that excuses the right pattern is worse than no gate, because
 * the excuse looks like review. `poolDb` is the handle with no tenant binding;
 * `db` is the one that has it.
 *
 * What counts as tenant-scoped is read from `db/schema.ts` — the interface a
 * table maps to in `DbSchema`, and whether that interface declares `tenant_id`.
 * No database is consulted: a gate that needs one is a gate that skips when it
 * cannot have one.
 *
 * `zvd_*` is deliberately NOT treated as tenant-scoped by name. The prefix looks
 * like it should be — the dynamic collection tables carry it — but ten of the
 * `zvd_` tables in a live schema have no `tenant_id` at all (`zvd_relations`,
 * `zvd_collections`, `zvd_rls_policies` and friends are instance-level metadata).
 * A first version of this gate assumed the prefix and reported three findings,
 * every one of them wrong. Declared columns are the fact; the name is a guess.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dir, '..');
const SCHEMA = join(ROOT, 'packages/engine/src/db/schema.ts');
const ROUTES_DIR = join(ROOT, 'packages/engine/src/routes');

// ── which tables carry a tenant ───────────────────────────────────────────────
const schemaSrc = readFileSync(SCHEMA, 'utf8');

/** Interface body by name, so `tenant_id` can be looked up per table. */
const interfaceBodies = new Map<string, string>();
for (const m of schemaSrc.matchAll(/export interface (\w+)\s*\{([\s\S]*?)\n\}/g)) {
  interfaceBodies.set(m[1]!, m[2]!);
}

const dbSchemaBlock = /export interface DbSchema\s*\{([\s\S]*?)\n\}/.exec(schemaSrc)?.[1] ?? '';
const tenantScoped = new Set<string>();
for (const m of dbSchemaBlock.matchAll(/^\s*'?([\w]+)'?\s*:\s*(\w+);/gm)) {
  const [, table, iface] = m;
  const body = interfaceBodies.get(iface!);
  if (body && /^\s*tenant_id\??\s*:/m.test(body)) tenantScoped.add(table!);
}

if (tenantScoped.size === 0) {
  console.error('[tenant-on-pool] FAIL — parsed no tenant-scoped tables out of schema.ts.');
  console.error('The gate cannot have checked anything; fix the parse rather than trusting it.');
  process.exit(1);
}

// ── which handles are the raw pool ───────────────────────────────────────────
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (entry.endsWith('.ts') && !entry.includes('.test.')) out.push(p);
  }
  return out;
}

/**
 * Parsed, not pattern-matched. A regex sees a spelling; the pool reaches a route
 * under whatever name the router's parameter has. Measured on 2026-09-04 and
 * again on 2026-10-12: `backupRoutes(poolDb, auth)` is `function backupRoutes(db:
 * Database)` inside, so a gate matching the text `poolDb.` judged none of its
 * sites. Comments are trivia to the parser, so nothing has to be stripped.
 */
const files = new Map(
  tsFiles(ROUTES_DIR).map((f) => [
    f,
    ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true),
  ]),
);
const rel = (f: string) => f.slice(ROOT.length + 1);

type Decl = ts.ParameterDeclaration | ts.VariableDeclaration | ts.BindingElement;

/** The declaration binding `text` in `decl`, destructuring included. */
function bound(decl: Decl, text: string): Decl | undefined {
  if (ts.isIdentifier(decl.name)) return decl.name.text === text ? decl : undefined;
  for (const el of decl.name.elements) {
    const hit = ts.isBindingElement(el) ? bound(el, text) : undefined;
    if (hit) return hit;
  }
}

function declaredIn(scope: ts.Node, text: string): Decl | undefined {
  if (ts.isFunctionLike(scope)) {
    for (const p of scope.parameters) {
      const hit = bound(p, text);
      if (hit) return hit;
    }
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration) {
    return bound(scope.variableDeclaration, text);
  }
  const lists: ts.VariableDeclarationList[] = [];
  if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isCaseOrDefaultClause(scope)) {
    for (const s of scope.statements) if (ts.isVariableStatement(s)) lists.push(s.declarationList);
  }
  if (
    (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) &&
    scope.initializer &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    lists.push(scope.initializer);
  }
  for (const l of lists) {
    for (const d of l.declarations) {
      const hit = bound(d, text);
      if (hit) return hit;
    }
  }
}

/** The nearest declaration of an identifier — so an inner `(db) =>` shadows. */
function resolve(id: ts.Identifier): Decl | undefined {
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    const hit = declaredIn(n, id.text);
    if (hit) return hit;
  }
}

function strip(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isSatisfiesExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/**
 * Declarations that hold the raw pool. Anything named `poolDb` is one — that is
 * the convention `registerCoreRoutes` hands it under — and so is whatever it is
 * then passed to or assigned to, followed below.
 */
const pool = new Set<ts.Node>();
function onPool(e: ts.Expression): boolean {
  const x = strip(e);
  if (!ts.isIdentifier(x)) return false;
  const d = resolve(x);
  return !!d && (pool.has(d) || (ts.isIdentifier(d.name) && d.name.text === 'poolDb'));
}

/** `<pool>.transaction()` / `.connection()`, any `.setX(…)` between, before `.execute(cb)`. */
function opensOnPool(e: ts.Expression): boolean {
  for (
    let x = strip(e);
    ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression);
    x = strip(x.expression.expression)
  ) {
    const op = x.expression.name.text;
    if ((op === 'transaction' || op === 'connection') && onPool(x.expression.expression)) {
      return true;
    }
  }
  return false;
}

type Fn = ts.SignatureDeclaration;
function fnNamed(scope: ts.Node, text: string): Fn | undefined {
  if (!(ts.isBlock(scope) || ts.isSourceFile(scope))) return undefined;
  for (const s of scope.statements) {
    if (ts.isFunctionDeclaration(s) && s.name?.text === text) return s;
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
      const init = d.initializer && strip(d.initializer);
      if (ts.isIdentifier(d.name) && d.name.text === text && init) {
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
      }
    }
  }
}

/**
 * The function a call lands in: declared in an enclosing scope, or imported from
 * another file under `routes/`. `routes` is set when the callee is a route file's
 * export, so a declaration the gate cannot find is a router left unjudged.
 */
function callee(call: ts.CallExpression): { fn?: Fn; name: string; routes: boolean } | undefined {
  const c = strip(call.expression);
  if (!ts.isIdentifier(c)) return undefined;
  for (let n: ts.Node | undefined = call.parent; n; n = n.parent) {
    const fn = fnNamed(n, c.text);
    if (fn) return { fn, name: c.text, routes: true };
  }
  const sf = call.getSourceFile();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    const named = s.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named) || !s.moduleSpecifier.text.startsWith('.')) continue;
    const el = named.elements.find((e) => e.name.text === c.text);
    if (!el) continue;
    const target = join(dirname(sf.fileName), s.moduleSpecifier.text.replace(/\.js$/, '.ts'));
    if (!target.startsWith(ROUTES_DIR)) return undefined;
    const file = files.get(target);
    return {
      fn: file && fnNamed(file, (el.propertyName ?? el.name).text),
      name: c.text,
      routes: true,
    };
  }
}

/** `file → function` for every router the pool is handed to — the gate's reach. */
const reached = new Set<string>();
const unresolved = new Set<string>();
for (let grew = true; grew; ) {
  grew = false;
  const add = (d: ts.Node | undefined) => {
    if (d && !pool.has(d)) {
      pool.add(d);
      grew = true;
    }
  };
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
      if (onPool(n.initializer)) add(n);
    }
    if (ts.isCallExpression(n)) {
      const cb = n.arguments[0];
      if (
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'execute' &&
        cb &&
        (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) &&
        opensOnPool(n.expression.expression)
      ) {
        add(cb.parameters[0]);
      }
      n.arguments.forEach((a, i) => {
        if (!onPool(a)) return;
        const target = callee(n);
        if (!target?.routes) return;
        const at = `${rel(n.getSourceFile().fileName)} → ${target.name}`;
        const p = target.fn?.parameters[i];
        if (!target.fn) unresolved.add(at);
        else if (p && !p.dotDotDotToken && ts.isIdentifier(p.name)) {
          add(p);
          reached.add(at);
        }
      });
    }
    ts.forEachChild(n, visit);
  };
  for (const sf of files.values()) visit(sf);
}

// ── the sites on it ──────────────────────────────────────────────────────────
const OPS = new Set(['selectFrom', 'insertInto', 'updateTable', 'deleteFrom', 'mergeInto']);

/** Every table a raw statement names — `FROM a, zv_x`, `public.zv_x`, a subquery. */
function rawTables(body: string): Set<string> {
  const named = new Set(
    [
      ...body.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|USING)\s+(?:ONLY\s+)?(?:"?\w+"?\.)?"?(\w+)"?/gi),
    ].map((t) => t[1]!),
  );
  // Any word naming a tenant table, wherever it stands. Planted 2026-10-11, all green.
  for (const w of body.match(/\w+/g) ?? []) if (tenantScoped.has(w)) named.add(w);
  return named;
}

/**
 * Sites read and understood, keyed `file:table`. Empty, and meant to stay that
 * way: an entry here is a promise that somebody checked the tenant binding by
 * hand, and an earlier version of this file shows how easily that becomes a
 * rubber stamp.
 */
const allowed = new Map<string, string>();

const findings: string[] = [];
/** Every query site on the pool, matched or not. */
let sitesSeen = 0;

for (const [file, sf] of files) {
  const report = (n: ts.Node, table: string) => {
    if (!tenantScoped.has(table) || allowed.has(`${rel(file)}:${table}`)) return;
    const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
    const text = n.getText().replace(/\s+/g, ' ').slice(0, 120);
    findings.push(`${rel(file)}:${line}  ${table}\n      ${text}`);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const op = n.expression.name.text;
      const arg = n.arguments[0];
      if (OPS.has(op) && onPool(n.expression.expression)) {
        sitesSeen++;
        // An alias (`'zv_api_keys as k'`) is the same table.
        if (arg && ts.isStringLiteralLike(arg)) report(n, arg.text.trim().split(/\s+/)[0]!);
        // A table joined onto a pool query is read on the pool too.
        for (let c: ts.Node = n; ts.isPropertyAccessExpression(c.parent); ) {
          const call = c.parent.parent;
          if (!ts.isCallExpression(call) || call.expression !== c.parent) break;
          const j = call.arguments[0];
          if (/join/i.test(c.parent.name.text) && j && ts.isStringLiteralLike(j)) {
            report(call, j.text.trim().split(/\s+/)[0]!);
          }
          c = call;
        }
      }
      // `sql\`…\`.execute(<pool>)` — a raw statement is exactly as unbound.
      const tpl = strip(n.expression.expression);
      if (op === 'execute' && arg && onPool(arg) && ts.isTaggedTemplateExpression(tpl)) {
        if (ts.isIdentifier(tpl.tag) && tpl.tag.text === 'sql') {
          sitesSeen++;
          for (const t of rawTables(tpl.template.getText())) report(n, t);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// ── blindness ────────────────────────────────────────────────────────────────
// Not "nothing to check": each of these means the gate is judging an empty set.
const INDEX = rel(join(ROUTES_DIR, 'index.ts'));
const blind: string[] = [];
for (const u of unresolved)
  blind.push(`the pool is passed to ${u}, whose declaration was not found`);
if (![...reached].some((r) => r.startsWith(`${INDEX} `))) {
  blind.push(`${INDEX} hands the pool to no router — mounting changed, or the resolver broke`);
}
if (sitesSeen === 0) blind.push('zero query sites on the pool under routes/');
if (blind.length > 0) {
  console.error('[tenant-on-pool] FAIL — the gate cannot see what it exists for:\n');
  for (const b of blind) console.error(`  ${b}`);
  process.exit(1);
}

if (findings.length > 0) {
  console.error('[tenant-on-pool] FAIL — tenant-scoped table queried on the raw pool:\n');
  for (const f of findings) console.error(`  ${f}\n`);
  console.error("Use the router's request-scoped `db` — `createRequestScopedDb`, bound to the");
  console.error('request transaction and therefore to the tenant policies. The pool is for');
  console.error('work that must not join the request transaction at all.');
  process.exit(1);
}

console.log(
  `[tenant-on-pool] OK — ${tenantScoped.size} tenant-scoped table(s) known; the pool reaches ` +
    `${reached.size} router/helper parameter(s); ${sitesSeen} query site(s) on it under routes/, ` +
    'none on a tenant table.',
);
