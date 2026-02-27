import { mkdir, writeFile, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

export async function initCommand(dir: string = '.', opts: { template?: string }) {
  const targetDir = dir === '.' ? process.cwd() : join(process.cwd(), dir);
  const projectName = targetDir.split('/').pop() || 'zveltio-app';

  console.log(`\n🚀 Creating Zveltio project: ${projectName}\n`);

  if (!existsSync(targetDir)) {
    await mkdir(targetDir, { recursive: true });
  }

  // .env
  await writeFile(
    join(targetDir, '.env'),
    `DATABASE_URL=postgresql://postgres:password@localhost:5432/${projectName}
PORT=3000
BETTER_AUTH_SECRET=${crypto.randomUUID().replace(/-/g, '')}
ZVELTIO_EXTENSIONS=
`,
  );

  console.log('  ✓ .env created');

  // docker-compose.yml for local development
  await writeFile(
    join(targetDir, 'docker-compose.yml'),
    `version: '3.8'
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: ${projectName}
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: valkey/valkey:7-alpine
    ports:
      - "6379:6379"

volumes:
  pgdata:
`,
  );

  console.log('  ✓ docker-compose.yml created');

  // README
  await writeFile(
    join(targetDir, 'README.md'),
    `# ${projectName}

A Zveltio-powered application.

## Getting started

\`\`\`bash
# Start database
docker compose up -d

# Install dependencies and start
pnpm install
pnpm dev
\`\`\`

## Admin

Open [http://localhost:3000/admin](http://localhost:3000/admin)
`,
  );

  console.log('  ✓ README.md created');

  console.log(`
✨ Done! Your project is ready.

Next steps:
  ${dir !== '.' ? `cd ${dir}` : ''}
  docker compose up -d
  zveltio dev

Open http://localhost:3000/admin to access the Studio.
`);
}
