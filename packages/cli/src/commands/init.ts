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

  writeFileSync(
    join(dir, '.env'),
    [
      `DATABASE_URL=postgresql://admin:password@localhost:5432/${projectName}`,
      'PORT=3000',
      `BETTER_AUTH_SECRET=${crypto.randomUUID().replace(/-/g, '')}`,
      'VALKEY_URL=redis://localhost:6379',
      'S3_ENDPOINT=http://localhost:8333',
      'S3_BUCKET=zveltio',
      'S3_ACCESS_KEY=admin',
      'S3_SECRET_KEY=password',
      'ZVELTIO_EXTENSIONS=',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(dir, '.env.example'),
    [
      'DATABASE_URL=postgresql://user:pass@localhost:5432/dbname',
      'PORT=3000',
      'BETTER_AUTH_SECRET=changeme',
      'VALKEY_URL=redis://localhost:6379',
      'S3_ENDPOINT=http://localhost:8333',
      'S3_BUCKET=zveltio',
      'S3_ACCESS_KEY=admin',
      'S3_SECRET_KEY=password',
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
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: ${projectName}
      POSTGRES_USER: admin
      POSTGRES_PASSWORD: password
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

  console.log(`✅ Zveltio project "${projectName}" initialized at ${dir}`);
  console.log(
    `\nNext steps:\n  ${name !== '.' ? `cd ${name}\n  ` : ''}docker compose up -d\n  bun install\n  zveltio dev\n`,
  );
  console.log('Open http://localhost:3000/admin to access the Studio.');
}
