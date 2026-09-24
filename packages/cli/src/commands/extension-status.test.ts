import { expect, it } from 'bun:test';
import { join } from 'node:path';

// A registry that cannot be reached used to print "not found in the
// marketplace" and exit 0, which reads as a verdict about the extension.
it('fails when the registry cannot be reached, instead of reporting not found', () => {
  const cli = join(import.meta.dir, '..', 'index.ts');
  const r = Bun.spawnSync([
    'bun',
    cli,
    'extension',
    'status',
    'x',
    '--registry-url',
    'http://127.0.0.1:1',
  ]);
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain('Registry unreachable');
  expect(r.stdout.toString()).not.toContain('not found');
});
