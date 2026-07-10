/**
 * Direct executeStep coverage for lib/flows/flow-executor.ts — calls the step
 * runner without inserting into zv_flow_steps (the DB CHECK constraint omits
 * ai_decision even though the executor supports it).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { _internalForTests } from '../../lib/flows/flow-executor.js';
import { serviceRegistry } from '../../lib/service-registry.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const { executeStep } = _internalForTests;
const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `fex_${Date.now()}`;

// biome-ignore lint/suspicious/noExplicitAny: minimal step stub for executeStep
function step(type: string, config: Record<string, unknown>): any {
  return { id: type, name: type, type, config };
}

d('executeStep — flow-executor branches', () => {
  let db: Database;
  let godUserId: string;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    const row = await sql<{
      id: string;
    }>`SELECT id FROM "user" WHERE role = 'god' ORDER BY "createdAt" DESC LIMIT 1`.execute(db);
    godUserId = row.rows[0]!.id;

    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await sql
      .raw(
        `INSERT INTO "zvd_${COLLECTION}" (id, title, created_by, updated_by) VALUES ('${crypto.randomUUID()}', 'row1', '${godUserId}', '${godUserId}')`,
      )
      .execute(db)
      .catch(() => {});
  });

  afterAll(async () => {
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
    serviceRegistry.unregisterAs('test', 'ai.providers');
  });

  it('ai_decision falls back when the AI extension is inactive', async () => {
    const { output } = await executeStep(
      db,
      step('ai_decision', { prompt: 'Choose', options: ['yes', 'no'], fallback: 'no' }),
      {},
      {},
    );
    expect(output.usedFallback).toBe(true);
    expect(output.decision).toBe('no');
  });

  it('ai_decision matches a registered provider response', async () => {
    serviceRegistry.registerAs('test', 'ai.providers', {
      getDefault: () => ({
        chat: async () => ({ content: 'YES' }),
      }),
    });

    const { output } = await executeStep(
      db,
      step('ai_decision', { prompt: 'Pick', options: ['yes', 'no'], fallback: 'no' }),
      {},
      {},
    );
    expect(output.decision).toBe('yes');
    expect(output.matched).toBe(true);
  });

  it('export_collection rejects an invalid collection name', async () => {
    const { output } = await executeStep(
      db,
      step('export_collection', { collection: '../evil' }),
      {},
      {},
    );
    expect(String(output.error)).toContain('Invalid collection');
  });

  it('export_collection reads rows then reports export unavailable without the extension', async () => {
    const { output } = await executeStep(
      db,
      step('export_collection', { collection: COLLECTION, format: 'csv', limit: 10 }),
      {},
      {},
    );
    expect(output.exported).toBe(false);
  });

  it('query_db blocks dangerous SQL patterns', async () => {
    await expect(
      executeStep(db, step('query_db', { query: 'SELECT pg_sleep(1)' }), {}, {}),
    ).rejects.toThrow(/blocked|dangerous/i);
  });

  it('send_email rejects an invalid recipient', async () => {
    const { output } = await executeStep(
      db,
      step('send_email', { to: 'not-an-email', subject: 'x', body: 'y' }),
      {},
      {},
    );
    expect(output.sent).toBe(false);
  });

  it('send_notification reports missing targets', async () => {
    const { output } = await executeStep(
      db,
      step('send_notification', { title: 't', message: 'm' }),
      {},
      {},
    );
    expect(output.sent).toBe(false);
  });

  it('send_notification delivers to a explicit user_id', async () => {
    const { output } = await executeStep(
      db,
      step('send_notification', {
        user_id: godUserId,
        title: 'flow step',
        message: 'hello',
      }),
      {},
      {},
    );
    expect(output.sent).toBe(true);
  });

  it('webhook blocks internal URLs (SSRF)', async () => {
    await expect(
      executeStep(
        db,
        step('webhook', { url: 'http://127.0.0.1/hook', method: 'POST', body: {} }),
        {},
        {},
      ),
    ).rejects.toThrow(/blocked|sandbox/i);
  });

  it('webhook reaches a public URL', async () => {
    const { output } = await executeStep(
      db,
      step('webhook', {
        url: 'https://example.com/',
        method: 'GET',
        timeout_ms: 5000,
      }),
      {},
      {},
    );
    expect(output.ok).toBe(true);
  }, 15_000);
});
