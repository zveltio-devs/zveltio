# Node.js 22 LTS Fallback

Zveltio is built on **Bun** as its primary runtime. This page documents the fallback
path for enterprise environments where Bun is not approved or available.

## Why Bun is the default

- ~3× faster startup time than Node.js
- Native TypeScript support without a separate transpilation step
- Integrated package manager (`bun install`)
- Native APIs: `Bun.serve()`, `Bun.file()`, native WebSocket
- Native SQLite via `bun:sqlite`

---

## Node.js 22 LTS compatibility

The Zveltio Engine is compatible with Node.js 22 LTS with minimal changes.

### Dependencies requiring attention

| Dependency | Status on Node.js 22 | Action required |
|-----------|----------------------|-----------------|
| Hono 4.x | ✅ Compatible | No change |
| Kysely 0.27 | ✅ Compatible | No change |
| Better-Auth 1.3 | ✅ Compatible | No change |
| Casbin 5.30 | ✅ Compatible | No change |
| ioredis 5.x | ✅ Compatible | No change |
| imapflow | ✅ Compatible | No change |
| nodemailer | ✅ Compatible | No change |
| `bun:sqlite` | ❌ Bun-only | Not used in engine core |
| `Bun.serve()` | ❌ Bun-only | Replace with `@hono/node-server` |
| `Bun.file()` | ❌ Bun-only | Replace with `fs/promises` |
| `Bun.spawn()` | ❌ Bun-only | Replace with `child_process` |

---

## Changes required for Node.js 22

### 1. Server startup — `packages/engine/src/index.ts`

Replace:
```typescript
// BUN (default):
import { serve } from '@hono/bun';
serve({ fetch: app.fetch, port: PORT });
```

With:
```typescript
// NODE.JS 22 fallback:
import { serve } from '@hono/node-server';
serve({ fetch: app.fetch, port: PORT });
```

### 2. Add the dependency to `packages/engine/package.json`

```json
"optionalDependencies": {
  "@hono/node-server": "^1.12.0"
}
```

### 3. File I/O and process spawning

Replace `Bun.file(path).text()` with:
```typescript
import { readFile } from 'fs/promises';
const content = await readFile(path, 'utf-8');
```

Replace `Bun.spawn(...)` (used in extension-loader and sandbox) with:
```typescript
import { spawn } from 'child_process';
```

---

## Running on Node.js 22

```bash
# Install dependencies (npm / pnpm / yarn)
npm install
# or
pnpm install

# Optional environment flag
export ZVELTIO_RUNTIME=node

# Start with native type stripping (no build step)
node --experimental-strip-types packages/engine/src/index.ts

# Recommended alternative — tsx (more stable):
npx tsx packages/engine/src/index.ts

# Alternative — ts-node:
npx ts-node --esm packages/engine/src/index.ts
```

---

## CI/CD on Node.js 22

Example GitHub Actions step:

```yaml
- name: Set up Node.js 22
  uses: actions/setup-node@v4
  with:
    node-version: '22'

- name: Install dependencies
  run: npm install

- name: Start engine (Node.js fallback)
  run: |
    npm install -g tsx
    tsx packages/engine/src/index.ts &
    sleep 5

- name: Run integration tests
  env:
    TEST_DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}
  run: npx vitest run packages/engine/src/tests/integration/
```

---

## Limitations on Node.js 22

1. **Slower startup** — Node.js 22 starts ~3× slower than Bun
2. **TypeScript stripping** — `--experimental-strip-types` does not support decorators or advanced transforms; use `tsx` for maximum compatibility
3. **Extension sandbox** — the `developer/edge-functions` extension uses `Bun.spawn()` internally; running on Node.js requires refactoring the sandbox
4. **Package manager** — `bun install` is unavailable; use `npm` or `pnpm`

---

## Enterprise recommendation

If your organisation cannot approve Bun as a production runtime:

1. Use Node.js 22 LTS with the fallback documented above
2. Disable the `developer/edge-functions` extension (requires the Bun sandbox)
3. Report any incompatibilities as issues in the repository
4. Use `tsx` (recommended) or `--experimental-strip-types` for TypeScript execution

**Bun remains the primary recommended and tested runtime.**
