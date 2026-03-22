import { existsSync } from 'fs';
import { join } from 'path';

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const c = {
  bold:  (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan:  (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim:   (s: string) => `\x1b[2m${s}\x1b[0m`,
  red:   (s: string) => `\x1b[31m${s}\x1b[0m`,
};

export async function devCommand(opts: { port?: string; studio?: boolean }) {
  console.log(`\n${c.bold(c.cyan('Zveltio Dev Mode'))}\n`);

  const port = opts.port || process.env.PORT || '3000';

  // Find engine entry point
  const engineEntry = findEngineEntry();
  if (!engineEntry) {
    console.error(c.red('Could not find engine entry point. Make sure you are in a Zveltio project directory.'));
    console.error(c.dim('  Expected: packages/engine/src/index.ts, src/index.ts, or index.ts'));
    process.exit(1);
  }

  console.log(`  Engine:  ${c.cyan(`http://localhost:${port}/api`)}`);
  if (opts.studio !== false) {
    console.log(`  Studio:  ${c.cyan(`http://localhost:${port}/admin`)}`);
  }
  console.log(`  Entry:   ${c.dim(engineEntry)}`);
  console.log(`\n${c.dim('  Press Ctrl+C to stop')}\n`);

  const proc = Bun.spawn(
    ['bun', 'run', '--watch', engineEntry],
    {
      env: {
        ...process.env,
        PORT: port,
        NODE_ENV: 'development',
        ...(opts.studio === false ? { ENABLE_STUDIO: 'false' } : {}),
      },
      stdio: ['inherit', 'inherit', 'inherit'],
    },
  );

  // Forward signals to child
  process.on('SIGINT', () => {
    proc.kill();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    proc.kill();
    process.exit(0);
  });

  const exitCode = await proc.exited;
  process.exit(exitCode);
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
