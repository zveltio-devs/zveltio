import { expect, it } from 'bun:test';
import { join } from 'node:path';

// commander 12 accepts undeclared positionals by default, so
// `zveltio extension validate ../other` validated the cwd and reported on the
// wrong tree. The `extension` subcommands take their directory as `--dir`.
it('rejects a positional argument the command does not declare', () => {
  const r = Bun.spawnSync(['bun', join(import.meta.dir, 'index.ts'), 'extension', 'validate', 'x']);
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain('too many arguments');
});
