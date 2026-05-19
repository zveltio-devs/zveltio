/**
 * Setup helpers: create a fresh collection + bootstrap user so benchmarks
 * run against a known, isolated schema. Every benchmark gets its own
 * randomly-named collection so concurrent runs don't collide and runs
 * are reproducible (drop the collection at teardown).
 */

import type { BenchHttpClient } from './http.js';

export interface BenchCollection {
  /** Generated collection name like `bench_users_8f3a` */
  name: string;
}

export interface CollectionField {
  name: string;
  type: string;
  required?: boolean;
}

/**
 * Create a collection synchronously from the bench point of view: POST + poll
 * the DDL job until it's done. POST returns 202 + job_id; we wait so the
 * table actually exists when the benchmark starts hammering it.
 */
export async function createCollection(
  client: BenchHttpClient,
  name: string,
  fields: CollectionField[],
): Promise<BenchCollection> {
  const res = await fetch(`${client.baseUrl}/api/collections`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(client.authToken ? { Authorization: `Bearer ${client.authToken}` } : {}),
    },
    body: JSON.stringify({ name, fields }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`createCollection ${name} failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const data = await res.json() as { job_id?: string };
  if (data.job_id) await waitForJob(client, data.job_id);
  return { name };
}

async function waitForJob(client: BenchHttpClient, jobId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const res = await fetch(`${client.baseUrl}/api/collections/jobs/${jobId}`, {
      headers: client.authToken ? { Authorization: `Bearer ${client.authToken}` } : {},
    });
    if (res.ok) {
      const j = await res.json() as { state?: string };
      if (j.state === 'completed') return;
      if (j.state === 'failed') throw new Error(`DDL job ${jobId} failed`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`DDL job ${jobId} did not complete within ${timeoutMs}ms`);
}

export async function dropCollection(client: BenchHttpClient, name: string): Promise<void> {
  const res = await fetch(`${client.baseUrl}/api/collections/${name}`, {
    method: 'DELETE',
    headers: client.authToken ? { Authorization: `Bearer ${client.authToken}` } : {},
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`dropCollection ${name} failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

/** 4-char hex suffix so concurrent bench runs don't share collection names. */
export function randomSuffix(): string {
  return Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
}
