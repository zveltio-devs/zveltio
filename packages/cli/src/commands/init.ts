import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const c = {
  bold:  (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan:  (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim:   (s: string) => `\x1b[2m${s}\x1b[0m`,
  red:   (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow:(s: string) => `\x1b[33m${s}\x1b[0m`,
};

function rl(): ReturnType<typeof createInterface> {
  return createInterface({ input: process.stdin, output: process.stdout });
}

async function ask(iface: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => iface.question(question, resolve));
}

async function askWithDefault(iface: ReturnType<typeof createInterface>, question: string, defaultValue: string): Promise<string> {
  const answer = await ask(iface, question);
  return answer.trim() || defaultValue;
}

async function askYesNo(iface: ReturnType<typeof createInterface>, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = await ask(iface, `${question} ${c.dim(`[${hint}]`)}: `);
  const trimmed = answer.trim().toLowerCase();
  if (!trimmed) return defaultYes;
  return trimmed === 'y' || trimmed === 'yes';
}

// ── Extension picker ──────────────────────────────────────────────────────────

interface OfficialExtension {
  name: string;
  description: string | null;
  category?: string;
}

async function fetchOfficialExtensions(): Promise<OfficialExtension[]> {
  try {
    const res = await fetch('https://registry.zveltio.com/api/extensions/list?official=true', {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { extensions: OfficialExtension[] };
    return data.extensions ?? [];
  } catch {
    return [];
  }
}

async function pickExtensions(
  iface: ReturnType<typeof createInterface>,
  extensions: OfficialExtension[],
): Promise<string[]> {
  if (extensions.length === 0) return [];

  // Group by category
  const groups = new Map<string, OfficialExtension[]>();
  for (const ext of extensions) {
    const cat = ext.name.split('/')[0] ?? 'general';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(ext);
  }

  console.log(`\n${c.bold('Available extensions:')}`);
  console.log(c.dim('  Press enter to skip, or enter numbers separated by spaces.\n'));

  let idx = 1;
  const indexed: Array<{ num: number; name: string }> = [];

  for (const [cat, exts] of groups) {
    console.log(`  ${c.cyan(c.bold(cat))}`);
    for (const ext of exts) {
      const shortDesc = ext.description
        ? `  ${c.dim('— ' + ext.description.slice(0, 55) + (ext.description.length > 55 ? '…' : ''))}`
        : '';
      console.log(`    ${c.dim(String(idx).padStart(2, ' ') + '.')} ${ext.name.split('/').pop()}${shortDesc}`);
      indexed.push({ num: idx, name: ext.name });
      idx++;
    }
    console.log('');
  }

  const answer = await ask(
    iface,
    `Extensions to enable ${c.dim('[space-separated numbers, or enter for none]')}: `,
  );

  if (!answer.trim()) return [];

  const chosen = new Set<string>();
  for (const token of answer.trim().split(/\s+/)) {
    const n = parseInt(token, 10);
    const found = indexed.find(e => e.num === n);
    if (found) chosen.add(found.name);
  }

  return [...chosen];
}

export async function initCommand(
  name: string = '.',
  _opts: { template?: string } = {},
) {
  console.log(`\n${c.bold(c.cyan('Zveltio Init'))}\n`);

  // Fetch official extensions early (non-blocking)
  const extensionsPromise = fetchOfficialExtensions();

  const iface = rl();

  // ── Interactive prompts ────────────────────────────────────────────────────
  const defaultProjectName = name !== '.'
    ? name.split(/[/\\]/).pop() || 'zveltio-app'
    : process.cwd().split(/[/\\]/).pop() || 'zveltio-app';

  const projectName = await askWithDefault(
    iface,
    `Project name ${c.dim(`[${defaultProjectName}]`)}: `,
    defaultProjectName,
  );

  const dbPassword = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const defaultDbUrl = `postgresql://zveltio:${dbPassword}@localhost:5432/${projectName}`;
  const databaseUrl = await askWithDefault(
    iface,
    `Database URL ${c.dim(`[${defaultDbUrl}]`)}: `,
    defaultDbUrl,
  );

  const portStr = await askWithDefault(
    iface,
    `Port ${c.dim('[3000]')}: `,
    '3000',
  );
  const port = parseInt(portStr, 10) || 3000;

  const enableStudio = await askYesNo(
    iface,
    'Enable Studio (admin UI)?',
    true,
  );

  // ── Employee Intranet zone ─────────────────────────────────────────────────
  const enableIntranet = await askYesNo(
    iface,
    'Enable Employee Intranet zone? (portal for non-admin employees)',
    false,
  );

  // ── Client Portal zone ────────────────────────────────────────────────────
  const enableClientPortal = await askYesNo(
    iface,
    'Enable Client Portal? (customer-facing portal with multiple templates)',
    false,
  );

  let clientPortalTemplate = 'generic';
  if (enableClientPortal) {
    console.log('');
    console.log(c.dim('  Available templates:'));
    console.log(c.dim('    1. generic      — Dashboard + support tickets + profile'));
    console.log(c.dim('    2. saas         — Subscription management + support'));
    console.log(c.dim('    3. services     — Professional services portal'));
    console.log(c.dim('    4. regulatory   — Authorizations, inspections, business locations'));
    console.log('');
    const tmplAnswer = await ask(iface, `  Template ${c.dim('[1-4, default: 1]')}: `);
    const tmplMap: Record<string, string> = {
      '1': 'generic', '2': 'saas', '3': 'services', '4': 'regulatory',
      'generic': 'generic', 'saas': 'saas', 'services': 'services', 'regulatory': 'regulatory',
    };
    clientPortalTemplate = tmplMap[tmplAnswer.trim()] ?? 'generic';
    console.log(`  ${c.green('✔')} Template: ${clientPortalTemplate}`);
  }

  // ── Extension picker ───────────────────────────────────────────────────────
  const officialExtensions = await extensionsPromise;
  let selectedExtensions: string[] = [];

  if (officialExtensions.length > 0) {
    selectedExtensions = await pickExtensions(iface, officialExtensions);
  } else {
    console.log(c.dim('\n  (Could not reach registry — extensions can be configured later in .env)\n'));
  }

  iface.close();

  // ── Determine target directory ─────────────────────────────────────────────
  const dir = name === '.' ? process.cwd() : join(process.cwd(), name);

  if (name !== '.' && existsSync(dir)) {
    console.error(c.red(`\nDirectory "${name}" already exists`));
    process.exit(1);
  }

  mkdirSync(dir, { recursive: true });

  // ── Generate remaining secrets ─────────────────────────────────────────────
  const s3AccessKey = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const s3SecretKey = crypto.randomUUID().replace(/-/g, '');
  const authSecret  = crypto.randomUUID().replace(/-/g, '');

  const extensionsValue = selectedExtensions.join(',');

  // ── .env ──────────────────────────────────────────────────────────────────
  const envLines = [
    '# WARNING: NEVER commit this file to git — it contains secrets.',
    '# For production, replace ALL values with strong credentials.',
    `DATABASE_URL=${databaseUrl}`,
    `PORT=${port}`,
    `BETTER_AUTH_SECRET=${authSecret}`,
    'VALKEY_URL=redis://localhost:6379',
    'S3_ENDPOINT=http://localhost:8333',
    'S3_BUCKET=zveltio',
    `S3_ACCESS_KEY=${s3AccessKey}`,
    `S3_SECRET_KEY=${s3SecretKey}`,
    `ENABLE_STUDIO=${enableStudio ? 'true' : 'false'}`,
    `ZVELTIO_EXTENSIONS=${extensionsValue}`,
  ];

  if (enableIntranet) {
    envLines.push('# Intranet employee zone is enabled');
    envLines.push('ENABLE_INTRANET=true');
  }

  if (enableClientPortal) {
    envLines.push('# Client Portal');
    envLines.push('ENABLE_CLIENT_PORTAL=true');
    envLines.push(`CLIENT_PORTAL_TEMPLATE=${clientPortalTemplate}`);
  }

  envLines.push('');

  await Bun.write(join(dir, '.env'), envLines.join('\n'));

  // ── .env.example ──────────────────────────────────────────────────────────
  await Bun.write(
    join(dir, '.env.example'),
    [
      '# Copy to .env and fill in real values. Never commit .env to git.',
      'DATABASE_URL=postgresql://zveltio:CHANGE_ME@localhost:5432/dbname',
      'PORT=3000',
      'BETTER_AUTH_SECRET=CHANGE_ME_use_random_32+_chars',
      'VALKEY_URL=redis://localhost:6379',
      'S3_ENDPOINT=http://localhost:8333',
      'S3_BUCKET=zveltio',
      'S3_ACCESS_KEY=CHANGE_ME',
      'S3_SECRET_KEY=CHANGE_ME',
      'ENABLE_STUDIO=true',
      `ZVELTIO_EXTENSIONS=${extensionsValue}`,
      '# Optional zones',
      '# ENABLE_INTRANET=true',
      '# ENABLE_CLIENT_PORTAL=true',
      '# CLIENT_PORTAL_TEMPLATE=generic   # generic | saas | services | regulatory',
      '',
    ].join('\n'),
  );

  // ── package.json ──────────────────────────────────────────────────────────
  await Bun.write(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: projectName,
        private: true,
        scripts: {
          dev: 'zveltio dev',
          start: 'zveltio start',
          migrate: 'zveltio migrate',
        },
        dependencies: {
          '@zveltio/engine': 'latest',
        },
      },
      null,
      2,
    ),
  );

  // ── docker-compose.yml ───────────────────────────────────────────────────
  const composeDbPassword = dbPassword;
  const composeDbName = projectName.replace(/[^a-zA-Z0-9_]/g, '_');

  await Bun.write(
    join(dir, 'docker-compose.yml'),
    `version: '3.8'
services:
  db:
    image: postgis/postgis:16-3.4-alpine
    environment:
      POSTGRES_DB: ${composeDbName}
      POSTGRES_USER: zveltio
      POSTGRES_PASSWORD: ${composeDbPassword}
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U zveltio -d ${composeDbName}"]
      interval: 10s
      timeout: 5s
      retries: 5

  valkey:
    image: valkey/valkey:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "valkey-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
`,
  );

  // ── .gitignore ────────────────────────────────────────────────────────────
  await Bun.write(
    join(dir, '.gitignore'),
    [
      '.env',
      'node_modules/',
      'dist/',
      '.DS_Store',
      '*.local',
      'types/',
      '',
    ].join('\n'),
  );

  // ── Print next steps ──────────────────────────────────────────────────────
  const extSummary = selectedExtensions.length > 0
    ? `\n  ${c.green('✔')} Extensions: ${selectedExtensions.map(e => e.split('/').pop()).join(', ')}`
    : '';
  const intranetSummary = enableIntranet ? `\n  ${c.green('✔')} Employee Intranet: enabled` : '';
  const portalSummary = enableClientPortal
    ? `\n  ${c.green('✔')} Client Portal: ${clientPortalTemplate} template`
    : '';

  console.log(`\n${c.green(`✔ Project "${projectName}" initialized`)} at ${dir}${extSummary}${intranetSummary}${portalSummary}`);

  const portalNote = enableClientPortal
    ? `\n  ${c.cyan(`Client Portal:  http://localhost:${port}/portal-client/login`)}`
    : '';
  const intranetNote = enableIntranet
    ? `\n  ${c.cyan(`Intranet:       http://localhost:${port}/admin/intranet`)}`
    : '';

  console.log(`
${c.bold('Next steps:')}
  ${name !== '.' ? `cd ${name}\n  ` : ''}docker compose up -d     ${c.dim('# start PostgreSQL + Valkey')}
  bun install               ${c.dim('# install dependencies')}
  zveltio migrate           ${c.dim('# apply database migrations')}
  zveltio dev               ${c.dim('# start development server')}

  ${c.cyan(`Studio:         http://localhost:${port}${enableStudio ? '/admin' : '/api'}`)}${intranetNote}${portalNote}
`);
}
