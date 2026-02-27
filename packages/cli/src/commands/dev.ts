import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

export async function devCommand(opts: { port?: string; studio?: boolean }) {
  console.log('\n🔧 Starting Zveltio in development mode...\n');

  const port = opts.port || process.env.PORT || '3000';

  // Find engine entry point
  const engineEntry = findEngineEntry();
  if (!engineEntry) {
    console.error('❌ Could not find engine entry point. Make sure you are in a Zveltio project directory.');
    process.exit(1);
  }

  const proc = spawn(
    'bun',
    ['run', '--watch', engineEntry],
    {
      env: { ...process.env, PORT: port },
      stdio: 'inherit',
      shell: true,
    },
  );

  console.log(`  Engine: http://localhost:${port}/api`);
  console.log(`  Studio: http://localhost:${port}/admin\n`);

  proc.on('error', (err) => {
    console.error('Failed to start engine:', err);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    proc.kill('SIGINT');
    process.exit(0);
  });
}

function findEngineEntry(): string | null {
  const candidates = [
    'packages/engine/src/index.ts',
    'src/index.ts',
    'index.ts',
  ];

  for (const candidate of candidates) {
    if (existsSync(join(process.cwd(), candidate))) {
      return candidate;
    }
  }

  return null;
}
