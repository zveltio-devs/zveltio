import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

export async function extensionCommand(
  action: 'create' | 'build',
  name: string,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  opts: Record<string, any>,
) {
  switch (action) {
    case 'create':
      await createExtension(name, opts.category || 'custom');
      break;
    case 'build':
      await buildExtension(opts);
      break;
  }
}

async function createExtension(name: string, category: string) {
  const safeName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const extName = `${category}/${safeName}`;
  const targetDir = join(process.cwd(), 'extensions', category, safeName);

  if (existsSync(targetDir)) {
    console.error(`Extension already exists: ${targetDir}`);
    process.exit(1);
  }

  console.log(`\nCreating extension: ${extName}\n`);

  // Create directory structure (v2 — no per-extension Studio build)
  await mkdir(join(targetDir, 'engine', 'migrations'), { recursive: true });
  await mkdir(join(targetDir, 'studio', 'pages'), { recursive: true });
  await mkdir(join(targetDir, 'studio', 'src', 'components'), { recursive: true });

  // manifest.json
  await writeFile(
    join(targetDir, 'manifest.json'),
    JSON.stringify(
      {
        name: extName,
        package: `@zveltio/ext-${safeName}`,
        category,
        displayName: name,
        description: `${name} extension for Zveltio`,
        version: '1.0.0',
        zveltioMinVersion: '1.0.0',
        zveltioMaxVersion: '4.0.0',
        permissions: ['database'],
        studio: {
          pages: [
            {
              path: `/admin/${safeName}`,
              label: name,
              icon: 'Puzzle',
            },
          ],
          navGroup: 'developer',
        },
        contributes: {
          engine: true,
          studio: true,
          fieldTypes: [],
          slots: [],
        },
      },
      null,
      2,
    ),
  );

  // engine/index.ts
  await writeFile(
    join(targetDir, 'engine', 'index.ts'),
    `import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';

const extension: ZveltioExtension = {
  name: '${extName}',
  category: '${category}',

  getMigrations() {
    return [
      join(import.meta.dir, 'migrations/001_init.sql'),
    ];
  },

  async register(app, ctx) {
    app.get('/ping', (c) => c.json({ pong: true, extension: '${extName}' }));
  },
};

export default extension;
`,
  );

  // engine/migrations/001_init.sql
  await writeFile(
    join(targetDir, 'engine', 'migrations', '001_init.sql'),
    `-- ${name} extension initial schema
-- Add your tables here

-- Example:
-- CREATE TABLE IF NOT EXISTS zv_${safeName.replace(/-/g, '_')} (
--   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--   name TEXT NOT NULL,
--   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
-- );
`,
  );

  // studio/pages/+page.svelte — tier-3 page synced into Studio at release
  await writeFile(
    join(targetDir, 'studio', 'pages', '+page.svelte'),
    `<script lang="ts">
  import { api } from '$lib/api.js';
</script>

<div class="space-y-6">
  <h1 class="text-2xl font-bold">${name}</h1>
  <p class="text-base-content/60">Welcome to the ${name} extension.</p>
  <p class="text-sm opacity-60">
    Engine route: <code>GET /ext/${extName}/ping</code>
  </p>
</div>
`,
  );

  // Optional slot contributions — see EXTENSION-AUTHORING.md § Studio slot contributions
  await writeFile(
    join(targetDir, 'studio', 'src', 'contribute.ts.example'),
    `/**
 * Rename to contribute.ts to register dashboard/settings slot widgets.
 * Synced by packages/studio/scripts/sync-extensions.ts — no studio/dist/ build.
 *
 * import { registerContributionSlot } from '$lib/extension-api.svelte.js';
 * import MyWidget from './components/MyWidget.svelte';
 *
 * export function activate(): void {
 *   registerContributionSlot('${extName}', 'dashboard.widgets', {
 *     component: MyWidget,
 *     priority: 100,
 *   });
 * }
 */
`,
  );

  // .gitattributes — keep the packed engine/index.js byte-identical
  await writeFile(
    join(targetDir, '.gitattributes'),
    `* text=auto eol=lf

# Packed engine bundle: byte-identical across OSes. Manifest
# integrity.engineSha256 is computed over these exact bytes.
engine/index.js binary
engine/index.js.map binary
`,
  );

  // .github/workflows/ci.yml
  await mkdir(join(targetDir, '.github', 'workflows'), { recursive: true });
  await writeFile(
    join(targetDir, '.github', 'workflows', 'ci.yml'),
    `name: Extension CI

on:
  push:
    branches: [main, master]
  pull_request:

jobs:
  pack-and-verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }

      - name: Install dependencies
        run: bun install

      - name: Pack extension (engine/index.ts → engine/index.js + manifest hash)
        run: bunx @zveltio/cli extension pack

      - name: Verify committed bundle matches manifest engineSha256
        run: |
          actual=$(sha256sum engine/index.js | awk '{print $1}')
          declared=$(node -e "console.log(require('./manifest.json').integrity?.engineSha256 ?? '')")
          if [ "$actual" != "$declared" ]; then
            echo "::error::Bundle hash $actual ≠ manifest engineSha256 $declared"
            echo "::error::Run \\\`bunx @zveltio/cli extension pack\\\` locally and commit the result."
            exit 1
          fi

      - name: Validate manifest + structure
        run: bunx @zveltio/cli extension validate
`,
  );

  console.log(`Extension scaffolded at extensions/${category}/${safeName}/

Structure (v2 — no studio/dist/ or per-extension vite):
  engine/
    index.ts          <- API routes (mounted at /ext/${extName}/*)
    migrations/       <- SQL migrations
  studio/
    pages/
      +page.svelte    <- tier-3 admin page (synced into Studio at release)
    src/
      components/     <- shared Svelte (optional)
      contribute.ts.example  <- rename to contribute.ts for slot widgets
  manifest.json
  .gitattributes
  .github/workflows/ci.yml

Next steps:
  1. Add business logic in engine/index.ts
  2. Build the admin UI in studio/pages/ (or add manifest.studio.pages[].schema for SDUI)
  3. Run \`bunx @zveltio/cli extension pack\` to produce engine/index.js + integrity hash
  4. For local Studio preview: sync into the monorepo (\`cd packages/studio && bun scripts/sync-extensions.ts\`)
     then \`bun run dev\` in packages/studio — see EXTENSION-DEVELOPER-GUIDE.md §2

Do NOT add studio/vite.config.ts, studio/package.json, or studio/dist/ — removed in alpha.94/beta.15.
`);
}

/**
 * `extension build` is a deprecated alias. The old pipeline produced a v1
 * artifact (`engine/dist/` via a bare `bun build`) that the beta+ engine
 * binary cannot load — it needs the v2 bundle (`engine/index.js` +
 * manifest integrity) from `extension pack`. Delegate to pack so anyone
 * still typing `build` gets a loadable artifact, and point them at pack.
 */

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
async function buildExtension(opts: Record<string, any>) {
  console.warn(
    '\x1b[33m`zveltio extension build` is deprecated — use `zveltio extension pack`.\x1b[0m',
  );
  console.warn(
    '\x1b[2m  Running pack for you (produces the v2 engine/index.js + integrity).\x1b[0m',
  );
  const { extensionPackCommand } = await import('./extension-pack.js');
  await extensionPackCommand({ dir: opts.dir });
}
