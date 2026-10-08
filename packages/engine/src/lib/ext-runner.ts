/**
 * `zveltio ext-runner` — the bare-metal extension runner (RFC
 * extension-runner, steps 3 and 3b).
 *
 * One systemd service per extension, `zveltio-ext-runner@<instance>`, with
 * `DynamicUser=yes`: each extension runs under its own uid, in its own cgroup
 * (MemoryMax) and behind its own egress rule (IPAddressDeny, with the
 * operator's IPAddressAllow). The engine keeps `NoNewPrivileges=yes` and so
 * cannot start a process under another uid; it asks systemd to start the
 * instance over D-Bus (`systemctl start`, allowed by the polkit rule `setup`
 * writes) and connects to the instance's unix socket. Each accepted
 * connection gets a runtime process; the connection's bytes are piped to its
 * stdin/stdout unchanged — the #979 frames, which only the engine and the
 * runtime decode. A closed connection kills the process; an exited process
 * closes the connection.
 *
 * What makes it a boundary: the runtime runs under a uid that cannot read the
 * engine's files (`.env`, storage), the engine's process state, or another
 * extension's runner directory, and it holds no database connection —
 * `db:query` still crosses to the engine, which is also the only broker
 * between extensions.
 *
 * Who may connect: only the engine's uid, read from the kernel with
 * SO_PEERCRED.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { WORKER_RUNTIME_SOURCE } from './worker-extension-runtime-source.generated.js';
import { createHash } from 'node:crypto';

// Bun's `--compile` mode does NOT auto-bundle workers. Embed the pre-
// compiled worker JS as a string constant and write it to a temp file
// at first-spawn — Bun's Worker constructor accepts an absolute disk
// path. See packages/engine/scripts/gen-worker-source.ts.
let _workerRuntimePath: string | null = null;
export function ensureWorkerRuntimeOnDisk(): string {
  if (_workerRuntimePath && existsSync(_workerRuntimePath)) return _workerRuntimePath;
  const dir = mkdtempSync(join(tmpdir(), 'zveltio-worker-'));
  const path = join(dir, 'worker-extension-runtime.mjs');
  writeFileSync(path, WORKER_RUNTIME_SOURCE, 'utf8');
  _workerRuntimePath = path;
  return path;
}

/**
 * The uid of the process at the other end of a unix socket, from the kernel
 * (SO_PEERCRED), or null when it cannot be read — which the caller treats as
 * a refusal. Bun exposes neither the option nor a way to listen on a socket
 * systemd created, so it is one libc call through `bun:ffi`.
 */
type Getsockopt = (fd: number, level: number, name: number, val: unknown, len: unknown) => number;
let getsockopt: Getsockopt | null = null;
async function peerUid(socket: Socket): Promise<number | null> {
  // Bun keeps the descriptor on the internal handle.
  const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  if (typeof fd !== 'number' || fd < 0) return null;
  const { dlopen, FFIType, ptr } = await import('bun:ffi');
  if (!getsockopt) {
    const libc = dlopen('libc.so.6', {
      getsockopt: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    getsockopt = libc.symbols.getsockopt as unknown as Getsockopt;
  }
  const SOL_SOCKET = 1;
  const SO_PEERCRED = 17;
  const cred = new Int32Array(3); // struct ucred { pid, uid, gid }
  const len = new Uint32Array([12]);
  if (getsockopt!(fd, SOL_SOCKET, SO_PEERCRED, ptr(cred), ptr(len)) !== 0) return null;
  return cred[1];
}

export async function runExtRunner(): Promise<never> {
  const engineUid = Number.parseInt(process.env.ZVELTIO_ENGINE_UID ?? '', 10);
  if (!Number.isInteger(engineUid) || engineUid < 0) {
    console.error('[ext-runner] ZVELTIO_ENGINE_UID must be the numeric uid of the engine service');
    process.exit(1);
  }
  // Same uid as the engine = no boundary at all. Refuse rather than run as
  // a slower in-process worker that looks isolated.
  const ownUid = process.getuid?.();
  if (ownUid === undefined || ownUid === engineUid || ownUid === 0) {
    console.error(
      '[ext-runner] refusing to run as the engine uid or as root — start it through its unit',
    );
    process.exit(1);
  }

  const runtimePath = ensureWorkerRuntimeOnDisk();
  // Only what the runtime needs. The runner's own environment is the unit's,
  // and nothing of the engine's ever reaches this process.
  const childEnv = { NODE_ENV: process.env.NODE_ENV ?? 'production', BUN_BE_BUN: '1' };

  const server = createServer(async (conn) => {
    const uid = await peerUid(conn).catch(() => null);
    if (uid !== engineUid) {
      console.warn(`[ext-runner] refused a connection from uid ${uid ?? 'unknown'}`);
      conn.destroy();
      return;
    }
    // Memory and tasks are the unit's cgroup limits, per extension.
    const child = spawn(process.execPath, [runtimePath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: childEnv,
    });
    conn.pipe(child.stdin);
    child.stdout.pipe(conn);
    conn.on('close', () => child.kill('SIGKILL'));
    conn.on('error', () => child.kill('SIGKILL'));
    child.stdin.on('error', () => conn.destroy());
    child.on('exit', () => conn.destroy());
  });

  const path = process.env.ZVELTIO_EXT_RUNNER_SOCKET;
  if (!path) {
    console.error('[ext-runner] ZVELTIO_EXT_RUNNER_SOCKET is not set');
    process.exit(1);
  }
  rmSync(path, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  // Anyone may reach connect(); SO_PEERCRED decides who is served.
  chmodSync(path, 0o666);
  console.log(`[ext-runner] listening on ${path} for uid ${engineUid}`);

  const stop = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return new Promise<never>(() => {});
}

// ── Engine side: one unit instance per extension ─────────────────────────

const RUNNER_DIR = '/run/zveltio-ext';

/**
 * The systemd instance name for an extension. Extension names are free-form
 * (`acme/my-ext`), and an escaped instance (`acme-my\x2dext`) breaks
 * `RuntimeDirectory=zveltio-ext/%i` — measured: "Failed to deserialize". So
 * the instance is the name reduced to `[a-z0-9_]`, made unique again by a
 * hash of the real name. At most 25 characters, so `User=zx_%i` stays within
 * the 31 a user name may have.
 */
export function runnerInstance(extName: string): string {
  const readable = extName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 16);
  const hash = createHash('sha256').update(extName).digest('hex').slice(0, 8);
  return `${readable}_${hash}`;
}

export function runnerUnit(extName: string): string {
  return `zveltio-ext-runner@${runnerInstance(extName)}.service`;
}

export function runnerSocketPath(extName: string): string {
  return join(RUNNER_DIR, runnerInstance(extName), 'runner.sock');
}

async function systemctl(verb: 'start' | 'stop', unit: string): Promise<void> {
  const proc = Bun.spawn(['systemctl', verb, '--no-ask-password', unit], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if ((await proc.exited) !== 0) {
    const why = (await new Response(proc.stderr).text()).trim();
    throw new Error(`systemctl ${verb} ${unit}: ${why || `exit ${proc.exitCode}`}`);
  }
}

/**
 * Start the extension's runner and return its socket once it listens. The
 * unit is `Type=simple`, so `systemctl start` returns before the socket
 * exists; the socket appears when the runner listens.
 */
export async function startRunner(extName: string): Promise<string> {
  const unit = runnerUnit(extName);
  await systemctl('start', unit);
  const path = runnerSocketPath(extName);
  for (let i = 0; i < 100 && !existsSync(path); i++) await Bun.sleep(100);
  if (!existsSync(path)) throw new Error(`${unit} started but ${path} did not appear in 10s`);
  return path;
}

export async function stopRunner(extName: string): Promise<void> {
  await systemctl('stop', runnerUnit(extName));
}

// ── `zveltio ext-runner setup` ────────────────────────────────────────────

/**
 * The files `setup` writes, as text. One source for install.sh and update.sh
 * (which is downloaded on its own and cannot share a file with the installer).
 */
export function runnerSetupFiles(opts: {
  engineUser: string;
  engineUid: number;
  dir: string;
}): Record<string, string> {
  const { engineUser, engineUid, dir } = opts;
  return {
    '/etc/systemd/system/zveltio-ext-runner@.service': `# Written by \`zveltio ext-runner setup\`. One instance per extension; the engine
# starts it. Per-extension overrides: systemctl edit zveltio-ext-runner@<instance>
#   [Service]
#   MemoryMax=2G
#   IPAddressAllow=203.0.113.7
[Unit]
Description=Zveltio extension runner (%i)
PartOf=zveltio.service
After=network.target

[Service]
Type=simple
DynamicUser=yes
# Named per instance. Left to systemd, the name derives from the unit name, and
# two instances ended up as ONE uid — measured in CI: both runners ran as 63550
# and one wrote into the other's runner directory.
User=zx_%i
ExecStart=${dir}/zveltio ext-runner
Environment=NODE_ENV=production
Environment=ZVELTIO_ENGINE_UID=${engineUid}
Environment=ZVELTIO_EXT_RUNNER_SOCKET=${RUNNER_DIR}/%i/runner.sock
RuntimeDirectory=zveltio-ext/%i
RuntimeDirectoryMode=0755
Restart=on-failure
RestartSec=2
SyslogIdentifier=zveltio-ext-runner

# Only the binary and the extensions are visible from the engine's directory.
TemporaryFileSystem=${dir}:ro
BindReadOnlyPaths=${dir}/zveltio ${dir}/extensions
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectProc=invisible
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
IPAddressDeny=any

MemoryMax=1G
MemorySwapMax=0
TasksMax=64

[Install]
WantedBy=multi-user.target
`,
    '/etc/systemd/system/zveltio.service.d/ext-runner.conf': `# Written by \`zveltio ext-runner setup\`: worker-isolated extensions run in
# zveltio-ext-runner@ instances. .env can override it (EnvironmentFile wins).
[Service]
Environment=ZVELTIO_EXT_TRANSPORT=runner
`,
    '/etc/polkit-1/rules.d/50-zveltio-ext-runner.rules': `// Written by \`zveltio ext-runner setup\`: the engine user may start, stop
// and restart its extension runners, and no other unit.
polkit.addRule(function (action, subject) {
  if (action.id === "org.freedesktop.systemd1.manage-units" && subject.user === ${JSON.stringify(engineUser)}) {
    var unit = action.lookup("unit") || "";
    var verb = action.lookup("verb");
    if (unit.indexOf("zveltio-ext-runner@") === 0 &&
        (verb === "start" || verb === "stop" || verb === "restart")) {
      return polkit.Result.YES;
    }
  }
});
`,
  };
}

/** `zveltio ext-runner setup --engine-user <user> --dir <dir>`, as root. */
export function setupRunner(args: string[]): void {
  const arg = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const engineUser = arg('--engine-user');
  const dir = arg('--dir');
  if (!engineUser || !dir || !/^[a-z_][a-z0-9_-]*$/.test(engineUser) || !dir.startsWith('/')) {
    console.error('usage: zveltio ext-runner setup --engine-user <user> --dir <absolute dir>');
    process.exit(2);
  }
  const id = Bun.spawnSync(['id', '-u', engineUser]);
  const engineUid = Number.parseInt(id.stdout.toString(), 10);
  if (id.exitCode !== 0 || !Number.isInteger(engineUid)) {
    console.error(`[ext-runner] no such user: ${engineUser}`);
    process.exit(1);
  }
  for (const [path, text] of Object.entries(runnerSetupFiles({ engineUser, engineUid, dir }))) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text, { mode: 0o644 });
    console.log(`[ext-runner] wrote ${path}`);
  }
}
