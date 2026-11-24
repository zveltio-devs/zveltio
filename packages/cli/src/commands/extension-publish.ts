/**
 * `zveltio extension publish` — end-to-end ship flow for an extension (S4-05).
 *
 * Pipeline:
 *   1. pack      (engine bundle + manifest integrity; --no-pack / --no-build skip it)
 *   2. build     (Studio, `bun run build` in studio/; --no-build skips it)
 *   3. validate  (composes S4-04 on what 1 and 2 left — the files that ship;
 *                 a failure stops the publish with exit 1)
 *   4. archive   (tar.gz of `archiveFiles`: no dot-entries, node_modules, dist)
 *   5. sign      (Ed25519 over sha256(archive); signature envelope written next to .zvext)
 *   6. upload    (HTTP POST multipart to the registry — or local-only with --output)
 *
 * Local-only mode (no registry round-trip):
 *   $ zveltio extension publish --output ./out
 *   → ./out/<name>-<version>.zvext + .sig
 *
 * Registry mode (when the upstream endpoint is wired up):
 *   $ zveltio extension publish --token $ZVELTIO_REGISTRY_TOKEN
 *
 * The CLI is shippable today even though the registry upload endpoint is
 * still a follow-up; local-mode covers CI + manual upload + air-gapped use.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join, basename, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import { signBundle, sha256Hex } from '@zveltio/sdk/publish';
import { extensionValidateCommand } from './extension-validate.js';
import { extensionPackCommand } from './extension-pack.js';
import { readKeyFile, resolveKeyId } from './keys.js';

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

export interface ExtensionPublishOptions {
  /** Extension root. Defaults to cwd. */
  dir?: string;
  /**
   * Commander sets `build: false` when the user passes `--no-build`.
   * Default is `true` (Studio bundle + engine pack run unless disabled).
   */
  build?: boolean;
  /** Commander sets `pack: false` when the user passes `--no-pack`. */
  pack?: boolean;
  /** Commander sets `validate: false` when the user passes `--no-validate`. */
  validate?: boolean;
  /** Write the .zvext + .sig locally and skip the HTTP upload. */
  output?: string;
  /** Registry URL. Default: https://registry.zveltio.com */
  registryUrl?: string;
  /** Bearer token for the registry upload. Required unless --output. */
  token?: string;
  /** Override the signing key. Default: the only key in `~/.zveltio/keys/`. */
  keyId?: string;
  /** Dry-run — go through validate + build but skip archive/sign/publish. */
  dryRun?: boolean;
  /** First-party (vendor / monorepo) — allow inline isolation offline. */
  firstParty?: boolean;
}

interface Manifest {
  name: string;
  version: string;
  category?: string;
  [k: string]: unknown;
}

function readManifest(dir: string): Manifest {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) {
    throw new Error(`No manifest.json at ${path}. Run from the extension's root or pass --dir.`);
  }
  const raw = readFileSync(path, 'utf8');
  let m: Manifest;
  try {
    m = JSON.parse(raw) as Manifest;
  } catch (e) {
    throw new Error(`manifest.json is not valid JSON: ${(e as Error).message}`);
  }
  if (!m.name || !m.version) {
    throw new Error('manifest.json is missing required `name` or `version` field.');
  }
  return m;
}

function artifactBaseName(m: Manifest): string {
  // `forms` → `forms-1.0.0.zvext`. Slash-bearing names sanitized.
  return `${m.name.replace(/\//g, '__')}-${m.version}`;
}

/**
 * The files a published archive carries, as `./`-rooted paths, sorted.
 *
 * Left out at any depth: every name starting with `.` (`.env`, `.npmrc`,
 * `.aws/`, `.git/`, `.zveltio/`, `.DS_Store` — a developer's machine, never
 * the extension; no first-party extension ships one), `node_modules`, `dist`
 * and earlier `*.zvext` artifacts. Left out at the root only: the operator's
 * own `signature.json` (ADR 0056) — it signs this directory for one engine,
 * and the registry signs what it serves; a schema file of that name deeper
 * down ships. A symbolic link is refused, as the signed listing refuses it:
 * what it points to is outside the extension.
 */
export function archiveFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel))) {
      const path = rel ? `${rel}/${entry}` : entry;
      if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist') continue;
      if (path === 'signature.json' || /\.zvext(\.sig)?$/.test(entry)) continue;
      if (/[\r\n]/.test(path))
        throw new Error(`file name ${JSON.stringify(path)} cannot be archived`);
      const st = lstatSync(join(dir, path));
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) out.push(`./${path}`);
      else
        throw new Error(`"${path}" is not a regular file or directory (a link is never published)`);
    }
  };
  walk('');
  return out.sort();
}

/**
 * Tar+gzip exactly `archiveFiles(dir)`. Uses the system tar (Windows 10+ /
 * macOS / Linux all ship one) — keeps the CLI dependency-free.
 */
async function createArchive(dir: string, outFile: string): Promise<void> {
  const files = archiveFiles(dir);
  // `--force-local` keeps GNU tar from interpreting `C:\path\file.zvext` as a
  // remote ssh-style target. Harmless on macOS/Linux where the flag is also
  // recognized by GNU tar; BSD tar (default on macOS pre-Big Sur) ignores it.
  // The list comes on stdin and `--no-recursion` keeps tar to it.
  const args = ['--force-local', '--no-recursion', '-czf', outFile, '-T', '-'];
  // Spawn with `cwd = dir` instead of `-C` so the archive is rooted at the
  // extension folder regardless of where the CLI was invoked from.
  const proc = Bun.spawn(['tar', ...args], {
    cwd: dir,
    stdin: new TextEncoder().encode(files.map((f) => `${f}\n`).join('')),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`tar failed (exit ${code})`);
}

async function runStudioBuild(dir: string): Promise<void> {
  // Only a studio/ that declares a build has one to run; view/2 extensions ship
  // their studio/ as data with no package.json.
  const pkg = join(dir, 'studio', 'package.json');
  if (!existsSync(pkg)) return;
  const scripts = (JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> })
    .scripts;
  if (!scripts?.build) return;
  const proc = Bun.spawn(['bun', 'run', 'build'], {
    cwd: join(dir, 'studio'),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`Studio build failed (exit ${code})`);
}

async function runEnginePack(
  dir: string,
  tierOpts: { firstParty?: boolean; token?: string; registryUrl?: string },
): Promise<void> {
  // A Studio-only extension packs only for its declared collections' digest.
  const { collections } = readManifest(dir);
  const declares = Array.isArray(collections) && collections.length > 0;
  if (!existsSync(join(dir, 'engine', 'index.ts')) && !declares) return;
  await extensionPackCommand({ dir, ...tierOpts });
}

async function uploadToRegistry(opts: {
  registryUrl: string;
  token: string;
  archive: Uint8Array;
  signatureJson: string;
  manifest: Manifest;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${opts.registryUrl.replace(/\/$/, '')}/api/v1/extensions/publish`;
  const form = new FormData();
  form.append(
    'manifest',
    new Blob([JSON.stringify(opts.manifest)], { type: 'application/json' }),
    'manifest.json',
  );
  form.append(
    'signature',
    new Blob([opts.signatureJson], { type: 'application/json' }),
    'signature.json',
  );
  form.append(
    'archive',
    new Blob([opts.archive as BlobPart], { type: 'application/gzip' }),
    `${artifactBaseName(opts.manifest)}.zvext`,
  );

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.token}` },
    body: form,
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

export async function extensionPublishCommand(opts: ExtensionPublishOptions = {}): Promise<void> {
  const dir = resolve(opts.dir ?? process.cwd());
  const registryUrl =
    opts.registryUrl ?? process.env.ZVELTIO_REGISTRY_URL ?? 'https://registry.zveltio.com';
  const token = opts.token ?? process.env.ZVELTIO_REGISTRY_TOKEN;

  console.log(`\n${c.bold('Extension publish')}\n`);
  console.log(`  Extension dir: ${c.dim(dir)}`);

  // 1. Manifest (must succeed for everything downstream). `let` because
  //    we re-read it after `pack` patches engine + integrity.engineSha256.
  let manifest: Manifest;
  try {
    manifest = readManifest(dir);
  } catch (e) {
    console.error(c.red((e as Error).message));
    process.exit(1);
  }

  console.log(`  Name:          ${c.bold(manifest.name)} ${c.dim(`v${manifest.version}`)}`);

  // 2. Pack engine (Bun.build of engine/index.ts → engine/index.js, plus
  //    manifest patch with engine + integrity.engineSha256).
  const runPackStep = opts.pack !== false && opts.build !== false;
  if (runPackStep) {
    console.log(`\n${c.bold('Step 1/6: pack engine')}`);
    try {
      await runEnginePack(dir, {
        firstParty: opts.firstParty,
        token,
        registryUrl,
      });
    } catch (e) {
      console.error(c.red((e as Error).message));
      process.exit(1);
    }
  } else {
    console.log(c.yellow(`\nSkipping pack (${opts.build === false ? '--no-build' : '--no-pack'})`));
  }

  // 3. Studio build.
  const runBuildStep = opts.build !== false;
  if (runBuildStep) {
    console.log(`\n${c.bold('Step 2/6: studio build')}`);
    try {
      await runStudioBuild(dir);
    } catch (e) {
      console.error(c.red((e as Error).message));
      process.exit(1);
    }
    console.log(c.green('  build OK'));
  } else {
    console.log(c.yellow('\nSkipping build (--no-build)'));
  }

  // 4. Validate what ships: after pack and the Studio build, which both write
  //    into the directory the archive is made from. `silentExit` throws on a
  //    failure instead of exiting, and the throw stops the publish here.
  // Commander sets `--no-validate` → opts.validate === false.
  const runValidate = opts.validate !== false;
  if (runValidate) {
    console.log(`\n${c.bold('Step 3/6: validate')}`);
    try {
      // Pass tier-resolution inputs so validate's §2 isolation gate uses
      // the same publisher tier publish will. With a token, a verified
      // partner's inline extension passes; without, community is assumed.
      await extensionValidateCommand({
        dir,
        silentExit: true,
        firstParty: opts.firstParty,
        token,
        registryUrl,
      });
    } catch (e) {
      console.error(c.red(`Validate failed: ${(e as Error).message}`));
      process.exit(1);
    }
  } else {
    console.log(c.yellow('\nSkipping validate (--no-validate)'));
  }

  // Pack patched the engine + integrity blocks; the archive and the upload
  // carry the manifest as it is now.
  try {
    manifest = readManifest(dir);
  } catch (e) {
    console.error(c.red((e as Error).message));
    process.exit(1);
  }

  if (opts.dryRun) {
    console.log(`\n${c.green('Dry-run complete')} — skipped archive/sign/publish.\n`);
    return;
  }

  // 5. Archive.
  console.log(`\n${c.bold('Step 4/6: archive')}`);
  const tmpDir = opts.output
    ? resolve(opts.output)
    : join(tmpdir(), `zveltio-publish-${Date.now()}`);
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  const zvextPath = join(tmpDir, `${artifactBaseName(manifest)}.zvext`);
  try {
    await createArchive(dir, zvextPath);
  } catch (e) {
    console.error(c.red((e as Error).message));
    process.exit(1);
  }
  const archive = new Uint8Array(readFileSync(zvextPath));
  const stat = statSync(zvextPath);
  console.log(`  ${c.dim(zvextPath)} ${c.dim(`(${(stat.size / 1024).toFixed(1)} KB)`)}`);

  // 6. Sign.
  console.log(`\n${c.bold('Step 5/6: sign')}`);
  let keyId: string;
  try {
    keyId = resolveKeyId(opts.keyId);
  } catch (e) {
    console.error(c.red((e as Error).message));
    process.exit(1);
  }
  let signature: Awaited<ReturnType<typeof signBundle>>;
  let sigPath: string;
  try {
    const keypair = readKeyFile(keyId);
    signature = await signBundle(archive, keypair);
    sigPath = `${zvextPath}.sig`;
    writeFileSync(sigPath, JSON.stringify(signature, null, 2), 'utf8');
  } catch (e) {
    console.error(c.red(`  Signing failed: ${(e as Error).message}`));
    console.error(c.dim((e as Error).stack ?? ''));
    process.exit(1);
  }
  const digest = await sha256Hex(archive);
  console.log(`  keyId:         ${c.green(keyId)}`);
  console.log(`  bundleSha256:  ${c.dim(digest.slice(0, 16) + '…')}`);
  console.log(`  signature:     ${c.dim(sigPath)}`);

  // 7. Publish (or stop here in local mode).
  if (opts.output) {
    console.log(`\n${c.green('Local publish complete.')}`);
    console.log(
      c.dim(
        `  Artifacts in ${tmpDir}. Upload them to the registry manually, or re-run without --output.`,
      ),
    );
    console.log('');
    return;
  }

  if (!token) {
    console.error(c.red('\nNo registry token provided.'));
    console.error(
      c.dim(
        '  Pass --token <token>, set ZVELTIO_REGISTRY_TOKEN, or use --output <dir> for a local-only build.',
      ),
    );
    process.exit(1);
  }

  console.log(`\n${c.bold('Step 6/6: upload')}`);
  console.log(`  Registry:      ${c.dim(registryUrl)}`);
  try {
    const result = await uploadToRegistry({
      registryUrl,
      token,
      archive,
      signatureJson: JSON.stringify(signature, null, 2),
      manifest,
    });
    if (result.ok) {
      console.log(c.green(`  HTTP ${result.status} — submission received.`));
      console.log(c.dim(`  Body: ${result.body.slice(0, 200)}`));
      console.log('');
      console.log(c.yellow('  ⏳ Your submission is in the review queue (status: pending).'));
      console.log(
        c.dim(`     Marketplace admins review community submissions before they go live.`),
      );
      console.log(
        c.dim(`     You'll be notified at your registered email when the decision lands.`),
      );
      console.log(c.dim(`     Check status: zveltio extension status ${manifest.name}`));
    } else if (result.status === 404) {
      // Friendly message: this is the expected state until the registry
      // endpoint lands in zveltio-registry.
      console.error(
        c.yellow(
          `  HTTP 404 — the registry at ${registryUrl} does not implement /api/v1/extensions/publish yet.`,
        ),
      );
      console.error(
        c.dim(
          '  Use --output <dir> to ship locally for now. The CLI bits ahead of the server is intentional.',
        ),
      );
      process.exit(2);
    } else if (result.status === 422) {
      // Most likely the §2 isolation gate. Surface the structured fields
      // instead of a raw body dump.
      let parsed: { error?: string; code?: string; docs?: string } = {};
      try {
        parsed = JSON.parse(result.body);
      } catch {
        /* fall back to raw */
      }
      if (parsed.code === 'ISOLATION_POLICY_VIOLATION') {
        console.error(c.red(`  HTTP 422 — isolation policy violation.`));
        console.error(c.dim(`  ${parsed.error ?? result.body.slice(0, 300)}`));
        console.error(
          c.dim(
            '  Re-pack with engine.isolation: "worker" (community publishers), ' +
              'or enroll as a verified publisher to ship inline.',
          ),
        );
        if (parsed.docs) console.error(c.dim(`  ${parsed.docs}`));
      } else {
        console.error(c.red(`  HTTP 422 — ${parsed.error ?? 'submission rejected'}.`));
        console.error(c.dim(`  Body: ${result.body.slice(0, 400)}`));
      }
      process.exit(1);
    } else {
      console.error(c.red(`  HTTP ${result.status} — upload failed.`));
      console.error(c.dim(`  Body: ${result.body.slice(0, 400)}`));
      process.exit(1);
    }
  } catch (e) {
    console.error(c.red(`  Upload error: ${(e as Error).message}`));
    process.exit(1);
  }
  console.log('');
}

// ── Internal for tests ───────────────────────────────────────────────────────
export const _internalForTests = { artifactBaseName, createArchive, readManifest };
