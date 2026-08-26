/**
 * Handlers that do slow, non-database work while holding a pooled connection.
 *
 * The tenant transaction spans the whole request, so a handler that calls an
 * external service, spawns a process or renders a PDF holds one of DB_POOL_MAX
 * connections for the entire duration of that work — not just for its queries.
 *
 * That is the failure mode that does not look like load. Measured 2026-08-26,
 * ten simultaneous two-second requests exhaust a pool of ten; the other users
 * see the application hang while the server is almost idle. Month-end, when ten
 * accountants run the same report, is exactly when it happens.
 *
 * Report, not a gate: some of these are unavoidable and the fix is the
 * transaction boundary, not the handler. The point is to know which they are.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const EXT_ROOT = join(ROOT, '..', 'zveltio-extensions');

/** Work that takes time and is not a query. Ordered most to least obvious. */
const SLOW: Array<{ re: RegExp; what: string }> = [
  { re: /\bfetch\s*\(/g, what: 'HTTP call' },
  { re: /Bun\.spawn|spawnSync|execSync|child_process/g, what: 'subprocess' },
  { re: /generatePDF|puppeteer|playwright|chromium/gi, what: 'PDF/browser' },
  { re: /ImapFlow|nodemailer|createTransport|\bsmtp\b/gi, what: 'mail server' },
  { re: /putObject|getObject|deleteObject|S3Client/g, what: 'object storage' },
  { re: /setTimeout\s*\(\s*resolve/g, what: 'sleep' },
];

function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      if (ch === '\\') {
        out += ch + (next ?? '');
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const SPLIT =
  /(?=\.(?:get|post|put|patch|delete)\s*\(\s*['"`]\/|(?:app|router)\.on\s*\(|^[ \t]*(?:export\s+)?(?:async\s+)?function\s+\w+\s*\()/m;
const NAME = /^\.?(?:(?:app|router)\.)?(get|post|put|patch|delete)\s*\(\s*['"`](\/[^'"`]*)/i;

function tsFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (e.endsWith('.ts') && !e.includes('.test.')) out.push(p);
  }
  return out;
}

const findings: Array<{ file: string; handler: string; kinds: string[] }> = [];
function scan(file: string, label: string): void {
  for (const part of stripComments(readFileSync(file, 'utf8')).split(SPLIT).slice(1)) {
    const m = NAME.exec(part);
    if (!m) continue; // only registered routes — helpers are attributed to their caller
    const kinds = new Set<string>();
    for (const { re, what } of SLOW) {
      re.lastIndex = 0;
      if (re.test(part)) kinds.add(what);
    }
    if (kinds.size > 0) {
      findings.push({ file: label, handler: `${m[1].toUpperCase()} ${m[2]}`, kinds: [...kinds] });
    }
  }
}

for (const f of tsFiles(join(ROOT, 'packages', 'engine', 'src', 'routes')))
  scan(f, relative(ROOT, f));
if (existsSync(EXT_ROOT)) {
  for (const f of tsFiles(EXT_ROOT)) {
    if (f.includes('/engine/')) scan(f, `ext:${relative(EXT_ROOT, f)}`);
  }
}

const byFile = new Map<string, typeof findings>();
for (const f of findings) {
  if (!byFile.has(f.file)) byFile.set(f.file, []);
  byFile.get(f.file)?.push(f);
}
for (const [file, list] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n${file}`);
  for (const f of list) console.log(`  ${f.handler.padEnd(46)} ${f.kinds.join(', ')}`);
}
console.log(
  `\n[slow-in-transaction] ${findings.length} route handler(s) hold a pooled connection ` +
    `across non-database work, in ${byFile.size} file(s).`,
);
