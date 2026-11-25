// RFC extension-runner step 3b: one systemd instance per extension. The
// instance name must survive `RuntimeDirectory=zveltio-ext/%i` (an escaped
// name does not), stay unique per extension, and the files `setup` writes must
// be what the installer and the engine expect.
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkUidRange,
  closeExtensionsDir,
  extensionsBaseOf,
  missingCapabilities,
  closeSharedDirs,
  notifyReady,
  limitArgv,
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
    // The binary and the Deno only: no extension's files (ADR 0062, F15).
    expect(unit).toContain(
      'BindReadOnlyPaths=/opt/zveltio/zveltio -/opt/zveltio/extensions/.deno\n',
    );
    // The socket the runner listens on is the one the engine connects to.
    expect(unit).toContain('Environment=ZVELTIO_EXT_RUNNER_SOCKET=/run/zveltio-ext/%i/runner.sock');
    expect(unit).toContain('RuntimeDirectory=zveltio-ext/%i');
  });

  // ADR 0062 step 2b: `systemctl start` returns once the runner listens
  // (notifyReady), not before; only the runner itself may say it is ready.
  it('is Type=notify, from the main process only, failing a start past 10 s', () => {
    expect(unit).toContain('\nType=notify\nNotifyAccess=main\nTimeoutStartSec=10\n');
  });

  // ADR 0023: seccomp, which holds where IPAddressDeny's cgroup BPF is a no-op.
  // The runner and everything it starts inherit it; AF_UNIX is its own socket.
  it('bans every socket family but AF_UNIX, foreign ABIs and io_uring', () => {
    expect(unit).toContain('\nRestrictAddressFamilies=AF_UNIX\n');
    expect(unit).toContain('\nSystemCallArchitectures=native\n');
    expect(unit).toContain('\nSystemCallFilter=~io_uring_setup io_uring_enter io_uring_register\n');
    expect(unit).toContain('\nSystemCallErrorNumber=EPERM\n');
  });

  // ADR 0023 decision 1: AF_UNIX stays open on bare metal, so PrivateNetwork
  // (abstract sockets) and InaccessiblePaths (the host's path sockets) are its
  // only barrier; the rest hides the engine's files and caps the instance. Each
  // line pinned: dropping one leaves ext-runner-systemd.sh's inet probe green.
  it('keeps every hardening directive, and the edge drop-in resets none', () => {
    for (const line of [
      'TemporaryFileSystem=/opt/zveltio:ro',
      'NoNewPrivileges=yes',
      'ProtectSystem=strict',
      'ProtectHome=yes',
      'PrivateTmp=yes',
      'PrivateDevices=yes',
      'ProtectProc=invisible',
      'ProtectKernelTunables=yes',
      'ProtectKernelModules=yes',
      'ProtectControlGroups=yes',
      'RestrictSUIDSGID=yes',
      'PrivateNetwork=yes',
      'InaccessiblePaths=-/run/dbus -/run/postgresql -/var/run/postgresql -/run/systemd/private',
      'MemoryMax=1G',
      'MemorySwapMax=0',
      'TasksMax=64',
      'CPUWeight=10',
      'CPUQuota=20%',
    ]) {
      expect(unit).toContain(`\n${line}\n`);
    }
    const edge = files['/etc/systemd/system/zveltio-ext-runner@edge.service.d/edge.conf']!;
    const keys = edge
      .split('\n')
      .filter((l) => /^\w+=/.test(l))
      .map((l) => l.split('=')[0]);
    expect([...new Set(keys)].sort()).toEqual([
      'AmbientCapabilities',
      'CPUQuota',
      'CapabilityBoundingSet',
      'DynamicUser',
      'Environment',
      'TasksMax',
      'User',
    ]);
  });

  it('runs each edge invocation under its own uid: root with three capabilities, range 400000 up', () => {
    const edge = files['/etc/systemd/system/zveltio-ext-runner@edge.service.d/edge.conf']!;
    expect(edge).toMatch(/^DynamicUser=no$/m);
    expect(edge).toMatch(/^User=root$/m);
    expect(edge).toMatch(/^CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_KILL$/m);
    expect(edge).toMatch(/^AmbientCapabilities=CAP_SETUID CAP_SETGID CAP_KILL$/m);
    expect(edge).toMatch(/^Environment=ZVELTIO_EXT_RUNNER_UID_BASE=400000$/m);
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
    // ADR 0062 step 2b: the start burst is a runtime property the engine sets.
    expect(rule).toContain('verb === "set-property"');
  });
});

// ADR 0062 step 2b: the runner tells systemd it listens. A datagram socket
// bound here stands in for systemd's NOTIFY_SOCKET.
describe('notifyReady', () => {
  async function dgram(addr: Buffer) {
    const { dlopen, FFIType: T, ptr } = await import('bun:ffi');
    const libc = dlopen('libc.so.6', {
      socket: { args: [T.i32, T.i32, T.i32], returns: T.i32 },
      bind: { args: [T.i32, T.ptr, T.u32], returns: T.i32 },
      recv: { args: [T.i32, T.ptr, T.u64, T.i32], returns: T.i64 },
      close: { args: [T.i32], returns: T.i32 },
    });
    const c = libc.symbols;
    const fd = c.socket(1, 2, 0); // AF_UNIX, SOCK_DGRAM
    const sa = Buffer.alloc(2 + addr.length);
    sa.writeUInt16LE(1, 0);
    addr.copy(sa, 2);
    expect(c.bind(fd, ptr(sa), sa.length)).toBe(0);
    return {
      next(): string {
        const buf = Buffer.alloc(64);
        const n = Number(c.recv(fd, ptr(buf), buf.length, 0x40)); // MSG_DONTWAIT
        return n < 0 ? '' : buf.subarray(0, n).toString();
      },
      close() {
        c.close(fd);
        libc.close();
      },
    };
  }

  it('sends READY=1 to a path socket and to an abstract one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notify-'));
    const path = join(dir, 'n.sock');
    const onPath = await dgram(Buffer.from(`${path}\0`));
    const abstract = `zveltio-notify-${process.pid}`;
    const onAbstract = await dgram(Buffer.from(`\0${abstract}`));
    try {
      await notifyReady(path);
      await notifyReady(`@${abstract}`);
      expect(onPath.next()).toBe('READY=1');
      expect(onAbstract.next()).toBe('READY=1');
    } finally {
      onPath.close();
      onAbstract.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says nothing without NOTIFY_SOCKET, and throws when nothing listens', async () => {
    await notifyReady('');
    await expect(notifyReady(join(tmpdir(), `absent-${process.pid}.sock`))).rejects.toThrow(
      'could not tell systemd',
    );
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

  // One container has no cgroup per extension: the limits are rlimits, set as
  // root before the drop so the extension's uid cannot raise them.
  it('caps tasks and address space before the drop, through prlimit', () => {
    const argv = limitArgv(setprivArgv(200005, ['/bin/zveltio', 'rt.mjs']));
    expect(argv.slice(0, 9)).toEqual([
      'prlimit',
      '--nproc=64',
      '--as=1073741824',
      '--nice=0',
      '--',
      'nice',
      '-n',
      '10',
      'setpriv',
    ]);
    expect(argv.at(-1)).toBe('rt.mjs');
  });

  // ADR 0062 F20: no cgroup per process in a container, so a lower priority,
  // set as root before the drop and kept there by RLIMIT_NICE 0.
  it('lowers the CPU priority of a container-mode process, out of its reach', async () => {
    const argv = limitArgv([
      'sh',
      '-c',
      'cat /proc/self/stat; renice -n 0 $$ >/dev/null 2>&1; echo r=$?',
    ]).filter((a) => !a.startsWith('--nproc')); // this uid runs more than 64 tasks
    const out = Bun.spawnSync(argv).stdout.toString();
    // Field 19 of /proc/<pid>/stat, after the parenthesised name.
    expect(out.split(') ')[1]!.split(' ')[16]).toBe('10');
    // Only an unprivileged uid is refused; root (this test, maybe) is not.
    if (process.getuid?.() !== 0) expect(out).toContain('r=1');
  });

  // A runner that cannot switch uids, or whose range runs past the ids a user
  // namespace maps, must refuse to start, not fail every extension later.
  it('checks both ends of the uid range it hands out', () => {
    const asked: number[] = [];
    const ok = checkUidRange(200000, (argv) => {
      const uid = Number(argv[1]!.split('=')[1]);
      asked.push(uid);
      expect(argv.slice(-2)).toEqual(['id', '-u']);
      return { exitCode: 0, stdout: Buffer.from(`${uid}\n`) };
    });
    expect(ok).toBeNull();
    expect(asked).toEqual([200000, 265535]);
  });

  it('refuses a range whose top is not usable, or a drop that did not happen', () => {
    const unmapped = checkUidRange(200000, (argv) =>
      argv[1] === '--reuid=265535'
        ? {
            exitCode: 1,
            stdout: Buffer.from(''),
            stderr: Buffer.from('setresuid failed: Invalid argument'),
          }
        : { exitCode: 0, stdout: Buffer.from(argv[1]!.split('=')[1]!) },
    );
    expect(unmapped).toContain('uid 265535 (setresuid failed: Invalid argument)');
    const ignored = checkUidRange(200000, () => ({ exitCode: 0, stdout: Buffer.from('0') }));
    expect(ignored).toContain('uid 200000 (it ran as 0)');
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

describe('missingCapabilities (container mode)', () => {
  const status = (eff: string) => `Name:\tbun\nCapInh:\t0000000000000000\nCapEff:\t${eff}\n`;

  it('passes the set the chart and compose add: KILL, SETGID, SETUID', () => {
    expect(missingCapabilities(status('00000000000000e0'))).toBeNull();
    expect(missingCapabilities(status('000001ffffffffff'))).toBeNull();
  });

  it('names each one missing', () => {
    expect(missingCapabilities(status('0000000000000020'))).toContain('CAP_SETGID, CAP_SETUID');
    expect(missingCapabilities(status('0000000000000000'))).toContain(
      'CAP_KILL, CAP_SETGID, CAP_SETUID',
    );
  });

  it('leaves the decision to checkUidRange where /proc says nothing', () => {
    expect(missingCapabilities('')).toBeNull();
  });
});

// ADR 0062 probe "security", F15: on the runner every extension ran beside a
// 0755 extensions directory and read every other's files. The engine closes it
// before each spawn: others keep only the way to the Deno.
describe('closeExtensionsDir', () => {
  it('leaves others the search bit on the base and .deno, nothing else', () => {
    const base = mkdtempSync(join(tmpdir(), 'zv-extdir-'));
    try {
      mkdirSync(join(base, 'finance', 'invoicing', 'engine'), { recursive: true, mode: 0o755 });
      writeFileSync(join(base, 'finance', 'invoicing', 'engine', 'index.js'), 'x', { mode: 0o644 });
      mkdirSync(join(base, 'crm'), { mode: 0o755 });
      mkdirSync(join(base, '.deno', '2.9.8'), { recursive: true, mode: 0o755 });
      writeFileSync(join(base, 'package.json'), '{}', { mode: 0o644 });
      symlinkSync(join(base, 'crm'), join(base, 'link'));
      closeExtensionsDir(base);
      const mode = (p: string) => statSync(join(base, p)).mode & 0o7777;
      expect(mode('.')).toBe(0o711);
      expect(mode('finance')).toBe(0o700);
      expect(mode('crm')).toBe(0o700); // as itself; the link to it was skipped
      expect(mode('package.json')).toBe(0o600);
      expect(mode('.deno')).toBe(0o755);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('fails closed when the modes cannot be changed', () => {
    expect(() => closeExtensionsDir('/proc/1')).toThrow(/cannot be closed to the extension runner/);
  });
});

describe('extensionsBaseOf', () => {
  it('is the directory the name was joined to, and refuses anything else', () => {
    expect(extensionsBaseOf('/data/extensions/finance/invoicing', 'finance/invoicing')).toBe(
      '/data/extensions',
    );
    expect(extensionsBaseOf('/data/extensions/crm/', 'crm')).toBe('/data/extensions');
    expect(() => extensionsBaseOf('/tmp/zv-signed-abc', 'crm')).toThrow(
      /not <extensions dir>\/crm/,
    );
    expect(() => extensionsBaseOf('/crm', 'crm')).toThrow();
  });
});
