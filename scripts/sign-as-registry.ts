#!/usr/bin/env bun
/**
 * Sign extension directories as a registry download leaves them, for an
 * engine that loads them from disk: a first-party source checkout in local
 * development, the release smoke (fixtures), the e2e and integration lanes and
 * the extensions' runtime probe.
 *
 * Only the registry's signature, kept with the files and re-verified at every
 * load, lets an extension run inline — never its name (U3), in every
 * `NODE_ENV` (ADR 0056 amendment 2026-11-21: no local-dev exception). A
 * directory copied onto disk carries none. This writes, for each one, what the
 * engine's download writes (`<dir>/.zveltio-registry/archive` and
 * `archive.sig`) and prints the key as the `REGISTRY_PUBLIC_KEYS_JSON` line
 * (for `$GITHUB_ENV` or `.env`). The engine then trusts it as it trusts any
 * additional registry key. Sign again after any change to the directory.
 *
 * Usage: bun scripts/sign-as-registry.ts <extensions-dir> [name ...] [--key-id <id>]
 *        (no name: every directory under it holding a manifest.json)
 *   --key-id <id>  sign with `~/.zveltio/keys/<id>.json` (`zveltio keys generate
 *                  --id <id>`), so the printed line stays the same across runs —
 *                  a developer's own test key. Without it: a key made for this
 *                  run and thrown away with it (CI).
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { REGISTRY_SIGNED_DIR } from '../packages/engine/src/lib/security/extension-dir-signature.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--key-id');
const ownKeyId = at === -1 ? undefined : args.splice(at, 2)[1];
const [base, ...given] = args;
// A file name under ~/.zveltio/keys, never a path (`zveltio keys` ids are such names).
if (!base || (at !== -1 && !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(ownKeyId ?? ''))) {
  console.error(
    'usage: bun scripts/sign-as-registry.ts <extensions-dir> [name ...] [--key-id <id>]',
  );
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

/** A key `zveltio keys generate` wrote: `{ keyId, publicJwk, privateJwk }`. */
async function ownKey(id: string): Promise<{ keyId: string; pair: CryptoKeyPair }> {
  const file = join(homedir(), '.zveltio', 'keys', `${id}.json`);
  if (!existsSync(file)) {
    console.error(`no key ${file}: make it with \`zveltio keys generate --id ${id}\``);
    process.exit(2);
  }
  const kp = JSON.parse(readFileSync(file, 'utf8')) as {
    keyId: string;
    publicJwk: JsonWebKey;
    privateJwk: JsonWebKey;
  };
  if (kp.keyId !== id) {
    console.error(`${file} holds key "${kp.keyId}", not "${id}"`);
    process.exit(2);
  }
  const alg = { name: 'Ed25519' };
  return {
    keyId: kp.keyId,
    pair: {
      privateKey: await crypto.subtle.importKey('jwk', kp.privateJwk, alg, false, ['sign']),
      publicKey: await crypto.subtle.importKey('jwk', kp.publicJwk, alg, true, ['verify']),
    },
  };
}

const { keyId, pair } = ownKeyId
  ? await ownKey(ownKeyId)
  : {
      keyId: `ci-registry-${Date.now()}`,
      pair: (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
        'sign',
        'verify',
      ])) as CryptoKeyPair,
    };
const publicKeyHex = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString(
  'hex',
);
const names = given.length > 0 ? given : extensionDirs(base);
// Only a directory under `base` is rewritten: `..` or an absolute name is
// refused, before anything is written.
const root = realpathSync(base);
const dirs = names.map((name) => {
  const dir = resolve(root, name);
  if (!existsSync(join(dir, 'manifest.json')) || !realpathSync(dir).startsWith(`${root}${sep}`)) {
    console.error(`"${name}" is not an extension directory under ${root}`);
    process.exit(2);
  }
  return [name, dir] as const;
});
const tmp = mkdtempSync(join(tmpdir(), 'sign-as-registry-'));
for (const [name, dir] of dirs) {
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
