/**
 * Setup helpers: create a fresh collection + bootstrap user so benchmarks
 * run against a known, isolated schema. Every benchmark gets its own
 * randomly-named collection so concurrent runs don't collide and runs
 * are reproducible (drop the collection at teardown).
 */

import type { BenchHttpClient } from './http.js';

// Mirror the auth-header helper from http.ts so setup.ts uses the same
// rule (cookie vs zvk_ Bearer) without importing private internals.
function authHeader(client: BenchHttpClient): Record<string, string> {
  if (!client.authToken) return {};
  if (client.authToken.startsWith('zvk_')) {
    return { Authorization: `Bearer ${client.authToken}` };
  }
  return { Cookie: client.authToken };
}

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
      ...authHeader(client),
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
  // Route shape: GET /api/collections/jobs/:id returns `{ job: { status, ... } }`
  // where status ∈ pending | running | completed | failed (see
  // mapJobToPublic in packages/engine/src/lib/ddl-queue.ts).
  const deadline = performance.now() + timeoutMs;
  let lastStatus = '';
  while (performance.now() < deadline) {
    const res = await fetch(`${client.baseUrl}/api/collections/jobs/${jobId}`, {
      headers: authHeader(client),
    });
    if (res.ok) {
      const j = await res.json() as { job?: { status?: string; error?: string } };
      const status = j.job?.status;
      if (status) lastStatus = status;
      if (status === 'completed') return;
      if (status === 'failed') {
        throw new Error(`DDL job ${jobId} failed: ${j.job?.error ?? 'unknown'}`);
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`DDL job ${jobId} did not complete within ${timeoutMs}ms (last status: ${lastStatus || 'unknown'})`);
}

export async function dropCollection(client: BenchHttpClient, name: string): Promise<void> {
  const res = await fetch(`${client.baseUrl}/api/collections/${name}`, {
    method: 'DELETE',
    headers: authHeader(client),
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
