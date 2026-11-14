import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
// Inlined by `bun build`, as in index.ts: the engine version this CLI ships with.
import pkg from '../../package.json' with { type: 'json' };

export async function extensionCommand(
  action: 'create' | 'build',
  name: string,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
 * Scaffold a new extension in the declared model.
 *
 * An extension declares collections and actions; the engine creates and owns
 * the collections, serves them through the data API and its rules decide who
 * reads and writes them (ADR 0002). Business logic is an action, run as the
 * caller through `host.collections`. The page is a `zveltio.view/2` document,
 * data that every front end draws (ADR 0042). So the scaffold writes no SQL,
 * no Hono route, no `ctx.db` and no Svelte: what it writes is what a shipped
 * extension (`crm`) looks like.
 */
async function createExtension(name: string, category: string, codePage: boolean) {
  if (codePage) {
    // ADR 0042: no extension code runs in a browser. A screen a view cannot
    // express is a front-end package, outside the extension.
    console.error(`--code-page is withdrawn: an extension's UI is data only (ADR 0042).
A screen a view cannot express is a request for a view kind, or a front-end
package outside the extension. See docs/extensions/ui-model.md.`);
    process.exit(1);
  }
  const safeName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const extName = `${category}/${safeName}`;
  // Collection names are instance-wide; prefixing with the extension keeps
  // two extensions from claiming the same one.
  const collection = `${safeName.replace(/-/g, '_')}_items`;
  const targetDir = join(process.cwd(), 'extensions', category, safeName);

  if (existsSync(targetDir)) {
    console.error(`Extension already exists: ${targetDir}`);
    process.exit(1);
  }

  console.log(`\nCreating extension: ${extName}\n`);

  await mkdir(join(targetDir, 'engine'), { recursive: true });
  await mkdir(join(targetDir, 'schema', 'collections'), { recursive: true });
  await mkdir(join(targetDir, 'studio', 'schemas'), { recursive: true });
  await mkdir(join(targetDir, 'studio', 'messages'), { recursive: true });

  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

  await writeFile(
    join(targetDir, 'manifest.json'),
    json({
      name: extName,
      package: `@zveltio/ext-${safeName}`,
      category,
      displayName: name,
      description: `${name} extension for Zveltio`,
      version: '1.0.0',
      // The engine this CLI ships with: view/2 pages and declared
      // collections need a recent one.
      zveltioMinVersion: pkg.version,
      zveltioMaxVersion: '4.0.0',
      permissions: ['data:write'],
      collections: [collection],
      actions: [
        {
          name: 'markDone',
          permission: { resource: collection },
          input: {
            type: 'object',
            required: ['id'],
            additionalProperties: false,
            properties: { id: { type: 'string', format: 'uuid' } },
          },
          reads: [collection],
          writes: [collection],
        },
      ],
      studio: {
        pages: [
          {
            path: `/admin/${safeName}`,
            label: name,
            icon: 'Puzzle',
            schema: `schemas/${safeName}.json`,
          },
        ],
        navGroup: 'developer',
      },
      contributes: { engine: true, studio: true, fieldTypes: [], slots: [] },
    }),
  );

  // The collection: the engine creates the table, its tenant isolation, its
  // grants and its data API routes when the extension is enabled.
  await writeFile(
    join(targetDir, 'schema', 'collections', `${collection}.json`),
    json({
      name: collection,
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'done', type: 'boolean', required: true, defaultValue: false },
      ],
    }),
  );

  await writeFile(
    join(targetDir, 'engine', 'index.ts'),
    `import { ActionRefusal, defineExtension } from '@zveltio/sdk/extension';

// The capabilities this extension uses: the same list as "permissions" in
// manifest.json (\`zveltio extension validate\` compares them).
export default defineExtension(['data:write'], {
  name: '${extName}',
  category: '${category}',

  // Business logic is an action: \`POST /ext/${extName}/actions/markDone\`.
  // The engine checks the caller holds the manifest's \`permission\` and that
  // the body matches \`input\`, then runs it as the caller, inside the request
  // transaction. \`host.collections\` is the data API: the collection's
  // permissions, row and column rules, revisions and audit all apply.
  actions: {
    async markDone(input, host) {
      const { id } = input as { id: string };
      const item = await host.collections.read('${collection}', id);
      if (!item) throw new ActionRefusal(404, 'item_not_found', 'No such item.');
      if (item.done) throw new ActionRefusal(409, 'already_done', 'This item is already done.');
      // \`expect\` re-checks \`done\` on the locked row: of two concurrent calls,
      // the second is refused with 409.
      return host.collections.update('${collection}', id, { done: true }, { expect: { done: [false] } });
    },
  },

  async register() {},
});
`,
  );

  // The page: a view/2 document. Names, not addresses — the collection, its
  // fields and the action; each front end draws it.
  await writeFile(
    join(targetDir, 'studio', 'schemas', `${safeName}.json`),
    json({
      spec: 'zveltio.view/2',
      id: `${safeName}.items`,
      title: `${safeName}.title`,
      type: 'list',
      collection,
      fields: [
        { field: 'name', label: 'common.col.name' },
        { field: 'done', label: `${safeName}.col.done` },
        { field: 'created_at', label: 'common.col.created' },
      ],
      sort: '-created_at',
      search: true,
      create: true,
      edit: true,
      delete: true,
      rowActions: [
        {
          action: 'markDone',
          label: `${safeName}.action.markDone`,
          input: { id: { $record: 'id' } },
          when: [{ field: 'done', op: 'eq', value: false }],
        },
      ],
    }),
  );

  // The keys this view owns. `common.*` comes from the host's shared
  // vocabulary and must NOT be repeated here; other locales are filled from en.
  await writeFile(
    join(targetDir, 'studio', 'messages', 'en.json'),
    json({
      [`${safeName}.title`]: name,
      [`${safeName}.col.done`]: 'Done',
      [`${safeName}.action.markDone`]: 'Mark done',
    }),
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

      # Validate FIRST, on the COMMITTED bundle. It checks the bundle against
      # manifest integrity.engineSha256 and against the source it was built
      # from, so a bundle nobody repacked fails here. Running pack before this
      # would rewrite both hashes and the check could never fail.
      - name: Validate committed bundle, manifest + structure
        run: bunx @zveltio/cli extension validate

      - name: Pack extension (engine/index.ts → engine/index.js + manifest hash)
        run: bunx @zveltio/cli extension pack
`,
  );

  console.log(`Extension scaffolded at extensions/${category}/${safeName}/

  manifest.json       <- collections, actions, the page
  schema/collections/
    ${collection}.json  <- the engine creates and owns it
  engine/
    index.ts          <- actions (business logic, run as the caller)
  studio/
    schemas/
      ${safeName}.json  <- THE PAGE, a zveltio.view/2 document
    messages/
      en.json         <- keys this view owns; other locales filled from en
  .gitattributes
  .github/workflows/ci.yml

Next steps:
  1. Shape the collection in schema/collections/${collection}.json
  2. Put business rules in actions (engine/index.ts) and declare each one in
     manifest.json "actions"
  3. \`bunx @zveltio/cli extension pack\` — engine/index.js + integrity
  4. \`bunx @zveltio/cli extension validate\` — manifest, collections, the
     view against them, and the message keys

Read docs/extensions/authoring.md (the contract) and ui-model.md (the page).
`);
}

/**
 * `extension build` is a deprecated alias. The old pipeline produced a v1
 * artifact (`engine/dist/` via a bare `bun build`) that the beta+ engine
 * binary cannot load — it needs the v2 bundle (`engine/index.js` +
 * manifest integrity) from `extension pack`. Delegate to pack so anyone
 * still typing `build` gets a loadable artifact, and point them at pack.
 */

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
