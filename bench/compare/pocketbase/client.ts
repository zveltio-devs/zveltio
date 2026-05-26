/**
 * Pocketbase adapter — translates our generic bench client calls to PB's
 * REST API. Only the surfaces we actually compare are implemented (CRUD,
 * list+pagination). Pocketbase realtime uses SSE which doesn't map 1:1 to
 * our WS bench, so realtime is skipped for the comparison.
 *
 * PB collection format differs from Zveltio's — we create the collection
 * via PB's /api/collections endpoint with the equivalent schema.
 */

import type { BenchHttpClient } from '../../lib/http.js';
import { timedGet, timedPost, timedPatch, timedDelete } from '../../lib/http.js';
import { summarize, type SampleStats } from '../../lib/stats.js';

export interface PbCrudResult {
  collection: string;
  iterations: number;
  create: SampleStats;
  get: SampleStats;
  patch: SampleStats;
  delete: SampleStats;
}

export async function pbAdminAuth(
  baseUrl: string,
  email: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/admins/auth-with-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: email, password }),
  });
  if (!res.ok) throw new Error(`pocketbase admin auth failed: ${res.status}`);
  const data = (await res.json()) as { token: string };
  return data.token;
}

export async function pbCreateCollection(client: BenchHttpClient, name: string): Promise<void> {
  const res = await fetch(`${client.baseUrl}/api/collections`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(client.authToken ? { Authorization: client.authToken } : {}),
    },
    body: JSON.stringify({
      name,
      type: 'base',
      schema: [
        { name: 'title', type: 'text', required: true },
        { name: 'count', type: 'number' },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`pb createCollection ${name} failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

export async function pbDeleteCollection(client: BenchHttpClient, name: string): Promise<void> {
  await fetch(`${client.baseUrl}/api/collections/${name}`, {
    method: 'DELETE',
    headers: client.authToken ? { Authorization: client.authToken } : {},
  });
}

export async function runPbCrud(opts: {
  client: BenchHttpClient;
  warmup: number;
  iterations: number;
}): Promise<PbCrudResult> {
  const { client, warmup, iterations } = opts;
  const name = `bench_${Math.random().toString(16).slice(2, 8)}`;
  await pbCreateCollection(client, name);

  const createSamples: number[] = [];
  const getSamples: number[] = [];
  const patchSamples: number[] = [];
  const deleteSamples: number[] = [];
  const ids: string[] = [];

  try {
    for (let i = 0; i < warmup; i++) {
      await timedPost(client, `/api/collections/${name}/records`, {
        title: `warmup-${i}`,
        count: i,
      });
    }
    for (let i = 0; i < iterations; i++) {
      const r = await timedPost(client, `/api/collections/${name}/records`, {
        title: `row-${i}`,
        count: i,
      });
      if (r.status !== 200) throw new Error(`pb create returned ${r.status}`);
      const id = (r.body as { id?: string })?.id;
      if (!id) throw new Error('pb create missing id');
      ids.push(id);
      createSamples.push(r.durationMs);
    }

    for (let i = 0; i < warmup; i++) {
      await timedGet(client, `/api/collections/${name}/records/${ids[i % ids.length]}`);
    }
    for (let i = 0; i < iterations; i++) {
      const r = await timedGet(client, `/api/collections/${name}/records/${ids[i % ids.length]}`);
      if (r.status !== 200) throw new Error(`pb get returned ${r.status}`);
      getSamples.push(r.durationMs);
    }

    for (let i = 0; i < warmup; i++) {
      await timedPatch(client, `/api/collections/${name}/records/${ids[i % ids.length]}`, {
        count: i,
      });
    }
    for (let i = 0; i < iterations; i++) {
      const r = await timedPatch(
        client,
        `/api/collections/${name}/records/${ids[i % ids.length]}`,
        { count: i + 1000 },
      );
      if (r.status !== 200) throw new Error(`pb patch returned ${r.status}`);
      patchSamples.push(r.durationMs);
    }

    const deleteTargets = ids.slice(0, iterations);
    for (const id of deleteTargets) {
      const r = await timedDelete(client, `/api/collections/${name}/records/${id}`);
      if (r.status !== 204 && r.status !== 200) throw new Error(`pb delete returned ${r.status}`);
      deleteSamples.push(r.durationMs);
    }

    return {
      collection: name,
      iterations,
      create: summarize(createSamples),
      get: summarize(getSamples),
      patch: summarize(patchSamples),
      delete: summarize(deleteSamples),
    };
  } finally {
    await pbDeleteCollection(client, name).catch(() => undefined);
  }
}
