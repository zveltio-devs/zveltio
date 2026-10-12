// `zveltio schema pull` writes the paths the server names under `--dir` and
// nowhere else: a path that resolves outside it fails the pull before any
// file is written.
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { schemaPullCommand } from './schema.js';

describe('schema pull path containment', () => {
  let files: Record<string, string> = {};
  let server: ReturnType<typeof Bun.serve>;
  let base = '';

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'zv-pull-'));
    server = Bun.serve({ port: 0, fetch: () => Response.json({ files }) });
  });
  afterAll(() => {
    server.stop(true);
    rmSync(base, { recursive: true, force: true });
  });

  const pull = async (dir: string) => {
    const exit = spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const err = spyOn(console, 'error').mockImplementation(() => {});
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await schemaPullCommand({ dir, url: `http://localhost:${server.port}` });
      return 'ok';
    } catch (e) {
      return (e as Error).message;
    } finally {
      exit.mockRestore();
      err.mockRestore();
      log.mockRestore();
    }
  };

  it('writes the files under the directory', async () => {
    files = { 'roles.json': '{}', 'collections/a.json': '{"name":"a"}' };
    expect(await pull(join(base, 'ok'))).toBe('ok');
    expect(readFileSync(join(base, 'ok', 'collections', 'a.json'), 'utf8')).toBe('{"name":"a"}');
  });

  it('refuses a path outside it, and writes nothing', async () => {
    for (const escape of [
      '../outside.json',
      'collections/../../outside.json',
      join(base, 'abs.json'),
    ]) {
      files = { 'roles.json': '{}', [escape]: 'x' };
      expect(await pull(join(base, 'bad'))).toBe('exit 1');
      expect(existsSync(join(base, 'outside.json'))).toBe(false);
      expect(existsSync(join(base, 'abs.json'))).toBe(false);
      expect(existsSync(join(base, 'bad', 'roles.json'))).toBe(false);
    }
  });
});
