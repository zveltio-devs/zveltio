/**
 * document-indexer.ts — text/html and text/csv schedule paths.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { scheduleFileIndexing } from '../../lib/cloud/document-indexer.js';
import { serviceRegistry } from '../../lib/service-registry.js';
import { CannedDb } from './fixtures/canned-db.js';

const EMBED_INSERT = /insert into zvd_ai_embeddings/i;

let embedCalls: string[];

beforeEach(() => {
  embedCalls = [];
  serviceRegistry.registerAs('test', 'ai.providers', {
    getDefault: () => ({
      embed: async (t: string) => {
        embedCalls.push(t);
        return { embedding: [0.1], model: 'fake' };
      },
    }),
  });
});

afterEach(() => {
  serviceRegistry.unregisterAs('test', 'ai.providers');
});

describe('scheduleFileIndexing — additional indexable mimes', () => {
  it('indexes text/html uploads', async () => {
    const db = new CannedDb();
    db.when(EMBED_INSERT, []);
    await scheduleFileIndexing(
      db.kysely as unknown as Database,
      'html-1',
      Buffer.from('<p>hello</p>'),
      'text/html',
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(embedCalls).toEqual(['<p>hello</p>']);
    expect(db.executed(EMBED_INSERT).length).toBe(1);
  });

  it('indexes text/csv uploads', async () => {
    const db = new CannedDb();
    db.when(EMBED_INSERT, []);
    await scheduleFileIndexing(
      db.kysely as unknown as Database,
      'csv-1',
      Buffer.from('a,b\n1,2'),
      'text/csv',
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(embedCalls).toEqual(['a,b\n1,2']);
    expect(db.executed(EMBED_INSERT).length).toBe(1);
  });
});
