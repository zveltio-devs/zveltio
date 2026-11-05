/**
 * The Deno binary the job runner spawns (ADR 0022 decision 8).
 *
 * Not bundled with the engine. `ZVELTIO_DENO_PATH` names one the operator
 * provides (an air-gapped host, a prebuilt image); otherwise the engine
 * downloads ONE exact version, pinned here with the SHA-256 of each platform's
 * archive and of the binary inside it, into the install's extensions directory.
 * The binary's digest is checked once per boot before its first spawn, so a
 * file swapped on disk is refused, not run. No auto-update: a Deno bump is an
 * engine release that edits this table.
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { installExtensionsBase } from './extension-paths.js';

export const DENO_VERSION = '2.9.8';

/** Per `${process.platform}-${process.arch}`: the release archive and the binary in it. */
const PINNED: Record<string, { target: string; zip: string; bin: string }> = {
  'linux-x64': {
    target: 'x86_64-unknown-linux-gnu',
    zip: 'e890975bc2549807bbcc0b584ffafda72cc7c93349dd99c80483dd784f6c4609',
    bin: '368bca08999e02c6911b8f248167b582276b1f547db5712b6e736d7eda1dbda7',
  },
  'linux-arm64': {
    target: 'aarch64-unknown-linux-gnu',
    zip: 'd49596c20b9788cf8f5d8ddf644103d4bde56ed239753f0bdb92ba9361d51905',
    bin: 'b484f780e5149ca05c673f1f79f7fb466f12a2295933bdad917af4a8a5c020e8',
  },
  'darwin-x64': {
    target: 'x86_64-apple-darwin',
    zip: '4b2f5edd2639b7470f034238b321d7002d8dfb4726d8558f52c17afac370eb2c',
    bin: '5d206ba69742549cc161db06e86f1d93c5622e1dbc8ba9d15a618e538fbc92f4',
  },
  'darwin-arm64': {
    target: 'aarch64-apple-darwin',
    zip: '9f0bf660393da2eaff044cdc7444cb08c73f235849b61d224d825a194ce7c98e',
    bin: 'd1e99265e5e6ee096c5780d88ff7d3e6cfdf33b1953a118b4889cab8ca6980ba',
  },
};

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** Where the downloaded binary lives. */
export function denoInstallPath(): string {
  const base = installExtensionsBase() ?? join(process.cwd(), 'extensions');
  return join(base, '.deno', DENO_VERSION, 'deno');
}

/**
 * The single entry of a release archive. Deno's are one deflated file; this
 * reads the central directory (sizes in a local header may be zero) and
 * refuses anything else rather than guessing.
 */
export function unzipSingle(zip: Uint8Array): Uint8Array {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0 || v.getUint16(eocd + 10, true) !== 1) throw new Error('not a one-entry zip');
  const cd = v.getUint32(eocd + 16, true);
  if (v.getUint32(cd, true) !== 0x02014b50) throw new Error('bad zip central directory');
  const method = v.getUint16(cd + 10, true);
  const compressed = v.getUint32(cd + 20, true);
  const size = v.getUint32(cd + 24, true);
  const local = v.getUint32(cd + 42, true);
  if (v.getUint32(local, true) !== 0x04034b50) throw new Error('bad zip local header');
  const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
  const data = zip.subarray(start, start + compressed);
  if (method === 0) return data;
  if (method !== 8) throw new Error(`zip compression method ${method} is not supported`);
  const out = inflateRawSync(data);
  if (out.length !== size) throw new Error('zip entry size mismatch');
  return out;
}

let resolved: Promise<string> | null = null;

/**
 * The verified binary's path. Downloads it on first use when no
 * `ZVELTIO_DENO_PATH` is set. Rejects, saying why, when it cannot be had or
 * does not match its digest; a later call tries again.
 */
export function ensureDeno(): Promise<string> {
  resolved ??= locate().catch((err: Error) => {
    resolved = null;
    throw err;
  });
  return resolved;
}

async function locate(): Promise<string> {
  const own = process.env.ZVELTIO_DENO_PATH;
  // The operator's binary is theirs to vouch for: only its presence is checked.
  if (own) {
    if (!existsSync(own)) throw new Error(`ZVELTIO_DENO_PATH=${own} does not exist`);
    return own;
  }
  const pin = PINNED[`${process.platform}-${process.arch}`];
  if (!pin) {
    throw new Error(
      `no pinned Deno for ${process.platform}-${process.arch}; set ZVELTIO_DENO_PATH to a Deno ${DENO_VERSION} binary`,
    );
  }
  const path = denoInstallPath();
  if (!existsSync(path)) await download(pin, path);
  const actual = sha256(readFileSync(path));
  if (actual !== pin.bin) {
    throw new Error(
      `the Deno binary at ${path} hashes to ${actual}, not the pinned ${pin.bin}; ` +
        'jobs that need the runner do not run. Delete it to download it again.',
    );
  }
  return path;
}

async function download(pin: { target: string; zip: string }, path: string): Promise<void> {
  const url = `https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-${pin.target}.zip`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`downloading Deno from ${url} answered ${res.status}`);
  const zip = new Uint8Array(await res.arrayBuffer());
  const actual = sha256(zip);
  if (actual !== pin.zip) {
    throw new Error(`the Deno archive from ${url} hashes to ${actual}, not the pinned ${pin.zip}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  // Renamed into place, so a crash mid-write never leaves a half binary at `path`.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, unzipSingle(zip));
  chmodSync(tmp, 0o755);
  renameSync(tmp, path);
}
