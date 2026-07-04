import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

export async function extensionCommand(
  action: 'create' | 'build' | 'dev',
  name: string,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  opts: Record<string, any>,
) {
  switch (action) {
    case 'create':
      await createExtension(name, opts.category || 'custom');
      break;
    case 'build':
      await buildExtension(opts);
      break;
    case 'dev':
      await devExtension();
      break;
  }
}

async function createExtension(name: string, category: string) {
  const safeName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const targetDir = join(process.cwd(), 'extensions', category, safeName);

  if (existsSync(targetDir)) {
    console.error(`Extension already exists: ${targetDir}`);
    process.exit(1);
  }

  console.log(`\nCreating extension: ${category}/${safeName}\n`);

  // Create directory structure
  await mkdir(join(targetDir, 'engine'), { recursive: true });
  await mkdir(join(targetDir, 'studio', 'src', 'pages'), { recursive: true });
  await mkdir(join(targetDir, 'engine', 'migrations'), { recursive: true });

  // manifest.json
  await writeFile(
    join(targetDir, 'manifest.json'),
    JSON.stringify(
      {
        name: safeName,
        package: `@zveltio/ext-${safeName}`,
        category,
        displayName: name,
        description: `${name} extension for Zveltio`,
        version: '1.0.0',
        // Broad, current-line compatible: matches the first-party
        // extensions ([1.0.0, 4.0.0]) so a freshly scaffolded extension
        // loads on the 3.x engine. Bump the max when the platform nears 4.0.
        zveltioMinVersion: '1.0.0',
        zveltioMaxVersion: '4.0.0',
        permissions: ['database'],
        contributes: { engine: true, studio: true, fieldTypes: [] },
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
  name: '${category}/${safeName}',
  category: '${category}',

  getMigrations() {
    return [
      join(import.meta.dir, 'migrations/001_init.sql'),
    ];
  },

  async register(app, ctx) {
    // Register your API routes here
    app.get('/api/${safeName}/ping', (c) => c.json({ pong: true }));
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

  // studio/src/index.ts
  await writeFile(
    join(targetDir, 'studio', 'src', 'index.ts'),
    `import MainPage from './pages/MainPage.svelte';

export default function register() {
  const zveltio = (window as any).__zveltio;
  if (!zveltio) {
    console.error('Zveltio Studio API not available');
    return;
  }

  zveltio.registerRoute({
    path: '${safeName}',
    component: MainPage,
    label: '${name}',
    icon: 'Puzzle',
    category: '${category}',
  });
}
`,
  );

  // studio/src/pages/MainPage.svelte
  await writeFile(
    join(targetDir, 'studio', 'src', 'pages', 'MainPage.svelte'),
    `<script lang="ts">
  const engineUrl = (window as any).__ZVELTIO_ENGINE_URL__;
</script>

<div class="space-y-6">
  <h1 class="text-2xl font-bold">${name}</h1>
  <p class="text-base-content/60">Welcome to the ${name} extension.</p>
</div>
`,
  );

  // studio/vite.config.ts
  await writeFile(
    join(targetDir, 'studio', 'vite.config.ts'),
    `import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['iife'],
      fileName: () => 'bundle.js',
    },
    rollupOptions: {
      external: ['svelte', 'svelte/internal', 'svelte/store'],
      output: {
        globals: {
          'svelte': 'window.__SvelteRuntime?.svelte',
          'svelte/internal': 'window.__SvelteRuntime?.internal',
          'svelte/store': 'window.__SvelteRuntime?.store',
        },
      },
    },
  },
});
`,
  );

  // studio/package.json
  await writeFile(
    join(targetDir, 'studio', 'package.json'),
    JSON.stringify(
      {
        name: `@zveltio/ext-${safeName}-studio`,
        version: '1.0.0',
        type: 'module',
        scripts: {
          build: 'vite build',
          dev: 'vite build --watch',
        },
        dependencies: { svelte: '^5.0.0' },
        devDependencies: {
          '@sveltejs/vite-plugin-svelte': '^4.0.0',
          vite: '^6.0.0',
        },
      },
      null,
      2,
    ),
  );

  // .gitattributes — keep the packed engine/index.js byte-identical
  // across Windows / macOS / Linux checkouts. Without this, autocrlf
  // mutates the bundle bytes and the manifest's engineSha256 stops
  // matching what's on disk. This is the same protection
  // zveltio-extensions ships across all 54 official packs.
  await writeFile(
    join(targetDir, '.gitattributes'),
    `* text=auto eol=lf

# Packed engine bundle: byte-identical across OSes. Manifest
# integrity.engineSha256 is computed over these exact bytes.
engine/index.js binary
engine/index.js.map binary
`,
  );

  // .github/workflows/ci.yml — minimal CI that proves the extension
  // builds, packs cleanly, and the committed bundle matches the
  // declared engineSha256. Required for marketplace submission.
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
        # If pack changed engine/index.js, the committed bytes drift
        # from manifest.integrity.engineSha256. The publishing pipeline
        # would reject this — fail PR before merging.
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

Structure:
  engine/
    index.ts          <- API routes
    migrations/       <- SQL migrations
  studio/
    src/
      index.ts        <- Studio registration
      pages/          <- Svelte UI components
    vite.config.ts
  manifest.json
  .gitattributes      <- pins engine/index.js as binary (no EOL conversion)
  .github/workflows/
    ci.yml            <- pack + hash verify + validate on every PR

Next steps:
  1. Add your business logic in engine/index.ts
  2. Create your UI in studio/src/pages/
  3. Run \`bunx @zveltio/cli extension pack\` to build the bundle
  4. Enable the extension: ZVELTIO_EXTENSIONS=${category}/${safeName}

Isolation (MARKETPLACE-POLICY §2):
  Community publishers MUST run in worker isolation. \`extension pack\`
  auto-sets "engine": { ..., "isolation": "worker" } for you unless it can
  confirm you're a verified/first-party publisher (via --first-party or a
  registry token). Worker mode = Bun.Worker with crash isolation and no
  direct DB credentials.

  First-party / vendor builds that want inline isolation: pack with
  --first-party. See https://github.com/zveltio-devs/zveltio/blob/master/docs/EXTENSION-DEVELOPER-GUIDE.md#135-isolation-tiers-be-honest-about-what-you-ship
`);
}

/**
 * `extension build` is a deprecated alias. The old pipeline produced a v1
 * artifact (`engine/dist/` via a bare `bun build`) that the beta+ engine
 * binary cannot load — it needs the v2 bundle (`engine/index.js` +
 * manifest integrity) from `extension pack`. Delegate to pack so anyone
 * still typing `build` gets a loadable artifact, and point them at pack.
 */

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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

async function devExtension() {
  console.log('\nStarting extension dev mode...\n');

  const studioProc = Bun.spawn(['bun', 'run', 'dev'], {
    cwd: 'studio',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  console.log('  Studio: watching for changes...');

  process.on('SIGINT', () => {
    studioProc.kill();
    process.exit(0);
  });

  await studioProc.exited;
}
