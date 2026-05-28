/**
 * `zveltio extension publish` — end-to-end ship flow for an extension (S4-05).
 *
 * Pipeline:
 *   1. validate  (composes S4-04: manifest + peerDeps + migrations + size)
 *   2. build     (optional, controlled by --no-build; Studio + engine bundles)
 *   3. archive   (tar.gz of the extension folder, minus node_modules/.zveltio/dist-internals)
 *   4. sign      (Ed25519 over sha256(archive); signature envelope written next to .zvext)
 *   5. publish   (HTTP POST multipart to the registry — or local-only with --output)
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

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
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
 * Tar+gzip the extension directory. Excludes generated and developer-local
 * folders so the archive stays small and reproducible. Uses the system tar
 * (Windows 10+ / macOS / Linux all ship one) — keeps the CLI dependency-free.
 */
async function createArchive(dir: string, outFile: string): Promise<void> {
  const excludes = [
    'node_modules',
    '.zveltio',
    'dist',
    'engine/dist',
    '.git',
    '.DS_Store',
    '*.zvext',
    '*.zvext.sig',
  ];
  // `--force-local` keeps GNU tar from interpreting `C:\path\file.zvext` as a
  // remote ssh-style target. Harmless on macOS/Linux where the flag is also
  // recognized by GNU tar; BSD tar (default on macOS pre-Big Sur) ignores it.
  const args: string[] = ['--force-local', '-czf', outFile];
  for (const ex of excludes) {
    args.push('--exclude', ex);
  }
  args.push('.');
  // Spawn with `cwd = dir` instead of `-C` so the archive is rooted at the
  // extension folder regardless of where the CLI was invoked from.
  const proc = Bun.spawn(['tar', ...args], { cwd: dir, stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`tar failed (exit ${code})`);
}

async function runStudioBuild(dir: string): Promise<void> {
  if (!existsSync(join(dir, 'studio'))) return;
  const proc = Bun.spawn(['bun', 'run', 'build'], {
    cwd: join(dir, 'studio'),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`Studio build failed (exit ${code})`);
}

async function runEnginePack(dir: string): Promise<void> {
  if (!existsSync(join(dir, 'engine', 'index.ts'))) return;
  await extensionPackCommand({ dir });
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

  console.log(`  Name:          ${c.bold(manifest.name)} ${c.dim('v' + manifest.version)}`);

  // 2. Validate (composes S4-04 — silentExit so we control the flow).
  // Commander sets `--no-validate` → opts.validate === false.
  const runValidate = opts.validate !== false;
  if (runValidate) {
    console.log(`\n${c.bold('Step 1/5: validate')}`);
    try {
      await extensionValidateCommand({ dir, silentExit: true });
    } catch (e) {
      console.error(c.red(`Validate failed: ${(e as Error).message}`));
      process.exit(1);
    }
  } else {
    console.log(c.yellow('\nSkipping validate (--no-validate)'));
  }

  // 3. Pack engine (Bun.build of engine/index.ts → engine/index.js, plus
  //    manifest patch with engine + integrity.engineSha256).
  const runPackStep = opts.pack !== false && opts.build !== false;
  if (runPackStep) {
    console.log(`\n${c.bold('Step 2/6: pack engine')}`);
    try {
      await runEnginePack(dir);
      // Re-read manifest — pack patched engine + integrity blocks.
      manifest = readManifest(dir);
    } catch (e) {
      console.error(c.red((e as Error).message));
      process.exit(1);
    }
  } else {
    console.log(c.yellow(`\nSkipping pack (${opts.build === false ? '--no-build' : '--no-pack'})`));
  }

  // 4. Studio build.
  const runBuildStep = opts.build !== false;
  if (runBuildStep) {
    console.log(`\n${c.bold('Step 3/6: studio build')}`);
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

  // 6. Publish (or stop here in local mode).
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
      console.log(c.green(`  HTTP ${result.status} — published.`));
      console.log(c.dim(`  Body: ${result.body.slice(0, 200)}`));
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
export const _internalForTests = { artifactBaseName, readManifest };
