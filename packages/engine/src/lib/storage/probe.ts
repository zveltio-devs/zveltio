/**
 * Storage connectivity probes for the admin "Test connection" action. Each does
 * a real write → read → delete against the GIVEN config (not the saved one), so
 * an operator can validate a SeaweedFS/S3 endpoint before committing it.
 */

import { AwsClient } from 'aws4fetch';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateStorageEndpoint } from '../security/index.js';
import type { S3Settings } from './config.js';

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/** Round-trip a tiny object through an S3-compatible endpoint. */
export async function probeS3(s3: S3Settings): Promise<ProbeResult> {
  if (!s3.endpoint) return { ok: false, detail: 'S3 endpoint is empty' };
  // SSRF guard: refuse to probe a cloud-metadata/link-local endpoint (IMDS), which
  // is never a real S3 target but would leak instance credentials. Private ranges
  // stay allowed for self-hosted SeaweedFS/MinIO.
  try {
    validateStorageEndpoint(s3.endpoint);
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
  const client = new AwsClient({
    accessKeyId: s3.accessKey,
    secretAccessKey: s3.secretKey,
    region: s3.region || 'us-east-1',
    service: 's3',
  });
  const base = `${s3.endpoint.replace(/\/$/, '')}/${s3.bucket || 'zveltio'}`;
  const key = `.zveltio-probe/${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  const url = `${base}/${key}`;
  try {
    const put = await client.fetch(url, {
      method: 'PUT',
      body: 'zveltio-probe',
      headers: { 'Content-Type': 'text/plain' },
      signal: AbortSignal.timeout(8000),
    });
    if (!put.ok) return { ok: false, detail: `PUT → ${put.status} ${put.statusText}` };
    const get = await client.fetch(url, { method: 'GET', signal: AbortSignal.timeout(8000) });
    if (!get.ok) return { ok: false, detail: `GET → ${get.status}` };
    const body = await get.text();
    await client
      .fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(8000) })
      .catch(() => {});
    if (body !== 'zveltio-probe') return { ok: false, detail: 'GET returned unexpected body' };
    return { ok: true, detail: `write/read/delete OK against ${base}` };
  } catch (err) {
    const m = (err as Error).message;
    return { ok: false, detail: /timeout|abort/i.test(m) ? 'connection timed out' : m };
  }
}

/** Verify the local storage dir is writable via a temp file. */
export async function probeLocal(dir: string): Promise<ProbeResult> {
  const root = resolve(dir);
  const probeDir = resolve(root, '.zveltio-probe');
  try {
    await mkdir(probeDir, { recursive: true });
    const f = resolve(probeDir, `${Date.now()}.txt`);
    await Bun.write(f, 'zveltio-probe');
    const back = await Bun.file(f).text();
    await rm(probeDir, { recursive: true, force: true }).catch(() => {});
    if (back !== 'zveltio-probe') return { ok: false, detail: 'readback mismatch' };
    return { ok: true, detail: `local dir writable: ${root}` };
  } catch (err) {
    return { ok: false, detail: `local dir not writable (${root}): ${(err as Error).message}` };
  }
}
