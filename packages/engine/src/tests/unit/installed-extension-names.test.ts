import { describe, expect, test } from 'bun:test';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { installedExtensionNames } from '../../lib/extensions/ext-db-role.js';
import type { Database } from '../../db/index.js';

// A driver whose every statement fails, as a registry read refused (42501) or
// lost to a dropped connection would.
class FailingDriver extends DummyDriver {
  override async acquireConnection() {
    return {
      executeQuery: () => Promise.reject(new Error('permission denied for zv_extension_registry')),
      // eslint-disable-next-line require-yield
      async *streamQuery() {
        throw new Error('unused');
      },
    };
  }
}

const db = new Kysely<unknown>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new FailingDriver(),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
}) as unknown as Database;

describe('installedExtensionNames', () => {
  // An empty list here made every other extension's prefix unknown, so
  // ctx.config.vars handed one extension keys another's prefix also spells.
  test('a registry read error propagates instead of reading as no extensions', async () => {
    await expect(installedExtensionNames(db)).rejects.toThrow('permission denied');
  });
});
