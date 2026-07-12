/**
 * Unit coverage for cloud/document-indexer.ts — extracts text from uploaded
 * files and stores an embedding in zvd_ai_embeddings.
 *
 * Driven with CannedDb (records the embeddings upsert) + a fake `ai.providers`
 * in serviceRegistry (supplies embed()). No Postgres, no real AI provider.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import {
  extractTextFromFile,
  indexFileContent,
  scheduleFileIndexing,
} from '../../lib/cloud/document-indexer.js';
import { serviceRegistry } from '../../lib/service-registry.js';
import { CannedDb } from './fixtures/canned-db.js';

const EMBED_INSERT = /insert into zvd_ai_embeddings/i;

let embedCalls: string[];

/** Register a fake ai.providers whose default provider embeds deterministically. */
function registerFakeProvider(embedImpl?: (t: string) => Promise<unknown>): void {
  serviceRegistry.registerAs('test', 'ai.providers', {
    getDefault: () => ({
      embed:
        embedImpl ??
        (async (t: string) => {
          embedCalls.push(t);
          return { embedding: [0.1, 0.2, 0.3], model: 'fake-embed-1' };
        }),
    }),
  });
}

beforeEach(() => {
  embedCalls = [];
});
afterEach(() => {
  serviceRegistry.unregisterAs('test', 'ai.providers');
});

describe('extractTextFromFile', () => {
  it('decodes text/* as utf-8', async () => {
    expect(await extractTextFromFile(Buffer.from('hello'), 'text/plain')).toBe('hello');
    expect(await extractTextFromFile(Buffer.from('# md'), 'text/markdown')).toBe('# md');
  });

  it('decodes application/json and application/xml as utf-8', async () => {
    expect(await extractTextFromFile(Buffer.from('{"a":1}'), 'application/json')).toBe('{"a":1}');
    expect(await extractTextFromFile(Buffer.from('<x/>'), 'application/xml')).toBe('<x/>');
  });

  it('returns null for an unsupported binary type', async () => {
    expect(await extractTextFromFile(Buffer.from([0, 1, 2]), 'image/png')).toBeNull();
  });
});

describe('indexFileContent', () => {
  it('does nothing for blank content', async () => {
    const db = new CannedDb();
    db.when(EMBED_INSERT, []);
    registerFakeProvider();
    await indexFileContent(db.kysely as unknown as Database, 'f1', '   ');
    expect(embedCalls.length).toBe(0);
    expect(db.executed(EMBED_INSERT).length).toBe(0);
  });

  it('does nothing when no AI provider is registered', async () => {
    const db = new CannedDb();
    db.when(EMBED_INSERT, []);
    // no provider registered
    await indexFileContent(db.kysely as unknown as Database, 'f1', 'real content');
    expect(db.executed(EMBED_INSERT).length).toBe(0);
  });

  it('embeds the content and upserts into zvd_ai_embeddings', async () => {
    const db = new CannedDb();
    db.when(EMBED_INSERT, []);
    registerFakeProvider();

    await indexFileContent(db.kysely as unknown as Database, 'file-42', 'the quick brown fox');

    expect(embedCalls).toEqual(['the quick brown fox']);
    const inserts = db.executed(EMBED_INSERT);
    expect(inserts.length).toBe(1);
    expect(inserts[0].parameters).toContain('file-42');
  });

  it('swallows an embed() failure without throwing', async () => {
    const db = new CannedDb();
    db.when(EMBED_INSERT, []);
    registerFakeProvider(async () => {
      throw new Error('provider down');
    });
    await expect(
      indexFileContent(db.kysely as unknown as Database, 'f1', 'content'),
    ).resolves.toBeUndefined();
    expect(db.executed(EMBED_INSERT).length).toBe(0);
  });
});

describe('scheduleFileIndexing', () => {
  it('skips non-indexable mime types', async () => {
    const db = new CannedDb();
    db.when(EMBED_INSERT, []);
    registerFakeProvider();
    await scheduleFileIndexing(
      db.kysely as unknown as Database,
      'f1',
      Buffer.from([0, 1]),
      'image/png',
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(db.executed(EMBED_INSERT).length).toBe(0);
  });

  it('extracts + indexes an indexable text file', async () => {
    const db = new CannedDb();
    db.when(EMBED_INSERT, []);
    registerFakeProvider();
    await scheduleFileIndexing(
      db.kysely as unknown as Database,
      'file-7',
      Buffer.from('indexable body'),
      'text/plain',
    );
    // fire-and-forget chain — let it flush.
    await new Promise((r) => setTimeout(r, 30));
    expect(embedCalls).toEqual(['indexable body']);
    expect(db.executed(EMBED_INSERT).length).toBe(1);
  });

  it('logs schedule failures when text extraction rejects', async () => {
    const db = new CannedDb();
    db.when(EMBED_INSERT, []);
    registerFakeProvider();
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a.join(' '));
    const evilBuf = {
      toString() {
        throw new Error('decode failed');
      },
    } as unknown as Buffer;
    try {
      await scheduleFileIndexing(
        db.kysely as unknown as Database,
        'file-bad',
        evilBuf,
        'text/plain',
      );
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      console.error = orig;
    }
    expect(errors.join('\n')).toMatch(/File indexing schedule failed \[file-bad\]/);
    expect(db.executed(EMBED_INSERT).length).toBe(0);
  });
});
