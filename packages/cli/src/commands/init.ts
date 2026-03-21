import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export async function initCommand(
  name: string = '.',
  _opts: { template?: string } = {},
) {
  const dir = name === '.' ? process.cwd() : join(process.cwd(), name);
  const projectName = dir.split(/[/\\]/).pop() || 'zveltio-app';

  if (name !== '.' && existsSync(dir)) {
    console.error(`❌ Directory "${name}" already exists`);
    process.exit(1);
  }

  mkdirSync(dir, { recursive: true });

  // Generate random credentials — avoids developers accidentally using 'password' in prod
  const dbPassword  = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const s3AccessKey = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const s3SecretKey = crypto.randomUUID().replace(/-/g, '');
  const authSecret  = crypto.randomUUID().replace(/-/g, '');

  writeFileSync(
    join(dir, '.env'),
    [
      '# ⚠️  NEVER commit this file to git — it contains secrets.',
      '# For production, replace ALL values with strong credentials.',
      `DATABASE_URL=postgresql://zveltio:${dbPassword}@localhost:5432/${projectName}`,
      'PORT=3000',
      `BETTER_AUTH_SECRET=${authSecret}`,
      'VALKEY_URL=redis://localhost:6379',
      'S3_ENDPOINT=http://localhost:8333',
      'S3_BUCKET=zveltio',
      `S3_ACCESS_KEY=${s3AccessKey}`,
      `S3_SECRET_KEY=${s3SecretKey}`,
      'ZVELTIO_EXTENSIONS=',
      '',
    ].join('\n'),
  );

  writeFileSync(
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
      'ZVELTIO_EXTENSIONS=',
      '',
    ].join('\n'),
  );

  writeFileSync(
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

  writeFileSync(
    join(dir, 'docker-compose.yml'),
    `version: '3.8'
services:
  db:
    image: postgis/postgis:16-3.4-alpine
    environment:
      POSTGRES_DB: ${projectName}
      POSTGRES_USER: zveltio
      POSTGRES_PASSWORD: ${dbPassword}
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  valkey:
    image: valkey/valkey:7-alpine
    ports:
      - "6379:6379"

volumes:
  pgdata:
`,
  );

  writeFileSync(
    join(dir, '.gitignore'),
    [
      '.env',
      'node_modules/',
      'dist/',
      '.DS_Store',
      '*.local',
      '',
    ].join('\n'),
  );

  console.log(`✅ Zveltio project "${projectName}" initialized at ${dir}`);
  console.log(
    `\nNext steps:\n  ${name !== '.' ? `cd ${name}\n  ` : ''}docker compose up -d\n  bun install\n  zveltio dev\n`,
  );
  console.log('Open http://localhost:3000/admin to access the Studio.');
}
