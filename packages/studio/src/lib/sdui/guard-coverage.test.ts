import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every mutating call in the renderer must use a URL that the namespace guard
 * has seen. Two did not: the lookup POST (`f.lookup.endpoint`) and the form's
 * preview POST (`ep`) — the second one inside a function whose *other* URL was
 * guarded, which is how a guard ends up covering one path and missing the next
 * one added beside it.
 *
 * A source scan rather than a render test: the point is to fail when a NEW
 * mutation is added unguarded, which no behavioural test can see.
 */
const SOURCE = readFileSync('src/lib/sdui/SchemaPage.svelte', 'utf8');

const MUTATION = /\bapi\.(?:post|patch|put|delete|fetch)\s*\(\s*([^,)]+)/g;
const GUARDED = /\bguardMutation\(\s*([^)]+?)\s*\)/g;

/** Split the script body into top-level function blocks. */
function functionBlocks(src: string): { name: string; body: string }[] {
  const starts: { name: string; at: number }[] = [];
  const re = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    starts.push({ name: m[1], at: m.index });
  }
  return starts.map((s, i) => ({
    name: s.name,
    body: src.slice(s.at, starts[i + 1]?.at ?? src.length),
  }));
}

/** The url expressions inside a `guardMutation(...)` argument, minus the plumbing. */
const PLUMBING = new Set(['fillEndpoint', 'formData', 'String', 'endpointTokens']);
function urlRoots(arg: string): string[] {
  const tokens = arg.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g) ?? [];
  return tokens.filter((t) => !PLUMBING.has(t));
}

function unguardedCalls(): string[] {
  const out: string[] = [];
  for (const block of functionBlocks(SOURCE)) {
    const guarded = [...block.body.matchAll(GUARDED)].flatMap((m) => urlRoots(m[1]));
    for (const m of block.body.matchAll(MUTATION)) {
      const arg = m[1].trim();
      // Guarded directly, or built from something that was guarded:
      // `guardMutation(fillEndpoint(F.endpoint, …))` covers a later
      // `api.patch(`${F.endpoint}/${id}`)` in the same function.
      const ok = guarded.some((g) => arg.includes(g));
      if (!ok) out.push(`${block.name}: ${arg}`);
    }
  }
  return out;
}

describe('SchemaPage mutation guard coverage', () => {
  it('found the mutating calls at all (the scan is not vacuously green)', () => {
    const total = [...SOURCE.matchAll(MUTATION)].length;
    expect(total).toBeGreaterThanOrEqual(10);
  });

  it('guards the URL of every mutation made through the API client', () => {
    expect(unguardedCalls()).toEqual([]);
  });
});
