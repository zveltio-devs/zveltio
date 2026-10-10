import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Fly.io, Railway and Render run one container built from the repository's
 * Dockerfile, and production loads third-party extensions only through the
 * extension runner (RFC extension-runner, step 9). The runner drops every
 * extension to a uid of its own, which needs root, so the image those platforms
 * build must start as root and start the runner beside the engine
 * (docker/zveltio-entrypoint.sh, proven in docker by
 * scripts/ext-runner-standalone.sh). The image the chart and the release
 * compose pull must keep its numeric non-root user.
 */

const ROOT = join(import.meta.dir, '../../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Each stage of the Dockerfile: its name and its USER / ENTRYPOINT lines. */
function stages(): Array<{ name: string; from: string; user?: string; entrypoint?: string }> {
  const out: Array<{ name: string; from: string; user?: string; entrypoint?: string }> = [];
  for (const line of read('Dockerfile').split('\n')) {
    const from = line.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
    if (from) out.push({ from: from[1]!, name: from[2] ?? '' });
    const cur = out.at(-1);
    const user = line.match(/^USER\s+(\S+)/);
    if (cur && user) cur.user = user[1];
    const ep = line.match(/^ENTRYPOINT\s+(.+)/);
    if (cur && ep) cur.entrypoint = ep[1];
  }
  return out;
}

describe('one-container image (Fly.io, Railway, Render, docker build .)', () => {
  it('the default target starts as root, on the production stage and its entrypoint', () => {
    const all = stages();
    const last = all.at(-1)!;
    const production = all.find((s) => s.name === 'production')!;
    expect(last.from).toBe('production');
    // A name: Fly.io's init resolves the user through /etc/passwd.
    expect(last.user).toBe('root');
    expect(production.entrypoint).toBe('["/usr/local/bin/zveltio-entrypoint"]');
    expect(read('Dockerfile')).toContain(
      'COPY docker/zveltio-entrypoint.sh /usr/local/bin/zveltio-entrypoint',
    );
  });

  it('the published image keeps the numeric non-root user the chart relies on', () => {
    expect(stages().find((s) => s.name === 'production')!.user).toBe('100:101');
    expect(read('.github/workflows/release.yml')).toMatch(
      /docker buildx build[\s\S]{0,200}--target production/,
    );
  });

  it('the entrypoint starts the runner only as root, for `start`, and drops the engine', () => {
    const sh = read('docker/zveltio-entrypoint.sh');
    expect(sh).toMatch(
      /\nif \[ "\$\(id -u\)" != 0 \] \|\| \[ "\$\{1:-start\}" != start \]; then exec "\$BIN" "\$@"; fi\n/,
    );
    expect(sh).toContain('--bounding-set=-all,+setuid,+setgid,+kill');
    expect(sh).toMatch(/env -i PATH="\$PATH" NODE_ENV=/);
    expect(sh).toMatch(/exec setpriv --reuid=100 --regid=101 [^\n]*--bounding-set=-all/);
  });

  it('each platform builds that default target and leaves its user and command alone', () => {
    const fly = read('fly.toml');
    expect(fly).toMatch(/\[build\]\s*\n(?:\s*#.*\n)*\s*dockerfile = "Dockerfile"/);
    expect(fly).not.toMatch(/build-target|\bcmd\b|entrypoint|\buser\b/);

    const railway = JSON.parse(read('railway.json'));
    expect(railway.build).toEqual({ builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' });
    // `bun dist/index.js` started nothing: the image has no such file.
    expect(railway.deploy.startCommand).toBeUndefined();

    const render = read('render.yaml');
    expect(render).toContain('dockerfilePath: ./Dockerfile');
    expect(render).not.toMatch(/dockerCommand|dockerTarget/);
  });
});
