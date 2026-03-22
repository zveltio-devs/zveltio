import { existsSync } from 'fs';
import { join } from 'path';

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const c = {
  bold:  (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan:  (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim:   (s: string) => `\x1b[2m${s}\x1b[0m`,
  red:   (s: string) => `\x1b[31m${s}\x1b[0m`,
};

export async function startCommand(opts: { port?: string; binary?: string }) {
  const port = opts.port || process.env.PORT || '3000';

  // Look for a compiled binary first
  const binaryPath = opts.binary || findBinary();
  if (binaryPath) {
    console.log(`\n${c.bold('Zveltio')} starting production binary: ${c.dim(binaryPath)}\n`);
    console.log(`  API:   ${c.cyan(`http://localhost:${port}/api`)}`);
    console.log(`  Admin: ${c.cyan(`http://localhost:${port}/admin`)}\n`);
    console.log(c.dim('  Press Ctrl+C to stop\n'));

    const proc = Bun.spawn([binaryPath], {
      env: { ...process.env, PORT: port },
      stdio: ['inherit', 'inherit', 'inherit'],
    });

    process.on('SIGINT', () => { proc.kill(); process.exit(0); });
    process.on('SIGTERM', () => { proc.kill(); process.exit(0); });
    const exitCode = await proc.exited;
    process.exit(exitCode);
    return;
  }

  // Fall back to running the engine source with bun (production mode, no --watch)
  const engineEntry = findEngineEntry();
  if (!engineEntry) {
    console.error(c.red('Could not find a compiled binary or engine source. Did you run "bun build"?'));
    process.exit(1);
  }

  console.log(`\n${c.bold('Zveltio')} starting in production mode...\n`);
  console.log(`  API:   ${c.cyan(`http://localhost:${port}/api`)}`);
  console.log(`  Admin: ${c.cyan(`http://localhost:${port}/admin`)}\n`);
  console.log(c.dim('  Press Ctrl+C to stop\n'));

  const proc = Bun.spawn(['bun', 'run', engineEntry], {
    env: { ...process.env, PORT: port, NODE_ENV: 'production' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });

  process.on('SIGINT', () => { proc.kill(); process.exit(0); });
  process.on('SIGTERM', () => { proc.kill(); process.exit(0); });
  const exitCode = await proc.exited;
  process.exit(exitCode);
}

function findBinary(): string | null {
  const candidates = [
    'dist/zveltio',
    'dist/zveltio.exe',
    'packages/engine/dist/zveltio',
    'packages/engine/dist/zveltio.exe',
  ];

  for (const c of candidates) {
    const full = join(process.cwd(), c);
    if (existsSync(full)) return full;
  }
  return null;
}

function findEngineEntry(): string | null {
  const candidates = [
    'packages/engine/src/index.ts',
    'src/index.ts',
    'index.ts',
  ];

  for (const candidate of candidates) {
    const full = join(process.cwd(), candidate);
    if (existsSync(full)) return candidate;
  }
  return null;
}
