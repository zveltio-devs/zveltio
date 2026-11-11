/**
 * No webhook code path reads Valkey (ADR 0035, acceptance h).
 *
 * Delivery, retries and the dead-letter list are pg-boss's and the delivery
 * row's; a Valkey restart without persistence used to lose the queue, and its
 * payloads carried the decrypted signing secret. This keeps the cache out of
 * every webhook source file, and the deleted worker deleted.
 */

import { describe, expect, it } from 'bun:test';
import { Glob } from 'bun';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '../..');
const CACHE =
  /getCache|runtime\/cache|ioredis|valkey|\b(?:[lr]push|lmpop|lrange|lrem|zadd)\b|['"`]webhook:/i;

describe('webhooks do not use Valkey', () => {
  it('no webhook source file reaches the cache', async () => {
    const files = [...new Glob('**/*webhook*.ts').scanSync(SRC)].filter(
      (f) => !f.startsWith('tests/'),
    );
    expect(files.sort()).toEqual(['lib/webhooks.ts', 'routes/webhooks.ts']);
    for (const f of files) {
      const hits = (await Bun.file(join(SRC, f)).text())
        .split('\n')
        .filter((line) => CACHE.test(line));
      expect({ file: f, hits }).toEqual({ file: f, hits: [] });
    }
  });

  it('the Valkey webhook worker is gone', async () => {
    expect(await Bun.file(join(SRC, 'lib/webhook-worker.ts')).exists()).toBe(false);
  });
});
