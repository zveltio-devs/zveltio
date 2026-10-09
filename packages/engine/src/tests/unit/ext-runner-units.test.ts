// RFC extension-runner step 3b: one systemd instance per extension. The
// instance name must survive `RuntimeDirectory=zveltio-ext/%i` (an escaped
// name does not), stay unique per extension, and the files `setup` writes must
// be what the installer and the engine expect.
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeSharedDirs,
  runnerInstance,
  startRunner,
  stopRunner,
  runnerSetupFiles,
  runnerSocketPath,
  runnerUnit,
  setprivArgv,
  uidAllocator,
} from '../../lib/ext-runner.js';

describe('runnerInstance', () => {
  it('is [a-z0-9_] only, whatever the extension name', () => {
    for (const name of ['acme/my-ext.v2', 'Ünïcode ext', '../../etc', 'a'.repeat(300)]) {
      expect(runnerInstance(name)).toMatch(/^[a-z0-9_]{1,25}$/);
    }
  });

  it('keeps names that reduce to the same text apart', () => {
    expect(runnerInstance('acme/x')).not.toBe(runnerInstance('acme_x'));
    expect(runnerInstance('acme/x')).toBe(runnerInstance('acme/x'));
  });

  it('names the unit and the socket after the instance', () => {
    const i = runnerInstance('acme/x');
    expect(runnerUnit('acme/x')).toBe(`zveltio-ext-runner@${i}.service`);
    expect(runnerSocketPath('acme/x')).toBe(`/run/zveltio-ext/${i}/runner.sock`);
  });
});

describe('runnerSetupFiles', () => {
  const files = runnerSetupFiles({ engineUser: 'zveltio', engineUid: 997, dir: '/opt/zveltio' });
  const unit = files['/etc/systemd/system/zveltio-ext-runner@.service'];

  it('runs each instance under its own uid, closed to the network, with the engine uid it serves', () => {
    expect(unit).toContain('DynamicUser=yes');
    // One user name per instance: without it two instances shared one uid.
    expect(unit).toContain('User=zx_%i');
    expect(unit).toContain('IPAddressDeny=any');
    expect(unit).toContain('Environment=ZVELTIO_ENGINE_UID=997');
    expect(unit).toContain('BindReadOnlyPaths=/opt/zveltio/zveltio /opt/zveltio/extensions');
    // The socket the runner listens on is the one the engine connects to.
    expect(unit).toContain('Environment=ZVELTIO_EXT_RUNNER_SOCKET=/run/zveltio-ext/%i/runner.sock');
    expect(unit).toContain('RuntimeDirectory=zveltio-ext/%i');
  });

  it('switches the engine to the runner transport', () => {
    expect(files['/etc/systemd/system/zveltio.service.d/ext-runner.conf']).toContain(
      'Environment=ZVELTIO_EXT_TRANSPORT=runner',
    );
  });

  it('lets only the engine user manage only runner units', () => {
    const rule = files['/etc/polkit-1/rules.d/50-zveltio-ext-runner.rules'];
    expect(rule).toContain('subject.user === "zveltio"');
    expect(rule).toContain('unit.indexOf("zveltio-ext-runner@") === 0');
    expect(rule).not.toContain('"enable"');
  });
});

// RFC step 4: in containers there is no systemd. With the shared socket set on
// the engine, a systemctl call would fail every extension's enable.
describe('startRunner with a shared runner socket', () => {
  it('returns that socket and starts no unit', async () => {
    const before = process.env.ZVELTIO_EXT_RUNNER_SOCKET;
    const path = process.env.PATH;
    process.env.ZVELTIO_EXT_RUNNER_SOCKET = '/run/zveltio-ext/runner.sock';
    process.env.PATH = '/nonexistent'; // any systemctl spawn would throw
    try {
      expect(await startRunner('acme/x')).toBe('/run/zveltio-ext/runner.sock');
      await stopRunner('acme/x');
    } finally {
      process.env.PATH = path;
      if (before === undefined) delete process.env.ZVELTIO_EXT_RUNNER_SOCKET;
      else process.env.ZVELTIO_EXT_RUNNER_SOCKET = before;
    }
  });
});

// RFC step 4: the container runner's own pieces. The runner itself runs in
// docker (scripts/ext-runner-compose.sh); these are what it is made of.
describe('container runner', () => {
  it('gives every live process its own uid and reuses one only once released', () => {
    const next = uidAllocator(200000);
    const a = next();
    const b = next();
    expect([a.uid, b.uid]).toEqual([200000, 200001]);
    a.release();
    const seen = new Set<number>();
    for (let i = 0; i < 65535; i++) seen.add(next().uid);
    // b is still live: the wrap hands out 200000 again, never 200001.
    expect(seen.has(200001)).toBe(false);
    expect(seen.has(200000)).toBe(true);
  });

  it('drops through setpriv, never through spawn options', () => {
    expect(setprivArgv(200005, ['/bin/zveltio', 'rt.mjs'])).toEqual([
      'setpriv',
      '--reuid=200005',
      '--regid=200005',
      '--clear-groups',
      '--no-new-privs',
      '--',
      '/bin/zveltio',
      'rt.mjs',
    ]);
  });

  it('refuses a shared directory that is not root-owned at the mode it needs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zv-runner-dir-'));
    try {
      const refusal = closeSharedDirs([[dir, 0o1777]]);
      if (process.getuid?.() === 0) expect(refusal).toBeNull();
      else expect(refusal).toContain('must belong to root');
      // chmod(1) kept the sticky bit that Bun's chmodSync drops.
      expect(statSync(dir).mode & 0o7777).toBe(0o1777);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
