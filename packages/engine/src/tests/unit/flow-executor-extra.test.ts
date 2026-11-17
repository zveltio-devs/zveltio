/**
 * Direct executeStep coverage for lib/flows/flow-executor.ts — calls the step
 * runner without inserting into zv_flow_steps.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _internalForTests } from '../../lib/flows/flow-executor.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const { executeStep } = _internalForTests;
const d = harnessAvailable() ? describe : describe.skip;

function step(type: string, config: Record<string, unknown>): any {
  return { id: type, name: type, type, config };
}

d('executeStep — flow-executor branches', () => {
  let db: Database;
  let godUserId: string;

  beforeAll(async () => {
    const { app, db: database } = await getTestApp();
    db = database;

    // This read whatever god user happened to already be in the table and indexed
    // `[0]!` into the result. On a database that has only just been migrated there
    // is none, so the file threw in `beforeAll` and every test in it failed — but
    // only when it ran first. In a full-suite run some earlier file had made one,
    // so the dependency was invisible and the order was load bearing.
    //
    // It makes its own now, through the same helper every other harness test uses.
    const row = await sql<{
      id: string;
    }>`SELECT id FROM "user" WHERE role = 'god' ORDER BY "createdAt" DESC LIMIT 1`.execute(db);
    if (row.rows[0]) {
      godUserId = row.rows[0].id;
    } else {
      await createGodSession(app, db);
      const made = await sql<{
        id: string;
      }>`SELECT id FROM "user" WHERE role = 'god' ORDER BY "createdAt" DESC LIMIT 1`.execute(db);
      godUserId = made.rows[0]!.id;
    }
  });

  it('export_collection fails the step on an invalid collection name', async () => {
    await expect(
      executeStep(db, step('export_collection', { collection: '../evil' }), {}, {}),
    ).rejects.toThrow(/invalid collection name/);
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

  it('run_script evaluates sandboxed code with input', async () => {
    const { output } = await executeStep(
      db,
      step('run_script', {
        code: 'return { sum: (input.a ?? 0) + (input.b ?? 0) };',
        input: { a: 10, b: 32 },
      }),
      {},
      {},
    );
    expect(output.sum).toBe(42);
  });

  it('run_script throws when the script fails', async () => {
    await expect(
      executeStep(db, step('run_script', { code: 'throw new Error("boom");' }), {}, {}),
    ).rejects.toThrow(/Script error|boom/i);
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
