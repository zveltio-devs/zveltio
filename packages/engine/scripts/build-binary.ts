#!/usr/bin/env bun
/**
 * Produce a single-file Zveltio engine binary (`dist/zveltio`).
 *
 * Pre-steps (same order as release):
 *   1. gen-embedded-migrations.ts
 *   2. gen-worker-source.ts  (Bun --compile does not bundle workers)
 *   3. generate-studio-embed.ts  (optional — when src/studio-dist/ exists)
 *   4. bun build src/index.ts --compile
 *
 * Usage (from repo root):
 *   bun run studio:build && bun run studio:embed   # optional Studio UI
 *   bun run build:binary
 *
 * Env:
 *   ZVELTIO_BINARY_OUT     — output path (default: packages/engine/dist/zveltio)
 *   ZVELTIO_BINARY_TARGET  — bun compile target (default: bun-linux-x64 / arm64)
 *   ZVELTIO_BINARY_MINIFY  — set to 1 to pass --minify
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const engineRoot = join(import.meta.dir, '..');
const outFile = process.env.ZVELTIO_BINARY_OUT ?? join(engineRoot, 'dist/zveltio');
const minify = process.env.ZVELTIO_BINARY_MINIFY === '1';

function defaultTarget(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const platform =
    process.platform === 'darwin'
      ? 'darwin'
      : process.platform === 'win32'
        ? 'windows'
        : 'linux';
  return `bun-${platform}-${arch}`;
}

const target = process.env.ZVELTIO_BINARY_TARGET ?? defaultTarget();

async function runStep(label: string, script: string): Promise<void> {
  console.log(`▶ ${label}`);
  const proc = Bun.spawn(['bun', join('scripts', script)], {
    cwd: engineRoot,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`❌ ${label} failed (exit ${code})`);
    process.exit(code);
  }
}

async function main(): Promise<void> {
  await runStep('Embedded migrations', 'gen-embedded-migrations.ts');
  await runStep('Worker runtime source', 'gen-worker-source.ts');

  const studioIndex = Bun.file(join(engineRoot, 'src/studio-dist/index.html'));
  if (await studioIndex.exists()) {
    await runStep('Studio embed', 'generate-studio-embed.ts');
  } else {
    console.warn(
      '⚠️  src/studio-dist/ missing — skipping studio embed.\n' +
        '   Run from repo root: bun run studio:build && bun run studio:embed\n' +
        '   The binary still works; mount studio-dist/ beside it at runtime.',
    );
  }

  mkdirSync(join(engineRoot, 'dist'), { recursive: true });

  const args = [
    'build',
    join(engineRoot, 'src/index.ts'),
    '--compile',
    `--outfile=${outFile}`,
    `--target=${target}`,
  ];
  if (minify) args.push('--minify');

  console.log(`▶ Compile → ${outFile} (${target})`);
  const compile = Bun.spawn(['bun', ...args], {
    cwd: engineRoot,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await compile.exited;
  if (code !== 0) {
    console.error(`❌ compile failed (exit ${code})`);
    process.exit(code);
  }

  console.log(`✅ Binary ready: ${outFile}`);
}

await main();
