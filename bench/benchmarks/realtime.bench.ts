/**
 * Realtime WebSocket subscription latency benchmark.
 *
 * Method: open one WS subscriber to `/api/ws`, subscribe to a collection,
 * then perform N inserts via the REST API on the same collection. For each
 * insert we measure the wall-clock delta between "REST request started" and
 * "WS message arrived for that record id".
 *
 * Caveat: the WS endpoint authenticates via the session cookie, not a Bearer
 * header (see packages/engine/src/routes/ws.ts:53). We sign in once and
 * forward the `Cookie` header from the sign-in response so the upgrade is
 * accepted. If the bench is run against a build that requires Bearer-only
 * auth, this benchmark will be skipped via the auth-check at the top.
 */

import { timedPost } from '../lib/http.js';
import type { BenchHttpClient } from '../lib/http.js';
import { summarize, type SampleStats } from '../lib/stats.js';
import { createCollection, dropCollection, randomSuffix } from '../lib/setup.js';

export interface RealtimeResult {
  collection: string;
  iterations: number;
  /** End-to-end latency: REST POST start → WS message received. */
  fanout: SampleStats;
  /** Sub-measurement: time from POST returning 201 → WS message received. */
  postToWs: SampleStats;
  skipped?: string;
}

interface RunOptions {
  client: BenchHttpClient;
  /** Session cookie value, e.g. `better-auth.session_token=...`. */
  sessionCookie?: string;
  warmup: number;
  iterations: number;
}

export async function runRealtime(opts: RunOptions): Promise<RealtimeResult> {
  const { client, warmup, iterations, sessionCookie } = opts;
  const name = `bench_rt_${randomSuffix()}`;

  if (!sessionCookie) {
    return {
      collection: name,
      iterations: 0,
      fanout: summarize([]),
      postToWs: summarize([]),
      skipped: 'no session cookie — realtime benchmark requires cookie auth',
    };
  }

  await createCollection(client, name, [{ name: 'title', type: 'text', required: true }]);

  try {
    const wsUrl = client.baseUrl.replace(/^http/, 'ws') + '/api/ws';
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const ws = new WebSocket(wsUrl, { headers: { Cookie: sessionCookie } } as any);

    const pendingByTitle = new Map<string, (msUntilDelivery: number) => void>();
    const wsReady = new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (e) =>
        reject(
          new Error(
            `ws error: ${
              // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
              (e as any).message ?? 'unknown'
            }`,
          ),
        ),
      );
    });
    await wsReady;

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String((ev as MessageEvent).data));
        // Match by record title — every insert uses a unique title we control.
        const title = msg?.data?.title ?? msg?.record?.title ?? msg?.payload?.title;
        if (typeof title === 'string') {
          const cb = pendingByTitle.get(title);
          if (cb) {
            pendingByTitle.delete(title);
            cb(performance.now());
          }
        }
      } catch {
        /* ignore non-JSON / unexpected message shapes */
      }
    });

    ws.send(JSON.stringify({ type: 'subscribe', collections: [name] }));
    // Small grace so the engine's subscription index is updated before we insert.
    await new Promise((r) => setTimeout(r, 50));

    async function timedInsertWaitForWs(title: string): Promise<{ e2e: number; postToWs: number }> {
      const tStart = performance.now();
      const arrival = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`WS event for "${title}" not received in 5s`)),
          5000,
        );
        pendingByTitle.set(title, (tArrived) => {
          clearTimeout(timeout);
          resolve(tArrived);
        });
      });
      const post = await timedPost(client, `/api/data/${name}`, { title });
      if (post.status !== 201) throw new Error(`insert returned ${post.status}`);
      const tPostDone = performance.now();
      const tArrived = await arrival;
      return { e2e: tArrived - tStart, postToWs: tArrived - tPostDone };
    }

    // Warmup
    for (let i = 0; i < warmup; i++) {
      await timedInsertWaitForWs(`warmup-${i}-${randomSuffix()}`);
    }

    const e2e: number[] = [];
    const postToWs: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const m = await timedInsertWaitForWs(`row-${i}-${randomSuffix()}`);
      e2e.push(m.e2e);
      postToWs.push(m.postToWs);
    }

    try {
      ws.close();
    } catch {
      /* ignore */
    }

    return {
      collection: name,
      iterations,
      fanout: summarize(e2e),
      postToWs: summarize(postToWs),
    };
  } finally {
    await dropCollection(client, name).catch(() => undefined);
  }
}
