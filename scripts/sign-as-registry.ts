#!/usr/bin/env bun
/**
 * Sign extension directories as a registry download leaves them, for a
 * production boot that loads them from disk: the release smoke (fixtures) and
 * the extensions' runtime probe (a source checkout).
 *
 * In production only the registry's signature, kept with the files and
 * re-verified at every load, lets an extension run inline — never its name
 * (U3). A directory copied onto disk carries none. This writes, for each one,
 * what the engine's download writes (`<dir>/.zveltio-registry/archive` and
 * `archive.sig`), signed with a key made for this run, and prints that key as
 * the `REGISTRY_PUBLIC_KEYS_JSON` line to append to `$GITHUB_ENV`. The engine
 * then trusts it as it trusts any additional registry key. Test fixtures only:
 * the key is thrown away with the run.
 *
 * Usage: bun scripts/sign-as-registry.ts <extensions-dir> [name ...]
 *        (no name: every directory under it holding a manifest.json)
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { REGISTRY_SIGNED_DIR } from '../packages/engine/src/lib/security/extension-dir-signature.ts';

const [base, ...given] = process.argv.slice(2);
if (!base) {
  console.error('usage: bun scripts/sign-as-registry.ts <extensions-dir> [name ...]');
  process.exit(2);
}

function extensionDirs(dir: string): string[] {
  const found: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue;
    const sub = join(dir, d.name);
    if (existsSync(join(sub, 'manifest.json'))) found.push(relative(base!, sub));
    else found.push(...extensionDirs(sub));
  }
  return found;
}

const keyId = `ci-registry-${Date.now()}`;
const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
  'sign',
  'verify',
])) as CryptoKeyPair;
const publicKeyHex = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString(
  'hex',
);
const tmp = mkdtempSync(join(tmpdir(), 'sign-as-registry-'));
const names = given.length > 0 ? given : extensionDirs(base);
for (const name of names) {
  const dir = join(base, name);
  const kept = join(dir, REGISTRY_SIGNED_DIR);
  rmSync(kept, { recursive: true, force: true });
  const archive = join(tmp, 'archive.tar.gz');
  const tar = Bun.spawnSync(['tar', '-czf', archive, '-C', dir, '.']);
  if (tar.exitCode !== 0) throw new Error(`tar ${name}: ${tar.stderr.toString()}`);
  const bytes = readFileSync(archive);
  const bundleSha256 = createHash('sha256').update(bytes).digest('hex');
  const signature = Buffer.from(
    await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(bundleSha256)),
  ).toString('base64');
  mkdirSync(kept);
  writeFileSync(join(kept, 'archive'), bytes);
  writeFileSync(
    join(kept, 'archive.sig'),
    JSON.stringify({ algorithm: 'ed25519', signature, bundleSha256, keyId }),
  );
}
rmSync(tmp, { recursive: true, force: true });
console.error(`signed ${names.length} extension(s) with ${keyId}`);
console.log(`REGISTRY_PUBLIC_KEYS_JSON=${JSON.stringify([{ keyId, publicKeyHex }])}`);
