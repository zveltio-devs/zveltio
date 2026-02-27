import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

export async function extensionCommand(
  action: 'create' | 'build' | 'dev' | 'publish',
  name: string,
  opts: Record<string, any>,
) {
  switch (action) {
    case 'create':
      await createExtension(name, opts.category || 'custom');
      break;
    case 'build':
      await buildExtension();
      break;
    case 'dev':
      await devExtension();
      break;
    case 'publish':
      await publishExtension(opts.token);
      break;
  }
}

async function createExtension(name: string, category: string) {
  const safeName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const targetDir = join(process.cwd(), 'extensions', category, safeName);

  if (existsSync(targetDir)) {
    console.error(`❌ Extension already exists: ${targetDir}`);
    process.exit(1);
  }

  console.log(`\n🔌 Creating extension: ${category}/${safeName}\n`);

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
        zveltioMinVersion: '2.0.0',
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
      formats: ['es'],
      fileName: 'bundle',
    },
    rollupOptions: {
      external: ['svelte', 'svelte/internal', 'svelte/store'],
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

  console.log(`✅ Extension scaffolded at extensions/${category}/${safeName}/

Structure:
  engine/
    index.ts          ← API routes
    migrations/       ← SQL migrations
  studio/
    src/
      index.ts        ← Studio registration
      pages/          ← Svelte UI components
    vite.config.ts
  manifest.json

Next steps:
  1. Add your business logic in engine/index.ts
  2. Create your UI in studio/src/pages/
  3. Enable the extension: ZVELTIO_EXTENSIONS=${category}/${safeName}
`);
}

async function buildExtension() {
  console.log('\n📦 Building extension...\n');

  if (!existsSync('manifest.json')) {
    console.error('❌ No manifest.json found. Run this command from an extension directory.');
    process.exit(1);
  }

  const manifest = JSON.parse(await Bun.file('manifest.json').text());

  // Build Studio bundle
  if (existsSync('studio')) {
    const proc = spawn('bun', ['run', 'build'], {
      cwd: 'studio',
      stdio: 'inherit',
      shell: true,
    });
    await new Promise<void>((resolve, reject) => {
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Build failed: ${code}`))));
    });
    console.log('  ✓ Studio bundle built');
  }

  // Bundle engine TypeScript
  const proc = spawn('bun', ['build', 'engine/index.ts', '--outdir', 'engine/dist', '--target', 'bun'], {
    stdio: 'inherit',
    shell: true,
  });
  await new Promise<void>((resolve, reject) => {
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Engine build failed: ${code}`))));
  });
  console.log('  ✓ Engine built');

  console.log(`\n✅ Extension built: ${manifest.name} v${manifest.version}`);
}

async function devExtension() {
  console.log('\n🔧 Starting extension dev mode...\n');

  const studioProc = spawn('bun', ['run', 'dev'], {
    cwd: 'studio',
    stdio: 'inherit',
    shell: true,
  });

  console.log('  Studio: watching for changes...');

  process.on('SIGINT', () => {
    studioProc.kill('SIGINT');
    process.exit(0);
  });
}

async function publishExtension(token?: string) {
  if (!token) {
    console.error('❌ Marketplace token required. Use --token <token>');
    process.exit(1);
  }
  console.log('\n📤 Publishing to Zveltio marketplace...');
  console.log('  (Marketplace coming soon!)');
}
