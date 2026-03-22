#!/usr/bin/env bun
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { devCommand } from './commands/dev.js';
import { startCommand } from './commands/start.js';
import { deployCommand } from './commands/deploy.js';
import { migrateCommand } from './commands/migrate.js';
import { extensionCommand } from './commands/extension.js';
import { generateTypesCommand } from './commands/generate-types.js';
import { installCommand } from './commands/install.js';
import { createGodCommand } from './commands/create-god.js';
import { extensionsListCommand } from './commands/extensions-list.js';
import { rollbackCommand } from './commands/rollback.js';
import { versionCommand } from './commands/version-cmd.js';
import { updateCommand } from './commands/update.js';
import { statusCommand } from './commands/status.js';

const program = new Command();

program
  .name('zveltio')
  .description('The official Zveltio CLI')
  .version('2.0.0');

// ── zveltio init [dir] ────────────────────────────────────────────────────────
program
  .command('init [dir]')
  .description('Initialize a new Zveltio project (interactive)')
  .option('--template <template>', 'Starter template to use', 'default')
  .action(initCommand);

// ── zveltio dev ───────────────────────────────────────────────────────────────
program
  .command('dev')
  .description('Start Zveltio in development mode (with hot reload)')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .option('--no-studio', 'Disable Studio embed (API only)')
  .action(devCommand);

// ── zveltio start ─────────────────────────────────────────────────────────────
program
  .command('start')
  .description('Start Zveltio in production mode (uses compiled binary if available)')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .option('--binary <path>', 'Path to compiled binary')
  .action(startCommand);

// ── zveltio deploy ────────────────────────────────────────────────────────────
program
  .command('deploy')
  .description('Build a Docker image and optionally push to a registry')
  .option('--tag <tag>', 'Docker image tag', 'latest')
  .option('--registry <registry>', 'Container registry (e.g. ghcr.io/myorg)')
  .option('--push', 'Push image after build (auto-enabled when --registry is set)')
  .option('--no-push', 'Build only, do not push')
  .option('--no-build', 'Skip build, push existing image')
  .option('--platform <platform>', 'Target platform', 'linux/amd64')
  .option('-f, --dockerfile <path>', 'Path to Dockerfile')
  .option('--context <path>', 'Docker build context', '.')
  .option('--env <file>', 'Env file to read build-args from', '.env')
  .action(deployCommand);

// ── zveltio migrate ───────────────────────────────────────────────────────────
program.addCommand(migrateCommand);

// ── zveltio rollback ──────────────────────────────────────────────────────────
program.addCommand(rollbackCommand);

// ── zveltio status ────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show system status (DB, cache, uptime, version)')
  .option('--url <url>', 'Engine URL', 'http://localhost:3000')
  .option('--json', 'Output as JSON')
  .action(statusCommand);

// ── zveltio version ───────────────────────────────────────────────────────────
program.addCommand(versionCommand);

// ── zveltio update ────────────────────────────────────────────────────────────
program.addCommand(updateCommand);

// ── zveltio create-god ────────────────────────────────────────────────────────
program
  .command('create-god')
  .description('Create the first super-admin (god) user interactively')
  .option('--url <url>', 'Engine URL', 'http://localhost:3000')
  .option('--email <email>', 'Admin email (skip prompt)')
  .option('--name <name>', 'Admin name (skip prompt)')
  .action(createGodCommand);

// ── zveltio generate ──────────────────────────────────────────────────────────
// Supports both:
//   zveltio generate types [collection]  (spec)
//   zveltio generate-types [collection]  (backwards compat)

const generate = program
  .command('generate')
  .description('Code generation utilities');

generate
  .command('types [collection]')
  .description('Generate TypeScript types for collections (writes to ./types/zveltio.d.ts)')
  .option('-o, --output <path>', 'Output file path', './types/zveltio.d.ts')
  .option('--url <url>', 'Engine URL', 'http://localhost:3000')
  .action(generateTypesCommand);

// ── zveltio generate-types [collection] (backwards compat) ───────────────────
program
  .command('generate-types [collection]')
  .description('Generate TypeScript types for your collections')
  .option('-o, --output <path>', 'Output file path', './types/zveltio.d.ts')
  .option('--url <url>', 'Engine URL', 'http://localhost:3000')
  .action(generateTypesCommand);

// ── zveltio install <name> ────────────────────────────────────────────────────
program
  .command('install <name>')
  .description('Install a Zveltio extension from marketplace or local path')
  .option('--path <path>', 'Install from local directory (offline)')
  .option('--url <url>', 'Engine URL for marketplace install', 'http://localhost:3000')
  .option('--force', 'Overwrite existing extension (local install only)')
  .action((name, opts) => installCommand(name, opts));

// ── zveltio extensions ────────────────────────────────────────────────────────
const extensions = program.command('extensions').description('Manage Zveltio extensions');

extensions
  .command('list')
  .description('List all available and installed extensions')
  .option('--url <url>', 'Engine URL', 'http://localhost:3000')
  .option('--category <category>', 'Filter by category')
  .option('--json', 'Output as JSON')
  .action((opts) => extensionsListCommand(opts));

extensions
  .command('install <name>')
  .description('Install an extension from the marketplace or local path')
  .option('--path <path>', 'Install from local directory (offline)')
  .option('--url <url>', 'Engine URL', 'http://localhost:3000')
  .option('--force', 'Overwrite existing extension (local install only)')
  .action((name, opts) => installCommand(name, opts));

extensions
  .command('enable <name>')
  .description('Enable an installed extension')
  .option('--url <url>', 'Engine URL', 'http://localhost:3000')
  .action(async (name: string, opts: any) => {
    const url = opts.url || 'http://localhost:3000';
    const res = await fetch(`${url}/api/marketplace/${name}/enable`, { method: 'POST' }).catch(() => null);
    if (!res?.ok) { console.error(`Failed to enable ${name}`); process.exit(1); }
    const body = await res.json() as any;
    console.log(body.hot_loaded ? `${name} is now active.` : `${name} will be active after restart.`);
  });

extensions
  .command('disable <name>')
  .description('Disable an active extension')
  .option('--url <url>', 'Engine URL', 'http://localhost:3000')
  .action(async (name: string, opts: any) => {
    const url = opts.url || 'http://localhost:3000';
    const res = await fetch(`${url}/api/marketplace/${name}/disable`, { method: 'POST' }).catch(() => null);
    if (!res?.ok) { console.error(`Failed to disable ${name}`); process.exit(1); }
    console.log(`${name} disabled.`);
  });

// ── zveltio extension <subcommand> (legacy) ───────────────────────────────────
const ext = program.command('extension').description('Manage Zveltio extensions (use "extensions" for new commands)');

ext
  .command('create <name>')
  .description('Scaffold a new extension')
  .option('--category <category>', 'Extension category', 'custom')
  .action((name, opts) => extensionCommand('create', name, opts));

ext
  .command('build')
  .description('Build the current extension (.zvext bundle)')
  .action(() => extensionCommand('build', '', {}));

ext
  .command('dev')
  .description('Start extension dev server with hot reload')
  .action(() => extensionCommand('dev', '', {}));

ext
  .command('publish')
  .description('Publish extension to the Zveltio marketplace')
  .option('--token <token>', 'Marketplace auth token')
  .action((_opts) => extensionCommand('publish', '', _opts));

program.parse(process.argv);
