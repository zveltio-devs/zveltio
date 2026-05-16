/**
 * `zveltio keys ...` — manage Ed25519 keypairs used to sign extension
 * archives at publish time (S4-05).
 *
 * Stored at `~/.zveltio/keys/<keyId>.json` (mode 0600 on POSIX). One file per
 * keypair, JWK-encoded. Public half can be copy-pasted to a registry admin
 * or the engine's `REGISTRY_PUBLIC_KEYS_JSON` env via `zveltio keys export`.
 *
 * Subcommands:
 *   - generate [--id <name>] — create a new keypair (fails if --id collides).
 *   - list                   — show all known keypairs (id, created-at).
 *   - export <id>            — print the trusted-key JSON entry for the engine.
 *
 * No key rotation / revocation flow yet — that belongs in the registry
 * (admin tool) and is tracked separately.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import {
  generateKeypair,
  exportTrustedKeyEntry,
  type ZveltioKeypair,
} from '@zveltio/sdk/publish';

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

/** `~/.zveltio/keys`. Created on demand. */
export function keysDir(): string {
  return join(homedir(), '.zveltio', 'keys');
}

function ensureKeysDir(): string {
  const dir = keysDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    // POSIX: restrict to 0700 so private keys aren't readable by others.
    // Windows: NTFS ACLs default to user-only — no chmod needed.
    if (platform() !== 'win32') {
      try { chmodSync(dir, 0o700); } catch { /* best effort */ }
    }
  }
  return dir;
}

function keyPath(keyId: string): string {
  return join(keysDir(), `${keyId}.json`);
}

function writeKeyFile(kp: ZveltioKeypair): void {
  const path = keyPath(kp.keyId);
  writeFileSync(path, JSON.stringify(kp, null, 2), 'utf8');
  if (platform() !== 'win32') {
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
  }
}

export function readKeyFile(keyId: string): ZveltioKeypair {
  const path = keyPath(keyId);
  if (!existsSync(path)) {
    throw new Error(`Keypair "${keyId}" not found at ${path}. Run \`zveltio keys generate --id ${keyId}\` first.`);
  }
  const raw = readFileSync(path, 'utf8');
  const kp = JSON.parse(raw) as ZveltioKeypair;
  if (!kp.privateJwk || !kp.publicJwk || kp.keyId !== keyId) {
    throw new Error(`Keypair file at ${path} is malformed`);
  }
  return kp;
}

/** Resolve a key to use: explicit id, sole key in the directory, or fail. */
export function resolveKeyId(explicit?: string): string {
  if (explicit) return explicit;
  const dir = keysDir();
  if (!existsSync(dir)) {
    throw new Error('No keypairs found. Run `zveltio keys generate` first.');
  }
  const ids = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  if (ids.length === 0) throw new Error('No keypairs found. Run `zveltio keys generate` first.');
  if (ids.length > 1) {
    throw new Error(`Multiple keypairs exist (${ids.join(', ')}). Pass --key-id to choose one.`);
  }
  return ids[0];
}

// ── Subcommands ──────────────────────────────────────────────────────────────

export interface KeysGenerateOptions {
  /** Stable identifier for the new key. Random if omitted. */
  id?: string;
  /** Allow overwriting an existing key with the same id. */
  force?: boolean;
}

export async function keysGenerateCommand(opts: KeysGenerateOptions = {}): Promise<void> {
  ensureKeysDir();
  const kp = await generateKeypair(opts.id);

  if (existsSync(keyPath(kp.keyId)) && !opts.force) {
    console.error(c.red(`Key "${kp.keyId}" already exists. Pass --force to overwrite.`));
    process.exit(1);
  }

  writeKeyFile(kp);

  console.log(`\n${c.bold('Keypair generated')}\n`);
  console.log(`  keyId:      ${c.green(kp.keyId)}`);
  console.log(`  Created:    ${c.dim(kp.createdAt)}`);
  console.log(`  Stored at:  ${c.dim(keyPath(kp.keyId))}`);
  if (platform() !== 'win32') {
    console.log(`  Permissions: ${c.dim('0600 (user-only)')}`);
  }

  const trusted = await exportTrustedKeyEntry(kp.keyId, kp.publicJwk);
  console.log(`\n${c.bold('Public key (share with registry admin):')}\n`);
  console.log(`  ${JSON.stringify([trusted], null, 2)}`);
  console.log(c.dim('\n  Paste the array above into the engine\'s `REGISTRY_PUBLIC_KEYS_JSON` env to trust this key locally.'));
  console.log('');
}

export async function keysListCommand(): Promise<void> {
  const dir = keysDir();
  if (!existsSync(dir)) {
    console.log(`${c.yellow('No keypairs yet.')} Run ${c.dim('zveltio keys generate')} to create one.`);
    return;
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) {
    console.log(`${c.yellow('No keypairs yet.')} Run ${c.dim('zveltio keys generate')} to create one.`);
    return;
  }
  console.log(`\n${c.bold('Keypairs in')} ${c.dim(dir)}\n`);
  for (const file of files) {
    const keyId = file.slice(0, -5);
    try {
      const kp = readKeyFile(keyId);
      const st = statSync(join(dir, file));
      const sizeKb = (st.size / 1024).toFixed(1);
      console.log(`  ${c.green(keyId.padEnd(24))} ${c.dim(kp.createdAt)} ${c.dim(`(${sizeKb} KB)`)}`);
    } catch (err) {
      console.log(`  ${c.red(keyId)} ${c.dim('— malformed: ' + (err as Error).message)}`);
    }
  }
  console.log('');
}

export async function keysExportCommand(keyId: string): Promise<void> {
  const kp = readKeyFile(keyId);
  const trusted = await exportTrustedKeyEntry(kp.keyId, kp.publicJwk);
  // Plain JSON output — pipe-friendly. No banner.
  console.log(JSON.stringify([trusted], null, 2));
}

// ── Internal helpers exposed for tests only ─────────────────────────────────
export const _internalForTests = { keyPath, ensureKeysDir };
