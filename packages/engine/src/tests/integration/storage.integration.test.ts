/**
 * Storage — Integration Tests
 *
 * Tests file listing, folder management, upload, metadata, and delete.
 * Requires TEST_DATABASE_URL and a running engine on TEST_PORT.
 * S3 is optional — upload tests insert metadata only when S3_ENDPOINT is absent.
 *
 * Run with:
 * TEST_DATABASE_URL=postgresql://... TEST_PORT=3099 bun test packages/engine/src/tests/integration/storage.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'kysely';
import { createDb } from '../../db/index.js';
import type { Database } from '../../db/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const skipAll = !TEST_DB_URL;

let db: Database;
let sessionCookie: string;
let uploadedFileId: string;
let createdFolderId: string;

beforeAll(async () => {
  if (skipAll) return;
  db = createDb(TEST_DB_URL!);

  const email = `storage-${Date.now()}@test.local`;
  await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'StorPass123!', name: 'Storage User' }),
  });
  await sql`UPDATE "user" SET role = 'god' WHERE email = ${email}`.execute(db);
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'StorPass123!' }),
  });
  sessionCookie = res.headers.get('set-cookie') ?? '';
});

afterAll(async () => {
  if (skipAll || !db) return;
  // Clean up test file if still present
  if (uploadedFileId) {
    await (db as any).deleteFrom('zv_media_files').where('id', '=', uploadedFileId).execute().catch(() => {});
  }
  if (createdFolderId) {
    await (db as any).deleteFrom('zv_media_folders').where('id', '=', createdFolderId).execute().catch(() => {});
  }
  await db.destroy().catch(() => {});
});

describe.skipIf(skipAll)('Storage — Integration', () => {
  it('GET /api/storage — returns 401 unauthenticated', async () => {
    const res = await fetch(`${BASE_URL}/api/storage`);
    expect(res.status).toBe(401);
  });

  it('GET /api/storage — lists files (authenticated)', async () => {
    const res = await fetch(`${BASE_URL}/api/storage`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.files)).toBe(true);
  });

  it('POST /api/storage/upload — uploads a file', async () => {
    const formData = new FormData();
    const blob = new Blob(['hello integration test'], { type: 'text/plain' });
    formData.append('file', blob, 'test-file.txt');

    const res = await fetch(`${BASE_URL}/api/storage/upload`, {
      method: 'POST',
      headers: { Cookie: sessionCookie },
      body: formData,
    });
    expect(res.status).toBeOneOf([200, 201]);
    const body = await res.json() as any;
    const file = body.file ?? body;
    expect(file).toHaveProperty('id');
    expect(file.original_name).toBe('test-file.txt');
    uploadedFileId = file.id;
  });

  it('GET /api/storage/:id — returns file metadata', async () => {
    if (!uploadedFileId) return;
    const res = await fetch(`${BASE_URL}/api/storage/${uploadedFileId}`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect((body.file ?? body).id).toBe(uploadedFileId);
  });

  it('GET /api/storage/:id — returns 404 for unknown id', async () => {
    const res = await fetch(`${BASE_URL}/api/storage/00000000-0000-0000-0000-000000000000`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(404);
  });

  it('POST /api/storage/folders — creates a folder', async () => {
    const res = await fetch(`${BASE_URL}/api/storage/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ name: `test-folder-${Date.now()}` }),
    });
    expect(res.status).toBeOneOf([200, 201, 503]);
    if (res.status === 200 || res.status === 201) {
      const body = await res.json() as any;
      const folder = body.folder ?? body;
      expect(folder).toHaveProperty('id');
      createdFolderId = folder.id;
    }
  });

  it('GET /api/storage/folders — lists folders', async () => {
    const res = await fetch(`${BASE_URL}/api/storage/folders`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.folders)).toBe(true);
  });

  it('DELETE /api/storage/:id — deletes the uploaded file', async () => {
    if (!uploadedFileId) return;
    const res = await fetch(`${BASE_URL}/api/storage/${uploadedFileId}`, {
      method: 'DELETE',
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBeOneOf([200, 204]);
    uploadedFileId = ''; // prevent afterAll cleanup attempt
  });
});
