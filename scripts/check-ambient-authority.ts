#!/usr/bin/env bun
/**
 * Gate: extensions must not reach for ambient authority.
 *
 * An in-process extension reading `process.env` sees the ENGINE's entire
 * environment — `DATABASE_URL`, `BETTER_AUTH_SECRET`, `FIELD_ENCRYPTION_KEY`.
 * That is both far more than any extension needs and a way around the
 * capability gate on `ctx.internals`: an extension wanting to decrypt without
 * declaring `secrets` could read the key and do it itself. The authority-bearing
 * `node:*` modules are the same problem one level down — filesystem, process,
 * socket and child-process access that no extension in this catalogue wants.
 *
 * Pure `node:*` modules are NOT flagged. `node:crypto`'s `timingSafeEqual` is a
 * constant-time byte comparison; it confers no authority, and rewriting working
 * security code by hand to satisfy a gate would trade real risk for a tidier
 * grep. Those imports are a portability question for a stricter runtime, which
 * is a different decision from this one and should be made on its own terms.
 *
 * This is a hygiene gate, not a security boundary. An attacker does not run our
 * CI. Its job is to keep a measured property TRUE as the catalogue grows: today
 * 44 extensions with engine code contain exactly one `node:*` import between
 * them, which is why a stricter extension runtime is still an option. That
 * option closes quietly, one convenient `process.env` at a time, unless
 * something watches.
 *
 * Use `ctx.config` for configuration and `ctx.internals` for privileged
 * operations — both are host-resolved and capability-gated.
 *
 * Usage: bun scripts/check-ambient-authority.ts [extensionsWorkspace]
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Extension files exempt from the rule, with the reason each is exempt.
 *
 * Empty, and that is the interesting part. Three files used to be here —
 * auth/scim, communications/mail and integrations/migrators each read a key out
 * of the environment and did their own AES-GCM or HMAC. They were not exempt
 * because reading keys was acceptable; they were exempt because their
 * ciphertext is already on disk in installs we do not control, so converting
 * them naively would have been data loss dressed up as a refactor.
 *
 * They were closed by giving the HOST the formats instead: `lib/security/keyring.ts`
 * reproduces each envelope byte-for-byte under the same key, so the extensions
 * delegate and every value already stored keeps decrypting.
 *
 * Add an entry only for something that genuinely cannot be moved, with the
 * reason written out. This list should only ever shrink.
 */
const ALLOWLIST: Record<string, string> = {};

/**
 * `node:*` modules that hand an extension authority the host is supposed to
 * mediate. Everything else (`crypto`, `buffer`, `util`, `path`, `url`,
 * `events`, `assert`, …) is a pure library and passes.
 */
const AUTHORITY_MODULES = [
  'fs',
  'fs/promises',
  'child_process',
  'process',
  'net',
  'tls',
  'dgram',
  'http',
  'https',
  'http2',
  'cluster',
  'worker_threads',
  'vm',
  'module',
  'v8',
  'inspector',
  'os',
  'repl',
];

/** Strip comments so documentation ABOUT `process.env` is not a finding. */
function stripComments(src: string): string {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks
    .split('\n')
    .map((line) => {
      const t = line.trimStart();
      if (t.startsWith('//') || t.startsWith('*')) return '';
      return line;
    })
    .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    // `.js` is the packed bundle — it inlines dependency source we do not own.
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  text: string;
  what: string;
}

/**
 * Every extension directory in the workspace, at whatever depth it lives.
 *
 * This used to be a fixed two-level loop over `<category>/<name>/engine`, and
 * the catalogue does not have that shape. 12 of the 57 extensions sit at another
 * depth — 6 at the top level (`ai`, `billing`, `crm`, `forms`, `search`, `sms`)
 * and 5 nested a level deeper (`compliance/ro/*`) — and the gate walked straight
 * past every one of them. It then printed "with no exceptions", which was true
 * of the 45 it looked at and false of the catalogue.
 *
 * Not a small blind spot in practice: four of the twelve read `process.env` in
 * engine code, which is the exact thing this gate exists to refuse, and it had
 * been reporting them clean for as long as it has existed.
 *
 * A directory is an extension if it has a `manifest.json` and an `engine/`.
 * That is the same test the packer and the registry use, so a new extension
 * cannot arrive at a depth this gate does not know about.
 */
function extensionDirs(root: string, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(dir, 'manifest.json')) && existsSync(join(dir, 'engine'))) {
      out.push(dir);
    }
    // Recurse either way: `compliance/ro/*` sits under a plain grouping
    // directory that is not itself an extension.
    extensionDirs(dir, out, depth + 1);
  }
  return out;
}

function scan(root: string): Finding[] {
  const findings: Finding[] = [];
  const dirs = extensionDirs(root);
  // A traversal that matches nothing must not be allowed to read as a pass —
  // that is how this gate spent its whole life green over 45 of 57 extensions.
  if (dirs.length === 0) {
    console.error(
      `[ambient-authority] no extensions found under ${root}; refusing to report a pass.`,
    );
    process.exit(1);
  }
  console.error(`[ambient-authority] scanning ${dirs.length} extension(s) under ${root}`);
  for (const extDir of dirs) {
    const engineDir = join(extDir, 'engine');
    for (const file of walk(engineDir)) {
      const rel = relative(root, file);
      if (ALLOWLIST[rel]) continue;
      const lines = stripComments(readFileSync(file, 'utf-8')).split('\n');
      lines.forEach((line, i) => {
        if (/\bprocess\.env\b/.test(line)) {
          findings.push({ file: rel, line: i + 1, text: line.trim(), what: 'process.env' });
        }
        const nodeImport = line.match(/(?:from|import|require)\s*\(?\s*['"]node:([a-z_/]+)['"]/);
        if (nodeImport && AUTHORITY_MODULES.includes(nodeImport[1])) {
          findings.push({
            file: rel,
            line: i + 1,
            text: line.trim(),
            what: `node:${nodeImport[1]}`,
          });
        }
      });
    }
  }
  return findings;
}

const root =
  process.argv.slice(2).find((a) => !a.startsWith('--')) ??
  join(import.meta.dir, '..', '..', 'zveltio-extensions');
const BASELINE = join(import.meta.dir, '..', 'quality-gates', 'ambient-authority.json');
const LIST = process.argv.includes('--list');

const findings = scan(root);

// Counts per file, so a file may lose sites but never gain them. Line numbers
// would make the baseline churn on every unrelated edit above.
const counts: Record<string, number> = {};
for (const f of findings) counts[f.file] = (counts[f.file] ?? 0) + 1;

if (LIST) {
  console.log(JSON.stringify(counts, null, 2));
  process.exit(0);
}

let baseline: Record<string, number> = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf-8'));
} catch {
  // No baseline yet: every finding is new.
}

const grew: string[] = [];
const shrank: string[] = [];
for (const [file, n] of Object.entries(counts)) {
  if (file.startsWith('_')) continue;
  const was = typeof baseline[file] === 'number' ? baseline[file] : 0;
  if (n > was) grew.push(`  ${file}: ${was} → ${n}`);
}
for (const [file, was] of Object.entries(baseline)) {
  if (file.startsWith('_') || typeof was !== 'number') continue;
  const n = counts[file] ?? 0;
  if (n < was) shrank.push(`  ${file}: ${was} → ${n}`);
}

if (grew.length > 0) {
  console.error(
    `❌ ambient-authority: ${grew.length} file(s) reach for MORE ambient authority than the baseline.\n`,
  );
  for (const line of grew) console.error(line);
  console.error('');
  for (const f of findings) {
    if (grew.some((g) => g.trim().startsWith(`${f.file}:`))) {
      console.error(`  ${f.file}:${f.line}  [${f.what}]`);
      console.error(`      ${f.text}`);
    }
  }
  console.error(
    `\nExtensions must not reach for ambient authority.\n` +
      `  • configuration      → ctx.config  (see ExtensionConfig in @zveltio/sdk/extension)\n` +
      `  • per-extension settings → the extension's own zv_settings row (see communications/mail)\n` +
      `  • encrypt / decrypt  → ctx.internals.encryptSecret / decryptSecret  ("secrets" capability)\n` +
      `  • object storage     → ctx.config.objectStorage  ("storage" capability)\n\n` +
      `If a value genuinely has no home on ctx.config, add it there — deliberately,\n` +
      `as part of the capability contract — rather than reading the engine's environment.\n`,
  );
  process.exit(1);
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
if (shrank.length > 0) {
  console.log(`ambient-authority: ${shrank.length} file(s) improved — update the baseline:`);
  for (const line of shrank) console.log(line);
  console.log(
    '  bun run scripts/check-ambient-authority.ts --list > quality-gates/ambient-authority.json',
  );
}
console.log(
  total === 0
    ? '✅ ambient-authority: no extension reads process.env or imports an authority-bearing node:* module.'
    : `✅ ambient-authority: ${total} known site(s) in ${Object.keys(counts).length} file(s), none new.`,
);
process.exit(0);
