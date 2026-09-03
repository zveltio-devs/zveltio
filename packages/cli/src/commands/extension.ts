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
      await createExtension(name, opts.category || 'custom', opts.codePage === true);
      break;
    case 'build':
      await buildExtension(opts);
      break;
  }
}

/**
 * Scaffold a new extension.
 *
 * The default page is an SDUI schema, not a Svelte file. That is not a style
 * preference — across the 56 shipped extensions there are 61 schemas and seven
 * code pages, and every one of those seven sits BESIDE a schema rather than
 * instead of it. A scaffold that opened with
 * `studio/pages/+page.svelte` and mentioned schemas in a parenthesis taught
 * every new author the 2% path first.
 *
 * `--code-page` still produces the Svelte page, for the UI a schema genuinely
 * cannot express (canvas, chat, map, inbox). It prints why it is the rare road.
 */
async function createExtension(name: string, category: string, codePage: boolean) {
  const safeName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const extName = `${category}/${safeName}`;
  // Extension-owned table namespace; `-` is not legal unquoted in an identifier.
  const table = `zv_${safeName.replace(/-/g, '_')}_items`;
  const targetDir = join(process.cwd(), 'extensions', category, safeName);

  if (existsSync(targetDir)) {
    console.error(`Extension already exists: ${targetDir}`);
    process.exit(1);
  }

  console.log(`\nCreating extension: ${extName}\n`);

  // Create directory structure (v2 — no per-extension Studio build)
  await mkdir(join(targetDir, 'engine', 'migrations'), { recursive: true });
  await mkdir(join(targetDir, 'studio', 'src', 'components'), { recursive: true });
  if (codePage) {
    await mkdir(join(targetDir, 'studio', 'pages'), { recursive: true });
  } else {
    await mkdir(join(targetDir, 'studio', 'schemas'), { recursive: true });
    await mkdir(join(targetDir, 'studio', 'messages'), { recursive: true });
  }

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
              // The page IS this file. Drop the key only for a code page.
              ...(codePage ? {} : { schema: `schemas/${safeName}.json` }),
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
    // The route the generated page reads. ctx.db resolves the caller's tenant
    // transaction, so this returns only that tenant's rows.
    app.get('/items', async (c) => {
      const data = await ctx.db
        .selectFrom('${table}')
        .selectAll()
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute();
      return c.json({ data });
    });
  },
};

export default extension;
`,
  );

  // engine/migrations/001_init.sql
  await writeFile(
    join(targetDir, 'engine', 'migrations', '001_init.sql'),
    `-- ${name} — initial schema.
--
-- Tenant isolation is not optional and not something to add later: a table
-- without it is readable by every tenant on the instance. The three parts below
-- are the whole pattern.

CREATE TABLE IF NOT EXISTS ${table} (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  -- 1. The column, defaulting to the tenant of the transaction doing the write,
  --    so application code never has to name it (and cannot forge it).
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid,
    '00000000-0000-0000-0000-000000000001'::uuid
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${table}_tenant ON ${table}(tenant_id);

-- 2. FORCE matters. Without it Postgres lets the table owner bypass the policy,
--    and the engine connects as owner on a stock install — RLS becomes advisory.
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;

-- 3. The host's own predicate, not a hand-rolled copy: reads and writes agree
--    with the column DEFAULT above, and the engine reconciles every policy
--    named \`tenant_isolation_*\` onto it at boot.
DROP POLICY IF EXISTS tenant_isolation_${table} ON ${table};
CREATE POLICY tenant_isolation_${table} ON ${table}
  USING (tenant_id = ANY (zveltio_visible_tenants()))
  WITH CHECK (zveltio_tenant_write_ok(tenant_id));
`,
  );

  if (codePage) {
    // studio/pages/+page.svelte — a code page, synced into Studio at release.
    await writeFile(
      join(targetDir, 'studio', 'pages', '+page.svelte'),
      `<script lang="ts">
  import { api } from '$lib/api.js';

  // A code page owns its fetching, loading and error states, and its strings
  // have to reach i18n by hand. A schema gets all three from the host — worth
  // re-checking that this page really needs to be code.
  let items = $state<Array<{ id: string; name: string }>>([]);

  $effect(() => {
    api
      .get<{ data: Array<{ id: string; name: string }> }>('/ext/${extName}/items')
      .then((r) => {
        items = r.data;
      });
  });
</script>

<div class="space-y-6">
  <h1 class="text-2xl font-bold">${name}</h1>
  {#each items as item (item.id)}
    <div>{item.name}</div>
  {/each}
</div>
`,
    );
  } else {
    // studio/schemas/<name>.json — this IS the page. Rendered by the host.
    await writeFile(
      join(targetDir, 'studio', 'schemas', `${safeName}.json`),
      `${JSON.stringify(
        {
          sduiSchema: 1,
          title: `${safeName}.title`,
          subtitle: `${safeName}.subtitle`,
          resources: [
            {
              id: 'items',
              // Must name a route this extension serves, inside its own
              // /ext/<name>/ namespace — `extension validate` checks both.
              dataSource: `/ext/${extName}/items`,
              dataPath: 'data',
              search: { fields: ['name'], placeholder: 'common.search' },
              columns: [
                { key: 'name', label: 'common.col.name' },
                { key: 'created_at', label: 'common.col.created', type: 'date' },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    // studio/messages/en.json — the keys this schema owns. `common.*` comes
    // from the host's shared vocabulary and must NOT be repeated here. Other
    // locales are filled from `en` by the merge step.
    await writeFile(
      join(targetDir, 'studio', 'messages', 'en.json'),
      `${JSON.stringify(
        {
          [`${safeName}.title`]: name,
          [`${safeName}.subtitle`]: `Manage ${name.toLowerCase()} records`,
        },
        null,
        2,
      )}\n`,
    );
  }

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

  const pageLines = codePage
    ? `    pages/
      +page.svelte    <- code page (synced into Studio at release)`
    : `    schemas/
      ${safeName}.json  <- THE PAGE (rendered by the host; no build step)
    messages/
      en.json         <- keys this schema owns; other locales filled from en`;

  console.log(`Extension scaffolded at extensions/${category}/${safeName}/

  engine/
    index.ts          <- API routes (mounted at /ext/${extName}/*)
    migrations/       <- SQL, with tenant isolation already wired
  studio/
${pageLines}
    src/
      components/     <- shared Svelte (optional)
      contribute.ts.example  <- rename to contribute.ts for a dashboard widget
  manifest.json
  .gitattributes
  .github/workflows/ci.yml

Next steps:
  1. Put your logic in engine/index.ts — that is where the truth lives
  2. ${
    codePage
      ? 'Write the page in studio/pages/+page.svelte'
      : `Shape the page in studio/schemas/${safeName}.json`
  }
  3. \`bunx @zveltio/cli extension pack\` — produces engine/index.js + integrity
     (validate needs this: it rejects a manifest with no engine block)
  4. \`bunx @zveltio/cli extension validate\`${
    codePage
      ? ' — manifest, migrations and bundle'
      : ` — checks the schema against the
     routes you actually serve, and the message keys against what you ship`
  }
  5. Local preview: \`cd packages/studio && bun scripts/sync-extensions.ts\`,
     then \`bun run dev\` — see developer-guide.md §2

Where UI goes:
  a page                    -> studio/schemas/*.json          (almost always)
  a widget on the dashboard -> studio/src/contribute.ts        (occasionally)
  canvas / chat / map / IDE -> studio/pages/+page.svelte       (rarely)

Do NOT add studio/vite.config.ts, studio/package.json, or studio/dist/ — removed in alpha.94/beta.15.
`);

  if (codePage) {
    console.warn(
      `\x1b[33mScaffolded a CODE page. Across the 56 shipped extensions, 61 pages are
schemas and seven are code — and each of those seven sits beside a schema, for
the part a schema could not express. On this road you own fetching,
loading and error states, i18n by hand, and a Studio release to ship a change.
Worth it for a canvas, a chat, a map or an inbox — for a list, a form or
settings, delete studio/pages/ and add \`schema\` back to manifest.studio.pages[0].\x1b[0m`,
    );
  }
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
