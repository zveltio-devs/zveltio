/**
 * `zveltio extension validate` — run pre-publish checks against an extension
 * on disk. Pure offline tool: reads files, runs validators from
 * `@zveltio/sdk/validate`, prints a structured report.
 *
 * Exit code 0 = clean. Non-zero = at least one validation error.
 *
 * Run from inside the extension's root (or pass --dir):
 *   $ zveltio extension validate
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import {
  validateExtension,
  validateSduiSchema,
  extractEngineRoutes,
  type ValidationError,
} from '@zveltio/sdk/validate';
import { parseSchema } from '@zveltio/sdk/codegen';
import { resolvePublisherTier, tierAllowsInline } from '../lib/publisher-tier.js';

// ANSI helpers
const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

// Same allow-list as the engine's installer. Kept inline so the CLI doesn't
// reach across into engine internals at runtime. Exported so a test can
// assert it stays in sync with the engine's canonical list — see
// `publisher-tier`-adjacent `peer-deps-allowlist.drift.test.ts`.
export const PEER_DEPS_ALLOWLIST: ReadonlySet<string> = new Set([
  'node-saml',
  'ldapts',
  'imapflow',
  'mailparser',
  'nodemailer',
  '@aws-sdk/client-s3',
  '@aws-sdk/s3-request-presigner',
  'nanoid',
  'qrcode',
  'pdfkit',
  'graphql',
]);

export interface ExtensionValidateOptions {
  /** Override the extension root. Defaults to `process.cwd()`. */
  dir?: string;
  /** Suppress process.exit on validation failure (useful for embedding). */
  silentExit?: boolean;
  /** Treat the publisher as first-party (vendor builds, monorepo) —
   *  allows inline isolation offline without a registry lookup. */
  firstParty?: boolean;
  /** Registry token for the publisher-tier lookup. Defaults to
   *  ZVELTIO_REGISTRY_TOKEN. When present and the publisher is
   *  verified/first-party, inline isolation passes. */
  token?: string;
  /** Registry base URL for the tier lookup. */
  registryUrl?: string;
}

function recursiveSize(dir: string): number {
  let total = 0;
  if (!existsSync(dir)) return 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    // Skip node_modules + .zveltio (generated) + dist
    if (name === 'node_modules' || name === '.zveltio' || name === 'dist') continue;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) total += recursiveSize(full);
    else if (st.isFile()) total += st.size;
  }
  return total;
}

/**
 * Collect the text of an extension's engine route source so route paths can be
 * extracted. Prefers the bundled `engine/index.js` (every route inlined); falls
 * back to the `.ts` sources under `engine/` (excluding migrations).
 */
function readEngineSources(dir: string): string[] {
  const bundled = join(dir, 'engine', 'index.js');
  if (existsSync(bundled)) {
    try {
      return [readFileSync(bundled, 'utf8')];
    } catch {
      /* fall through */
    }
  }
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      if (name === 'migrations' || name === 'node_modules') continue;
      const full = join(d, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (/\.(ts|js)$/.test(name)) {
        try {
          out.push(readFileSync(full, 'utf8'));
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(join(dir, 'engine'));
  return out;
}

/**
 * Infer the folder-path slug from the directory. For
 *   `.../zveltio-extensions/finance/invoicing` → `finance/invoicing`.
 * If the extension is somewhere else, fall back to the basename.
 */
function inferExpectedName(dir: string): string {
  const norm = dir.replace(/\\/g, '/');
  const idx = norm.indexOf('zveltio-extensions/');
  if (idx >= 0) {
    return norm.slice(idx + 'zveltio-extensions/'.length).replace(/\/$/, '');
  }
  return norm.split('/').filter(Boolean).pop() ?? '';
}

export async function extensionValidateCommand(opts: ExtensionValidateOptions = {}): Promise<void> {
  const dir = opts.dir ?? process.cwd();
  console.log(`\n${c.bold('Extension validate')}\n`);
  console.log(`  Extension dir: ${c.dim(dir)}`);

  // Read manifest.json
  const manifestPath = join(dir, 'manifest.json');
  let manifest: unknown = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      console.error(c.red(`  manifest.json is not valid JSON: ${(e as Error).message}`));
      manifest = null;
    }
  }

  // Studio/client-only extensions (`contributes.engine: false`) ship no
  // engine — so engine/index.* is NOT a required file, and the §2 isolation
  // gate + v2-bundle checks don't apply. Computed early so file-presence
  // doesn't flag a missing engine.
  const isStudioOnly =
    manifest != null &&
    typeof manifest === 'object' &&
    (manifest as any)?.contributes?.engine === false &&
    !(manifest as any)?.engine;

  // Read migrations (if folder exists)
  const migrationsDir = join(dir, 'engine', 'migrations');
  let sqlFiles: Array<{ filename: string; sql: string }> = [];
  let parsedTableCount = 0;
  if (existsSync(migrationsDir)) {
    sqlFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((filename) => ({
        filename,
        sql: readFileSync(join(migrationsDir, filename), 'utf8'),
      }));
    try {
      parsedTableCount = parseSchema(sqlFiles.map((f) => f.sql)).tables.length;
    } catch {
      parsedTableCount = 0;
    }
  }

  // File presence
  const paths: Record<string, boolean> = {};
  for (const rel of ['manifest.json', 'engine/index.ts', 'engine/index.js']) {
    paths[rel] = existsSync(join(dir, rel));
  }
  // engine/index.* — accept either .ts or .js. Studio/client-only
  // extensions have no engine, so don't require it.
  const required: string[] = ['manifest.json'];
  if (!isStudioOnly && !(paths['engine/index.ts'] || paths['engine/index.js'])) {
    required.push('engine/index.ts'); // surface as missing
  }

  const bundleBytes = recursiveSize(dir);

  const result = validateExtension({
    manifest: {
      manifest,
      expectedName: inferExpectedName(dir),
    },
    peerDeps: {
      peerDependencies:
        manifest && typeof manifest === 'object' && !Array.isArray(manifest)
          ? (manifest as any).peerDependencies
          : undefined,
      allowedPackages: PEER_DEPS_ALLOWLIST,
    },
    migrations: {
      files: sqlFiles,
      requireDownForDestructive: true,
    },
    filePresence: { paths, required },
    bundleSize: {
      bundleBytes,
      bundleSizeKbMax:
        manifest && typeof manifest === 'object' && !Array.isArray(manifest)
          ? (manifest as any)?.quotas?.bundleSizeKbMax
          : undefined,
    },
    stats: { tables: parsedTableCount, migrations: sqlFiles.length },
  });

  // ── SDUI declarative-page contract ────────────────────────────────────────
  // For every manifest page that ships a `schema`, check its endpoints resolve
  // to routes this extension actually serves (catches the beta.11 class where a
  // wrong dataSource/endpoint rendered an empty table) and stay inside the
  // extension's own /ext/<name>/ namespace.
  const sduiErrors: ValidationError[] = [];
  {
    const pages =
      manifest && typeof manifest === 'object' ? ((manifest as any)?.studio?.pages ?? []) : [];
    const schemaPages = (Array.isArray(pages) ? pages : []).filter(
      (p: any) => typeof p?.schema === 'string',
    );
    if (schemaPages.length > 0) {
      // The manifest's own `name` is authoritative (handles nested names like
      // `hr/payroll` regardless of how `--dir` was passed); fall back to the
      // path only if absent.
      const extName = (
        manifest && typeof manifest === 'object' && typeof (manifest as any).name === 'string'
          ? (manifest as any).name
          : inferExpectedName(dir)
      ) as string;
      const provided = extractEngineRoutes(readEngineSources(dir));
      const dependencies: string[] = Array.isArray((manifest as any)?.dependencies)
        ? (manifest as any).dependencies
            .map((d: any) => (typeof d === 'string' ? d : d?.name))
            .filter((x: any): x is string => typeof x === 'string')
        : [];
      for (const p of schemaPages) {
        // manifest `schema` is relative to the extension's `studio/` dir, the
        // same base the engine uses (embedPageSchemas: join(extDir,'studio',schema)).
        const rel = join('studio', p.schema as string).replace(/\\/g, '/');
        const abs = join(dir, 'studio', p.schema as string);
        let parsed: unknown = null;
        if (!existsSync(abs)) {
          sduiErrors.push({
            code: 'SDUI_SCHEMA_MISSING',
            message: 'schema file not found',
            file: rel,
          });
          continue;
        }
        try {
          parsed = JSON.parse(readFileSync(abs, 'utf8'));
        } catch (e) {
          sduiErrors.push({
            code: 'SDUI_SCHEMA_BAD_JSON',
            message: `not valid JSON: ${(e as Error).message}`,
            file: rel,
          });
          continue;
        }
        sduiErrors.push(
          ...validateSduiSchema({
            schema: parsed,
            extName,
            providedRoutes: provided,
            dependencies,
            file: rel,
          }),
        );
      }
      result.errors.push(...sduiErrors);
      if (sduiErrors.length > 0) result.ok = false;
      console.log(
        `  SDUI schemas:  ${sduiErrors.length === 0 ? c.green(`${schemaPages.length} OK`) : c.red(`${sduiErrors.length} error(s)`)}`,
      );
    }
  }

  // v2 enforcement: warn if manifest is v1 (no engine.bundled block).
  // Hard error if v2 metadata is partial (engine block present but
  // missing required fields or integrity.engineSha256 absent).
  const m = manifest as
    | {
        engine?: { bundled?: boolean; entry?: string; isolation?: 'inline' | 'worker' };
        integrity?: { engineSha256?: string };
        contributes?: { engine?: boolean };
      }
    | null
    | undefined;
  // Studio/client-only (computed early as `isStudioOnly`): declares
  // `contributes.engine: false` and ships no engine block — valid, not a
  // legacy v1 manifest. The engine skips the engine load for these at enable.
  const studioOnly = isStudioOnly;
  const v2Status = (() => {
    if (!m) return 'unknown' as const;
    if (studioOnly) return 'studio-only' as const;
    if (!m.engine) return 'v1-legacy' as const;
    if (m.engine.bundled !== true) return 'engine-not-bundled' as const;
    if (!m.engine.entry) return 'missing-engine-entry' as const;
    if (!m.integrity?.engineSha256) return 'missing-engine-sha' as const;
    return 'v2-ok' as const;
  })();

  // Print summary
  console.log(`  Manifest:      ${manifest ? c.green('OK') : c.red('missing or invalid')}`);
  console.log(
    `  Migrations:    ${c.dim(`${result.stats.migrations} file(s), ${result.stats.tables} table(s) parsed`)}`,
  );
  console.log(`  Peer deps:     ${c.dim(`${result.stats.peerDeps} declared`)}`);
  console.log(`  Bundle size:   ${c.dim(`${Math.ceil(bundleBytes / 1024)} KB`)}`);
  const v2Label =
    v2Status === 'v2-ok'
      ? c.green('v2 (bundled)')
      : v2Status === 'studio-only'
        ? c.green('studio/client-only (no engine)')
        : v2Status === 'v1-legacy'
          ? c.yellow('v1 (no engine block — run `zveltio extension pack`)')
          : v2Status === 'engine-not-bundled'
            ? c.red('engine.bundled !== true — re-pack required')
            : v2Status === 'missing-engine-entry'
              ? c.red('engine.entry missing')
              : v2Status === 'missing-engine-sha'
                ? c.red('integrity.engineSha256 missing — re-pack required')
                : c.dim('unknown');
  console.log(`  Manifest v2:   ${v2Label}`);

  // MARKETPLACE-POLICY §2 enforcement: community submissions MUST declare
  // engine.isolation: 'worker'. The engine refuses inline community
  // extensions at enable, so we hard-fail here (beta.2) instead of just
  // warning — authors should never get to the review queue with an
  // extension nobody can enable.
  //
  // Tier resolution: --first-party (offline) → first-party; else a
  // registry lookup when a token is present (verified partners pass);
  // else community (strictest). resolvePublisherTier never throws.
  // Studio/client-only extensions have no engine, so §2 isolation doesn't
  // apply — there's nothing to run in a worker.
  if (studioOnly) {
    console.log(`  Isolation:     ${c.dim('n/a (no engine)')}`);
    console.log('');
  } else {
    const isolation = m?.engine?.isolation ?? 'inline';
    const resolved = await resolvePublisherTier({
      firstParty: opts.firstParty,
      token: opts.token,
      registryUrl: opts.registryUrl,
    });
    const inlineOk = tierAllowsInline(resolved.tier);
    const tierSrc =
      resolved.source === 'flag'
        ? '--first-party'
        : resolved.source === 'registry'
          ? 'registry'
          : 'default';

    if (isolation === 'worker') {
      console.log(`  Isolation:     ${c.green('worker (runs in any tier)')}`);
    } else if (inlineOk) {
      console.log(
        `  Isolation:     ${c.dim(`inline (${resolved.tier} — allowed, via ${tierSrc})`)}`,
      );
    } else {
      console.log(
        `  Isolation:     ${c.red(`inline — ${resolved.tier} publishers MUST use 'worker'`)}`,
      );
    }
    console.log('');

    if (isolation !== 'worker' && !inlineOk) {
      console.error(
        c.red(
          `Validation failed: ${resolved.tier} publishers must declare ` +
            `engine.isolation: "worker" (MARKETPLACE-POLICY §2).`,
        ),
      );
      console.error(
        c.dim(
          '  Add `"isolation": "worker"` to the engine block in manifest.json, ' +
            'then re-pack. If you are a verified/first-party publisher, pass ' +
            '--first-party or set ZVELTIO_REGISTRY_TOKEN so the tier can be confirmed. ' +
            'See docs/MARKETPLACE-POLICY.md §2.',
        ),
      );
      if (opts.silentExit) throw new Error('Validation failed: community inline isolation');
      process.exit(1);
    }
  }

  // beta.1: hard-fail v1 manifests AND partial v2. All 54 first-party
  // extensions are v2; any v1 today is either dev-time work-in-progress
  // (should run `zveltio extension pack`) or a third-party submission
  // that won't load on the binary anyway.
  if (v2Status === 'v1-legacy') {
    console.error(c.red('Validation failed: manifest is v1 (no engine.bundled block).'));
    console.error(
      c.dim(
        '  v1 manifests are unsupported since 1.0.0-beta.1. Run `zveltio extension pack` to ' +
          'generate the v2 engine + integrity blocks. See docs/EXTENSION-DEVELOPER-GUIDE.md §4.',
      ),
    );
    if (opts.silentExit) throw new Error('Validation failed: v1 manifest unsupported');
    process.exit(1);
  }
  if (
    v2Status === 'engine-not-bundled' ||
    v2Status === 'missing-engine-entry' ||
    v2Status === 'missing-engine-sha'
  ) {
    console.error(c.red('Validation failed: manifest declares v2 engine block but is incomplete.'));
    console.error(
      c.dim('  Run `zveltio extension pack --dir <ext>` to regenerate engine + integrity blocks.'),
    );
    if (opts.silentExit) throw new Error('Validation failed: incomplete v2 manifest');
    process.exit(1);
  }

  if (result.ok) {
    console.log(c.green('Validation passed.'));
    console.log(
      c.dim(
        '  Run `zveltio extension types` to refresh generated types, then `zveltio extension publish` when ready.',
      ),
    );
    console.log('');
    return;
  }

  // Print errors grouped by code
  console.log(c.red(`Validation failed with ${result.errors.length} error(s):`));
  console.log('');
  for (const e of result.errors) {
    printError(e);
  }
  console.log('');
  if (!opts.silentExit) process.exit(1);
}

function printError(e: ValidationError): void {
  const loc = e.file ? c.dim(` (${e.file})`) : '';
  console.log(`  ${c.red(e.code)}  ${e.message}${loc}`);
}

export const _internalForTests = { inferExpectedName, recursiveSize };
