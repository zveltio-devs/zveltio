#!/usr/bin/env bun
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { devCommand } from './commands/dev.js';
import { startCommand } from './commands/start.js';
import { deployCommand } from './commands/deploy.js';
import { migrateCommand } from './commands/migrate.js';
import { extensionCommand } from './commands/extension.js';
import { extensionTypesCommand } from './commands/extension-types.js';
import { extensionValidateCommand } from './commands/extension-validate.js';
import { extensionPublishCommand } from './commands/extension-publish.js';
import { extensionDevCommand } from './commands/extension-dev.js';
import { keysGenerateCommand, keysListCommand, keysExportCommand } from './commands/keys.js';
import { generateTypesCommand } from './commands/generate-types.js';
import { installCommand } from './commands/install.js';
import { createGodCommand } from './commands/create-god.js';
import { extensionsListCommand } from './commands/extensions-list.js';
import { rollbackCommand } from './commands/rollback.js';
import { versionCommand } from './commands/version-cmd.js';
import { updateCommand } from './commands/update.js';
import { statusCommand } from './commands/status.js';

const program = new Command();

program.name('zveltio').description('The official Zveltio CLI').version('2.0.0');

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

const generate = program.command('generate').description('Code generation utilities');

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
    const res = await fetch(`${url}/api/marketplace/${name}/enable`, { method: 'POST' }).catch(
      () => null,
    );
    if (!res?.ok) {
      console.error(`Failed to enable ${name}`);
      process.exit(1);
    }
    const body = (await res.json()) as any;
    console.log(
      body.hot_loaded ? `${name} is now active.` : `${name} will be active after restart.`,
    );
  });

extensions
  .command('disable <name>')
  .description('Disable an active extension')
  .option('--url <url>', 'Engine URL', 'http://localhost:3000')
  .action(async (name: string, opts: any) => {
    const url = opts.url || 'http://localhost:3000';
    const res = await fetch(`${url}/api/marketplace/${name}/disable`, { method: 'POST' }).catch(
      () => null,
    );
    if (!res?.ok) {
      console.error(`Failed to disable ${name}`);
      process.exit(1);
    }
    console.log(`${name} disabled.`);
  });

// ── zveltio extension <subcommand> (legacy) ───────────────────────────────────
const ext = program
  .command('extension')
  .description('Manage Zveltio extensions (use "extensions" for new commands)');

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
  .description('Watch engine/ + studio/, hot-reload the running engine on changes (S4-03)')
  .option('--dir <dir>', 'Extension root directory (defaults to cwd)')
  .option('--url <url>', 'Engine URL (env: ZVELTIO_ENGINE_URL)', 'http://localhost:3000')
  .option('--name <name>', 'Extension name (default: read from manifest.json)')
  .option('--no-studio', 'Skip the Studio dev process (engine watch only)')
  .action((opts) => extensionDevCommand(opts));

ext
  .command('pack')
  .description(
    'Bundle engine/index.ts → engine/index.js (target=bun, ESM) and write engine + integrity blocks into manifest.json. Required before publish on v2 channels.',
  )
  .option('--dir <dir>', 'Extension root directory (defaults to cwd)')
  .option('--sourcemap', 'Emit engine/index.js.map alongside the bundle')
  .option('--no-manifest-update', 'Build the bundle but do not patch manifest.json')
  .option('--first-party', 'Vendor / monorepo build — keep inline isolation, skip worker auto-inject')
  .option('--token <token>', 'Registry token for the publisher-tier lookup (env: ZVELTIO_REGISTRY_TOKEN)')
  .option('--registry-url <url>', 'Registry base URL (env: ZVELTIO_REGISTRY_URL)')
  .action(async (opts) => {
    const { extensionPackCommand } = await import('./commands/extension-pack.js');
    return extensionPackCommand(opts);
  });

ext
  .command('publish')
  .description('Validate, build, archive, sign, and upload an extension to the registry (S4-05)')
  .option('--dir <dir>', 'Extension root directory (defaults to cwd)')
  .option('--token <token>', 'Registry auth token (env: ZVELTIO_REGISTRY_TOKEN)')
  .option('--registry-url <url>', 'Registry base URL (env: ZVELTIO_REGISTRY_URL)')
  .option('--key-id <id>', 'Signing key id (default: the only key in ~/.zveltio/keys/)')
  .option('--output <dir>', 'Local-only mode: write .zvext + .sig here, skip upload')
  .option('--no-build', 'Skip both engine pack and Studio build')
  .option('--no-pack', 'Skip engine pack (use existing engine/index.js if present)')
  .option('--no-validate', 'Skip the validate step (NOT recommended)')
  .option('--dry-run', 'Run validate + pack + build, skip archive/sign/upload')
  .option('--first-party', 'Vendor / monorepo build — allow inline isolation (skip §2 worker requirement)')
  .action((opts) => extensionPublishCommand(opts));

ext
  .command('status <name>')
  .description('Show marketplace submission status (pending / published / rejected / taken_down)')
  .option('--registry-url <url>', 'Registry base URL (env: ZVELTIO_REGISTRY_URL)')
  .action(async (name: string, opts) => {
    const { extensionStatusCommand } = await import('./commands/extension-status.js');
    await extensionStatusCommand(name, opts);
  });

ext
  .command('types')
  .description(
    "Generate a .d.ts from the extension's SQL migrations (S4-01). Writes <extension>/.zveltio/db.d.ts.",
  )
  .option('--dir <dir>', 'Extension root directory (defaults to cwd)')
  .option('--output <path>', 'Output file path (default: <dir>/.zveltio/db.d.ts)')
  .action((opts) => extensionTypesCommand(opts));

ext
  .command('validate')
  .description(
    'Pre-publish checks: manifest schema, peerDeps allow-list, migrations parse, destructive DDL has DOWN, bundle quota (S4-04)',
  )
  .option('--dir <dir>', 'Extension root directory (defaults to cwd)')
  .option('--first-party', 'Vendor / monorepo build — allow inline isolation (skip §2 worker requirement)')
  .option('--token <token>', 'Registry token for the publisher-tier lookup (env: ZVELTIO_REGISTRY_TOKEN)')
  .option('--registry-url <url>', 'Registry base URL (env: ZVELTIO_REGISTRY_URL)')
  .action((opts) => extensionValidateCommand(opts));

// ── zveltio keys <subcommand> ────────────────────────────────────────────────
// Ed25519 keypairs used to sign published extension archives (S4-05).
const keys = program.command('keys').description('Manage Ed25519 keypairs for signing extensions');

keys
  .command('generate')
  .description('Generate a new keypair and store it in ~/.zveltio/keys/')
  .option('--id <id>', 'Stable identifier for the key (random if omitted)')
  .option('--force', 'Overwrite an existing key with the same id')
  .action((opts) => keysGenerateCommand(opts));

keys
  .command('list')
  .description('List keypairs stored in ~/.zveltio/keys/')
  .action(() => keysListCommand());

keys
  .command('export <keyId>')
  .description('Print the public key as a trusted-key JSON entry for REGISTRY_PUBLIC_KEYS_JSON')
  .action((keyId: string) => keysExportCommand(keyId));

// ── zveltio admin marketplace ────────────────────────────────────────────────
// Registry review-queue commands (alpha.129). All require admin session
// cookie via --cookie or ZVELTIO_ADMIN_COOKIE.
const admin = program.command('admin').description('Registry admin commands (operator-only)');
const adminMarketplace = admin
  .command('marketplace')
  .description('Review-queue management for community extension submissions');

adminMarketplace
  .command('pending')
  .description('List extension submissions awaiting review')
  .option('--registry-url <url>', 'Registry base URL (env: ZVELTIO_REGISTRY_URL)')
  .option('--cookie <cookie>', 'Admin session cookie (env: ZVELTIO_ADMIN_COOKIE)')
  .action(async (opts) => {
    const { adminMarketplacePending } = await import('./commands/admin-marketplace.js');
    await adminMarketplacePending(opts);
  });

adminMarketplace
  .command('approve <nameOrId>')
  .description('Approve a pending submission (status → published)')
  .option('--registry-url <url>', 'Registry base URL')
  .option('--cookie <cookie>', 'Admin session cookie')
  .option('--note <note>', 'Optional internal note for the audit trail')
  .action(async (nameOrId: string, opts) => {
    const { adminMarketplaceApprove } = await import('./commands/admin-marketplace.js');
    await adminMarketplaceApprove(nameOrId, opts);
  });

adminMarketplace
  .command('reject <nameOrId>')
  .description('Reject a pending submission with a reason (visible to publisher)')
  .option('--registry-url <url>', 'Registry base URL')
  .option('--cookie <cookie>', 'Admin session cookie')
  .requiredOption('--reason <reason>', 'Rejection reason')
  .action(async (nameOrId: string, opts) => {
    const { adminMarketplaceReject } = await import('./commands/admin-marketplace.js');
    await adminMarketplaceReject(nameOrId, opts);
  });

adminMarketplace
  .command('takedown <extensionId>')
  .description('Pull a previously approved extension (status → taken_down)')
  .option('--registry-url <url>', 'Registry base URL')
  .option('--cookie <cookie>', 'Admin session cookie')
  .requiredOption('--reason <reason>', 'Takedown reason')
  .action(async (id: string, opts) => {
    const { adminMarketplaceTakedown } = await import('./commands/admin-marketplace.js');
    await adminMarketplaceTakedown(id, opts);
  });

adminMarketplace
  .command('publishers')
  .description('List enrolled allowed publishers')
  .option('--registry-url <url>', 'Registry base URL')
  .option('--cookie <cookie>', 'Admin session cookie')
  .action(async (opts) => {
    const { adminMarketplacePublishers } = await import('./commands/admin-marketplace.js');
    await adminMarketplacePublishers(opts);
  });

// Admin team commands (beta.2)
const adminTeam = admin
  .command('team')
  .description('Marketplace admin roster (review-queue access). Owner-only writes.');

adminTeam
  .command('list')
  .description('List current admin team members + roles')
  .option('--registry-url <url>', 'Registry base URL')
  .option('--cookie <cookie>', 'Admin session cookie')
  .action(async (opts) => {
    const { adminTeamList } = await import('./commands/admin-marketplace.js');
    await adminTeamList(opts);
  });

adminTeam
  .command('add <email>')
  .description('Add a user to the admin team (they must have an apps account first)')
  .option('--registry-url <url>', 'Registry base URL')
  .option('--cookie <cookie>', 'Admin session cookie')
  .option('--role <role>', "Role: 'owner' | 'admin'", 'admin')
  .option('--notes <notes>', 'Internal notes')
  .action(async (email: string, opts) => {
    const { adminTeamAdd } = await import('./commands/admin-marketplace.js');
    await adminTeamAdd(email, opts);
  });

adminTeam
  .command('set-role <email> <role>')
  .description("Change a team member's role (owner|admin). Refuses to demote the last owner.")
  .option('--registry-url <url>', 'Registry base URL')
  .option('--cookie <cookie>', 'Admin session cookie')
  .action(async (email: string, role: string, opts) => {
    if (role !== 'owner' && role !== 'admin') {
      console.error(`Invalid role "${role}" — must be 'owner' or 'admin'`);
      process.exit(1);
    }
    const { adminTeamSetRole } = await import('./commands/admin-marketplace.js');
    await adminTeamSetRole(email, role, opts);
  });

adminTeam
  .command('remove <email>')
  .description('Remove a user from the admin team')
  .option('--registry-url <url>', 'Registry base URL')
  .option('--cookie <cookie>', 'Admin session cookie')
  .action(async (email: string, opts) => {
    const { adminTeamRemove } = await import('./commands/admin-marketplace.js');
    await adminTeamRemove(email, opts);
  });

adminMarketplace
  .command('enroll-publisher')
  .description('Add a new publisher to the allowlist (key-based submissions)')
  .option('--registry-url <url>', 'Registry base URL')
  .option('--cookie <cookie>', 'Admin session cookie')
  .requiredOption('--name <name>', 'Publisher display name')
  .requiredOption('--email <email>', 'Publisher contact email')
  .requiredOption('--key-id <keyId>', 'Ed25519 key id (used at signature time)')
  .requiredOption('--key-file <path>', 'Path to JSON file containing the public JWK')
  .option('--tier <tier>', 'Trust tier: first-party | verified | community', 'community')
  .option('--notes <notes>', 'Internal notes')
  .action(async (opts) => {
    const { adminMarketplaceEnrollPublisher } = await import('./commands/admin-marketplace.js');
    await adminMarketplaceEnrollPublisher(opts);
  });

// IMPORTANT: use parseAsync so async action handlers (e.g. `extension publish`,
// `keys generate`) finish before the script exits. With plain `parse()`,
// commander returns immediately and the Bun process exits while the action
// is still mid-await, silently truncating output.
await program.parseAsync(process.argv);
