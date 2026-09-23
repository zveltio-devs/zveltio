import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';

/**
 * `ctx.internals` is declared twice: once in the SDK, which is what an
 * extension author compiles against, and once in the engine, which is what the
 * engine actually builds. Nothing tied the two together, and they had drifted
 * by six members — `checkAccess`, `applyColumnAccess`, `buildCondition`,
 * `deriveTokenHash`, `csvCell` and `recordsToCsv` all existed at runtime and
 * none of them were in the contract.
 *
 * The cost was not the missing autocomplete. Every caller reached them through
 * an `any` — `content/pages` types the whole helper bag that way — and that
 * `any` also switches off checking of the members that ARE declared, so the
 * one missing name takes the type safety of an entire call site with it.
 *
 * This test compares the names the SDK promises with the names the engine
 * builds. Adding a helper to `buildExtensionInternals` without declaring it
 * fails here.
 */
const SDK_SOURCE = new URL('../../../../sdk/src/extension/index.ts', import.meta.url).pathname;

function declaredInSdk(): string[] {
  const src = readFileSync(SDK_SOURCE, 'utf8');
  const start = src.indexOf('export interface ExtensionInternals');
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start);
  // The interface ends at the first line that is exactly `}`.
  const end = body.indexOf('\n}\n');
  expect(end).toBeGreaterThan(-1);
  // Members are the only things at exactly two spaces of indentation.
  return [...body.slice(0, end).matchAll(/^ {2}([a-zA-Z_][a-zA-Z0-9_]*)\??:/gm)].map((m) => m[1]);
}

describe('ctx.internals contract', () => {
  it('promises exactly what the engine builds', () => {
    const declared = declaredInSdk().sort();
    const built = Object.keys(buildExtensionInternals()).sort();
    expect(declared.length).toBeGreaterThan(20);
    expect(built.filter((n) => !declared.includes(n))).toEqual([]);
    expect(declared.filter((n) => !built.includes(n))).toEqual([]);
  });
});
