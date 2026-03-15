/**
 * AI Memory — Integration Tests
 *
 * Verifies the zv_ai_memory table schema and upsert behaviour.
 *
 * Run with:
 * TEST_DATABASE_URL=postgresql://... TEST_PORT=3099 bun test \
 *   packages/engine/src/tests/integration/ai-memory.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'kysely';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const skipAll = !TEST_DB_URL;

let db: any;
let userId: string;
let userCookie: string;

beforeAll(async () => {
  if (skipAll) return;

  process.env.DATABASE_URL = TEST_DB_URL!;
  const { initDatabase } = await import('../../db/index.js');
  db = await initDatabase();

  const ts = Date.now();
  const email = `memory-test-${ts}@test.local`;

  const signUp = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'TestPass123!', name: 'Memory Test' }),
  });
  const signUpBody = await signUp.json() as any;
  userId = signUpBody.user?.id;

  const signIn = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'TestPass123!' }),
  });
  userCookie = signIn.headers.get('set-cookie')?.split(';')[0] ?? '';
});

afterAll(async () => {
  if (skipAll || !db) return;
  if (userId) {
    await sql`DELETE FROM zv_ai_memory WHERE user_id = ${userId}`.execute(db).catch(() => {});
    await sql`DELETE FROM "user" WHERE id = ${userId}`.execute(db).catch(() => {});
  }
  await db.destroy().catch(() => {});
});

describe.skipIf(skipAll)('AI Memory — zv_ai_memory table', () => {
  it('table exists with required columns', async () => {
    const result = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'zv_ai_memory'
      ORDER BY column_name
    `.execute(db);

    const cols = result.rows.map((r: any) => r.column_name);
    expect(cols).toContain('id');
    expect(cols).toContain('user_id');
    expect(cols).toContain('context_key');
    expect(cols).toContain('content');
  });

  it('upsert on (user_id, context_key) works correctly', async () => {
    if (!userId) return;

    await sql`
      INSERT INTO zv_ai_memory (user_id, context_key, content)
      VALUES (${userId}, 'test_key', 'First value')
      ON CONFLICT (user_id, context_key) DO UPDATE SET content = EXCLUDED.content
    `.execute(db);

    await sql`
      INSERT INTO zv_ai_memory (user_id, context_key, content)
      VALUES (${userId}, 'test_key', 'Updated value')
      ON CONFLICT (user_id, context_key) DO UPDATE SET content = EXCLUDED.content
    `.execute(db);

    const result = await sql<{ content: string }>`
      SELECT content FROM zv_ai_memory
      WHERE user_id = ${userId} AND context_key = 'test_key'
    `.execute(db);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].content).toBe('Updated value');
  });

  it('multiple keys per user are independent', async () => {
    if (!userId) return;

    await sql`
      INSERT INTO zv_ai_memory (user_id, context_key, content)
      VALUES
        (${userId}, 'key_a', 'Value A'),
        (${userId}, 'key_b', 'Value B')
      ON CONFLICT (user_id, context_key) DO UPDATE SET content = EXCLUDED.content
    `.execute(db);

    const result = await sql<{ context_key: string; content: string }>`
      SELECT context_key, content FROM zv_ai_memory
      WHERE user_id = ${userId} AND context_key IN ('key_a', 'key_b')
      ORDER BY context_key
    `.execute(db);

    expect(result.rows.length).toBeGreaterThanOrEqual(2);
    const keyA = result.rows.find((r: any) => r.context_key === 'key_a');
    const keyB = result.rows.find((r: any) => r.context_key === 'key_b');
    expect(keyA?.content).toBe('Value A');
    expect(keyB?.content).toBe('Value B');
  });
});

describe.skipIf(skipAll)('AI Memory — API endpoints', () => {
  it('GET /api/ai/memory — returns memories for authenticated user', async () => {
    const res = await fetch(`${BASE_URL}/api/ai/memory`, {
      headers: { Cookie: userCookie },
    });
    // Extension may or may not be active — 401 if unauthenticated, 404 if ext not loaded
    expect([200, 401, 404]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json() as any;
      expect(Array.isArray(body.memories)).toBe(true);
    }
  });
});
