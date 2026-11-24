/**
 * Tests only: sign an extension directory as an operator signs it (ADR 0056 d1,
 * level 3), in process, so a worker fixture loads the way production loads one.
 * No unsigned worker runs, under the test override either (RFC v3 phase D
 * slice 4, S4): a worker fixture is signed here, never let through unsigned.
 *
 * The listing is the engine's own (`extensionDirListing`); the CLI's signer is
 * held to it by `tests/harness/ext-operator-signed.test.ts`. The key is one per
 * process, and every call puts it back on `OPERATOR_PUBLIC_KEYS_JSON` (the
 * engine reads that list at every verification), so a suite that restored the
 * variable cannot leave a later one's fixtures unverifiable.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DIR_SIGNATURE_FILE, extensionDirListing } from '../lib/security/extension-dir-signature.js';

export const TEST_OPERATOR_KEY_ID = 'test-operator';

let pair: Promise<{ privateKey: CryptoKey; publicKeyHex: string }> | null = null;

function keypair(): Promise<{ privateKey: CryptoKey; publicKeyHex: string }> {
  pair ??= (async () => {
    const kp = (await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    return { privateKey: kp.privateKey, publicKeyHex: Buffer.from(raw).toString('hex') };
  })();
  return pair;
}

/** Put the test key on the operator's list, keeping any key already there. */
export async function trustTestOperatorKey(): Promise<void> {
  const { publicKeyHex } = await keypair();
  let keys: { keyId: string }[] = [];
  try {
    keys = JSON.parse(process.env.OPERATOR_PUBLIC_KEYS_JSON ?? '[]');
  } catch {}
  if (!Array.isArray(keys)) keys = [];
  keys = keys.filter((k) => k?.keyId !== TEST_OPERATOR_KEY_ID);
  keys.push({ keyId: TEST_OPERATOR_KEY_ID, publicKeyHex } as { keyId: string });
  process.env.OPERATOR_PUBLIC_KEYS_JSON = JSON.stringify(keys);
}

/**
 * Sign `dir`, loaded as `name` (its directory name by default), with the test
 * operator key. Sign after the last write: a byte changed afterwards refuses the
 * load. Returns the key id, as `WorkerCtxSource.keyId` takes it.
 */
export async function signAsOperator(dir: string, name = basename(dir)): Promise<string> {
  const { privateKey } = await keypair();
  await trustTestOperatorKey();
  const listing = extensionDirListing(dir, name, 'private', { operator: true });
  const bundleSha256 = createHash('sha256').update(listing).digest('hex');
  const signature = Buffer.from(
    await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(bundleSha256)),
  ).toString('base64');
  writeFileSync(
    join(dir, DIR_SIGNATURE_FILE),
    JSON.stringify({
      algorithm: 'ed25519',
      signature,
      bundleSha256,
      keyId: TEST_OPERATOR_KEY_ID,
      tier: 'private',
    }),
  );
  return TEST_OPERATOR_KEY_ID;
}
