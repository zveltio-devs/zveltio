import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

export async function startCommand(opts: { port?: string; binary?: string }) {
  const port = opts.port || process.env.PORT || '3000';

  // Look for a compiled binary first
  const binaryPath = opts.binary || findBinary();
  if (binaryPath) {
    console.log(`\nStarting Zveltio production binary: ${binaryPath}\n`);
    const proc = spawn(binaryPath, [], {
      env: { ...process.env, PORT: port },
      stdio: 'inherit',
    });

    console.log(`  URL: http://localhost:${port}`);
    console.log(`  Admin: http://localhost:${port}/admin\n`);

    proc.on('error', (err) => {
      console.error('Failed to start binary:', err.message);
      process.exit(1);
    });

    process.on('SIGINT', () => { proc.kill('SIGINT'); process.exit(0); });
    process.on('SIGTERM', () => { proc.kill('SIGTERM'); process.exit(0); });
    return;
  }

  // Fall back to running the engine source with bun (production mode, no --watch)
  const engineEntry = findEngineEntry();
  if (!engineEntry) {
    console.error('❌ Could not find a compiled binary or engine source. Did you run "bun build"?');
    process.exit(1);
  }

  console.log(`\nStarting Zveltio in production mode...\n`);

  const proc = spawn('bun', ['run', engineEntry], {
    env: { ...process.env, PORT: port, NODE_ENV: 'production' },
    stdio: 'inherit',
    shell: true,
  });

  console.log(`  API:   http://localhost:${port}/api`);
  console.log(`  Admin: http://localhost:${port}/admin\n`);

  proc.on('error', (err) => {
    console.error('Failed to start engine:', err.message);
    process.exit(1);
  });

  process.on('SIGINT', () => { proc.kill('SIGINT'); process.exit(0); });
  process.on('SIGTERM', () => { proc.kill('SIGTERM'); process.exit(0); });
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
