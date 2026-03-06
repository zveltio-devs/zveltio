#!/usr/bin/env bun
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { devCommand } from './commands/dev.js';
import { startCommand } from './commands/start.js';
import { migrateCommand } from './commands/migrate.js';
import { extensionCommand } from './commands/extension.js';
import { generateTypesCommand } from './commands/generate-types.js';
import { installCommand } from './commands/install.js';
import { createGodCommand } from './commands/create-god.js';

const program = new Command();

program
  .name('zveltio')
  .description('The official Zveltio CLI')
  .version('2.0.0');

// zveltio init [dir]
program
  .command('init [dir]')
  .description('Initialize a new Zveltio project')
  .option('--template <template>', 'Starter template to use', 'default')
  .action(initCommand);

// zveltio dev
program
  .command('dev')
  .description('Start Zveltio in development mode')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .option('--no-studio', 'Disable Studio embed (API only)')
  .action(devCommand);

// zveltio start
program
  .command('start')
  .description('Start Zveltio in production mode (uses compiled binary if available)')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .option('--binary <path>', 'Path to compiled binary')
  .action(startCommand);

// zveltio migrate
program
  .command('migrate')
  .description('Run pending database migrations')
  .option('--dry-run', 'Show migrations that would run without applying them')
  .action(migrateCommand);

// zveltio create-god
program
  .command('create-god')
  .description('Create the first super-admin (god) user interactively')
  .option('--url <url>', 'Engine URL', 'http://localhost:3000')
  .option('--email <email>', 'Admin email (skip prompt)')
  .option('--name <name>', 'Admin name (skip prompt)')
  .action(createGodCommand);

// zveltio generate-types [collection]
program
  .command('generate-types [collection]')
  .description('Generate TypeScript types for your collections')
  .option('-o, --output <path>', 'Output file path', './zveltio.d.ts')
  .option('--url <url>', 'Engine URL', 'http://localhost:3000')
  .action(generateTypesCommand);

// zveltio install <name>
program
  .command('install <name>')
  .description('Install a Zveltio extension from local path or registry')
  .option('--path <path>', 'Install from local directory')
  .option('--registry <url>', 'Extension registry URL')
  .option('--force', 'Overwrite existing extension')
  .action((name, opts) => installCommand(name, opts));

// zveltio extension <subcommand>
const ext = program.command('extension').description('Manage Zveltio extensions');

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
