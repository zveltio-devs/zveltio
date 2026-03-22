import { existsSync } from 'fs';
import { join } from 'path';

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const c = {
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
};

interface DeployOptions {
  tag?: string;
  registry?: string;
  push?: boolean;
  platform?: string;
  dockerfile?: string;
  context?: string;
  noBuild?: boolean;
  noPush?: boolean;
  env?: string;
}

async function runCommand(cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<void> {
  const proc = Bun.spawn(cmd, {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
    cwd: opts?.cwd,
    env: opts?.env ? { ...process.env, ...opts.env } : undefined,
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Command failed with exit code ${code}: ${cmd.join(' ')}`);
  }
}

export async function deployCommand(opts: DeployOptions) {
  console.log(`\n${c.bold(c.cyan('Zveltio Deploy'))}\n`);

  const cwd = process.cwd();

  // Resolve project name from package.json
  let projectName = 'zveltio-app';
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(await Bun.file(pkgPath).text());
    projectName = (pkg.name || 'zveltio-app').replace(/[@/]/g, '').replace(/\s+/g, '-').toLowerCase();
  }

  const registry = opts.registry || process.env.DOCKER_REGISTRY || '';
  const tag = opts.tag || process.env.DEPLOY_TAG || 'latest';
  const imageName = registry
    ? `${registry.replace(/\/$/, '')}/${projectName}:${tag}`
    : `${projectName}:${tag}`;

  const platform = opts.platform || 'linux/amd64';
  const dockerfile = opts.dockerfile || findDockerfile(cwd);
  const context = opts.context || '.';

  console.log(`  Image:      ${c.cyan(imageName)}`);
  console.log(`  Platform:   ${c.dim(platform)}`);
  console.log(`  Dockerfile: ${c.dim(dockerfile || 'Dockerfile (auto-detected)')}`);
  console.log('');

  // ── Step 1: Check Docker is available ─────────────────────────────────────
  {
    const check = Bun.spawn(['docker', 'version', '--format', '{{.Server.Version}}'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await check.exited;
    if (code !== 0) {
      console.error(c.red('Docker is not installed or not running.'));
      console.error(c.dim('  Install Docker: https://docs.docker.com/get-docker/'));
      process.exit(1);
    }
    const version = (await new Response(check.stdout).text()).trim();
    console.log(`  Docker:     ${c.dim(`v${version}`)}`);
    console.log('');
  }

  // ── Step 2: Build Docker image ─────────────────────────────────────────────
  if (!opts.noBuild) {
    console.log(`${c.bold('Building Docker image...')}`);

    if (!dockerfile) {
      // Generate a minimal Dockerfile if none exists
      console.log(c.yellow('  No Dockerfile found — generating a minimal one...'));
      await generateDockerfile(cwd, projectName);
      console.log(c.dim('  Created: Dockerfile'));
    }

    const buildArgs: string[] = [
      'docker', 'build',
      '--platform', platform,
      '-t', imageName,
    ];

    if (dockerfile) {
      buildArgs.push('-f', dockerfile);
    }

    // Pass env file for build args if requested
    if (opts.env && existsSync(opts.env)) {
      const envContent = await Bun.file(opts.env).text();
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        // Only pass non-secret build args
        if (['PORT', 'NODE_ENV', 'ENABLE_STUDIO'].includes(key)) {
          buildArgs.push('--build-arg', `${key}=${trimmed.slice(eqIdx + 1).trim()}`);
        }
      }
    }

    buildArgs.push(context);

    try {
      await runCommand(buildArgs);
      console.log(c.green(`\nImage built: ${imageName}\n`));
    } catch (err: any) {
      console.error(c.red(`\nBuild failed: ${err.message}`));
      process.exit(1);
    }
  } else {
    console.log(c.dim('  Skipping build (--no-build)'));
  }

  // ── Step 3: Push image to registry ────────────────────────────────────────
  const shouldPush = opts.push ?? (!opts.noPush && !!registry);
  if (shouldPush) {
    if (!registry) {
      console.error(c.red('Cannot push: no registry specified.'));
      console.error(c.dim('  Use --registry <registry> or set DOCKER_REGISTRY env var.'));
      process.exit(1);
    }

    console.log(`${c.bold('Pushing image to registry...')}`);
    try {
      await runCommand(['docker', 'push', imageName]);
      console.log(c.green(`\nImage pushed: ${imageName}\n`));
    } catch (err: any) {
      console.error(c.red(`\nPush failed: ${err.message}`));
      console.error(c.dim('  Ensure you are logged in: docker login'));
      process.exit(1);
    }
  } else if (!registry) {
    console.log(c.dim('  Skipping push (no registry configured)'));
    console.log(c.dim('  Use --registry <registry> to push to a container registry.'));
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log(`\n${c.green('Deploy complete!')}`);
  console.log(`\n  Image: ${c.cyan(imageName)}`);
  if (shouldPush) {
    console.log(`\n  ${c.bold('Run with:')}`);
    console.log(`  docker run -d --env-file .env -p 3000:3000 ${imageName}`);
    console.log(`\n  ${c.bold('Or with docker compose:')}`);
    console.log(`  docker compose up -d`);
  } else {
    console.log(`\n  ${c.bold('Run locally:')}`);
    console.log(`  docker run -d --env-file .env -p 3000:3000 ${imageName}`);
    console.log(`\n  ${c.bold('Push to registry:')}`);
    console.log(`  zveltio deploy --registry <registry>`);
  }
  console.log('');
}

function findDockerfile(cwd: string): string | null {
  const candidates = ['Dockerfile', 'docker/Dockerfile', 'packages/engine/Dockerfile'];
  for (const f of candidates) {
    if (existsSync(join(cwd, f))) return f;
  }
  return null;
}

async function generateDockerfile(cwd: string, projectName: string): Promise<void> {
  // Detect engine entry point
  let entryPoint = 'packages/engine/src/index.ts';
  if (!existsSync(join(cwd, entryPoint))) {
    entryPoint = existsSync(join(cwd, 'src/index.ts')) ? 'src/index.ts' : 'index.ts';
  }

  await Bun.write(
    join(cwd, 'Dockerfile'),
    `# Auto-generated by zveltio deploy
# Edit this file to customise your production image.
FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

FROM base AS build
COPY . .
COPY --from=deps /app/node_modules ./node_modules
RUN bun build ${entryPoint} \\
      --compile \\
      --outfile dist/${projectName} \\
      --target bun

FROM base AS runner
WORKDIR /app
# Run as non-root for security
RUN addgroup --system --gid 1001 zveltio && \\
    adduser --system --uid 1001 zveltio
COPY --from=build /app/dist/${projectName} ./dist/${projectName}
# Copy migrations and static assets
COPY --from=build /app/packages/engine/src/db/migrations ./packages/engine/src/db/migrations
USER zveltio
EXPOSE 3000
ENV NODE_ENV=production
CMD ["./dist/${projectName}"]
`,
  );
}
