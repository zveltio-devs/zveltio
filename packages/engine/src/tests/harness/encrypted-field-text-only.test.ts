/**
 * A14 (2026-11-21): the engine seals only strings, so an `encrypted: true`
 * field whose column is not text (a number, a date, JSON) kept its value in
 * plaintext under a flag that said otherwise. Such a field is now refused,
 * when it is declared and when a retype would carry the flag onto one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { alterField } from '../../lib/data/field-changes.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = String(Date.now()).slice(-7);
const field = (name: string, type: string, encrypted = true) => ({
  name,
  type,
  required: false,
  unique: false,
  indexed: false,
  encrypted,
});

d('an encrypted field is a text field', () => {
  let db: Database;
  const made: string[] = [];
  const create = (name: string, fields: unknown[]) => {
    made.push(name);
    return DDLManager.createCollection(db, { name, fields } as never).then(
      () => null,
      (err: Error) => err.message,
    );
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    for (const c of made) await dropTestCollection(db, c).catch(() => {});
  });

  it('refuses encrypted on a column that is not text', async () => {
    for (const type of ['number', 'json', 'datetime']) {
      expect(await create(`encn_${type}_${STAMP}`, [field('v', type)])).toContain(
        'cannot be encrypted',
      );
    }
  });

  it('accepts encrypted on a text column', async () => {
    expect(await create(`enct_${STAMP}`, [field('v', 'text')])).toBeNull();
  });

  it('refuses a retype that would carry the flag onto a number', async () => {
    const name = `encr_${STAMP}`;
    expect(await create(name, [field('v', 'text')])).toBeNull();
    const status = await alterField(db, name, 'v', { newType: 'number' }).then(
      () => null,
      (err: { status?: number; message?: string }) => [err.status, err.message],
    );
    expect(status?.[0]).toBe(400);
    expect(String(status?.[1])).toContain('cannot be encrypted');
  });
});
