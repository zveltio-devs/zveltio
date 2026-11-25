/**
 * Signs extension directories as an operator does (level 3), with a key kept in a
 * file so every run trusts the same one. Prints the OPERATOR_PUBLIC_KEYS_JSON line.
 *   bun small-vps-sign.ts <key.json> <extensions-dir> <name>...
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIR_SIGNATURE_FILE, extensionDirListing } from '../../src/lib/security/index.js';

const [keyFile, base, ...names] = process.argv.slice(2);
const KEY_ID = 'bench-operator';
if (!existsSync(keyFile!)) {
  const kp = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  writeFileSync(
    keyFile!,
    JSON.stringify({
      priv: await crypto.subtle.exportKey('jwk', kp.privateKey),
      pub: Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('hex'),
    }),
  );
}
const key = JSON.parse(readFileSync(keyFile!, 'utf8'));
const priv = await crypto.subtle.importKey('jwk', key.priv, 'Ed25519', false, ['sign']);
for (const name of names) {
  const dir = join(base!, name);
  const listing = extensionDirListing(dir, name, 'private', { operator: true });
  const bundleSha256 = createHash('sha256').update(listing).digest('hex');
  const signature = Buffer.from(
    await crypto.subtle.sign('Ed25519', priv, new TextEncoder().encode(bundleSha256)),
  ).toString('base64');
  writeFileSync(
    join(dir, DIR_SIGNATURE_FILE),
    JSON.stringify({
      algorithm: 'ed25519',
      signature,
      bundleSha256,
      keyId: KEY_ID,
      tier: 'private',
    }),
  );
}
console.log(
  `OPERATOR_PUBLIC_KEYS_JSON=${JSON.stringify([{ keyId: KEY_ID, publicKeyHex: key.pub }])}`,
);
