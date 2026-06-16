import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PEER_DEPS_ALLOWLIST as cliList } from '../commands/extension-validate.js';

// The engine is the canonical owner of the peer-deps allowlist. The CLI
// keeps an inline copy so `extension validate` doesn't reach into engine
// internals at runtime. This is the safety net the inline comment promises:
// if the two lists drift, fail here instead of letting a peer dep pass
// `validate` but get rejected at install (or vice versa).
//
// We read the engine source as TEXT rather than importing it — a static
// import across packages trips tsc's rootDir constraint (TS6059) and would
// break the CLI typecheck job. Parsing the `new Set([...])` string literals
// is enough to detect drift.
function readEngineAllowlist(): string[] {
  const enginePath = join(
    import.meta.dir,
    '..',
    '..',
    '..',
    'engine',
    'src',
    'lib',
    'peer-deps-allowlist.ts',
  );
  const src = readFileSync(enginePath, 'utf8');
  const setBody = src.match(/new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
  return [...setBody.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

describe('peer-deps allowlist drift (CLI ↔ engine)', () => {
  it('the CLI allowlist matches the engine allowlist exactly', () => {
    const engine = readEngineAllowlist().sort();
    const cli = [...cliList].sort();
    expect(engine.length).toBeGreaterThan(0); // guards against a parse miss
    expect(cli).toEqual(engine);
  });
});
