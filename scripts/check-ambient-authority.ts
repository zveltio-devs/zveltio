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

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Files that still read key material directly, with the reason each is not
 * simply converted. All three derive keys for data ALREADY AT REST, so moving
 * them changes ciphertext/HMAC inputs and needs a compatibility path rather
 * than a rename. Tracked, not forgotten — this list should only ever shrink.
 */
const ALLOWLIST: Record<string, string> = {
  'auth/scim/engine/routes.ts':
    'HMACs SCIM bearer tokens with BETTER_AUTH_SECRET; changing the input invalidates every issued token.',
  'communications/mail/engine/lib/crypto.ts':
    'AES-256-GCM for stored IMAP/SMTP passwords under MAIL_ENCRYPTION_KEY; its own ciphertext format.',
  'integrations/migrators/engine/routes.ts':
    'AES-256-GCM for stored migrator tokens under FIELD_ENCRYPTION_KEY; `enc1:` format predates ctx.internals.encryptSecret (`enc:v1:`).',
};

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

function scan(root: string): Finding[] {
  const findings: Finding[] = [];
  // Extensions live at <category>/<name>/engine/**.
  for (const category of readdirSync(root)) {
    const catDir = join(root, category);
    if (category.startsWith('.') || !statSync(catDir).isDirectory()) continue;
    for (const name of readdirSync(catDir)) {
      const engineDir = join(catDir, name, 'engine');
      try {
        if (!statSync(engineDir).isDirectory()) continue;
      } catch {
        continue;
      }
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
  }
  return findings;
}

const root = process.argv[2] ?? join(import.meta.dir, '..', '..', 'zveltio-extensions');
const findings = scan(root);

if (findings.length === 0) {
  const allowed = Object.keys(ALLOWLIST).length;
  console.log(
    `✅ ambient-authority: no extension reads process.env or imports an authority-bearing node:* module ` +
      `(${allowed} tracked exception${allowed === 1 ? '' : 's'}).`,
  );
  process.exit(0);
}

console.error(`❌ ambient-authority: ${findings.length} finding(s).\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  [${f.what}]`);
  console.error(`      ${f.text}`);
}
console.error(
  `\nExtensions must not reach for ambient authority.\n` +
    `  • configuration      → ctx.config  (see ExtensionConfig in @zveltio/sdk/extension)\n` +
    `  • encrypt / decrypt  → ctx.internals.encryptSecret / decryptSecret  ("secrets" capability)\n` +
    `  • object storage     → ctx.config.objectStorage  ("storage" capability)\n\n` +
    `If a value genuinely has no home on ctx.config, add it there — deliberately,\n` +
    `as part of the capability contract — rather than reading the engine's environment.\n`,
);
process.exit(1);
