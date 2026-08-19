import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { EXECUTABLE_STEP_TYPES } from '../../lib/flows/flow-executor.js';

/**
 * C-6 — the Studio offered six flow step types and the executor implemented
 * three of them. The other three, including `condition`, hit a `default` arm
 * that returned the previous step's output and reported success.
 *
 * A flow reading "when an invoice is created → if total > 10,000 → create an
 * approval" therefore ran green and did nothing. Not a crash, not a warning:
 * a successful run, recorded as such, forever.
 *
 * What let the two drift apart is that nothing compared them. The list the
 * route validates against and the list the switch implements were written in
 * different files by different hands, and `type: z.string().min(1)` meant the
 * route had no opinion at all. So this reads the switch's own source and
 * asserts the exported list matches it — the constant cannot rot without the
 * test noticing, which is the property that was missing.
 */
describe('flow step types', () => {
  /** Every `case '<type>':` in the executor's switch, read from the source. */
  function casesInExecutor(): string[] {
    const src = readFileSync(new URL('../../lib/flows/flow-executor.ts', import.meta.url), 'utf8');
    // Only the switch arms, which are indented inside `executeStep`. The
    // exported constant lists the same strings and must not count as evidence
    // for itself.
    const body = src.slice(src.indexOf('switch (step.type)'));
    return [...body.matchAll(/^\s+case '([a-z_]+)':/gm)].map((m) => m[1]!);
  }

  it('the exported list is exactly what the switch implements', () => {
    const declared: string[] = [...EXECUTABLE_STEP_TYPES];
    expect(declared.sort()).toEqual(casesInExecutor().sort());
  });

  // The three the Studio offered and the executor never had. If one of these
  // ever appears in the switch, this test should be updated in the same commit
  // that implements it — not before.
  it.each([
    'condition',
    'create_record',
    'update_record',
  ])('does not claim to implement %s', (type) => {
    expect(EXECUTABLE_STEP_TYPES as readonly string[]).not.toContain(type);
  });

  it('still implements the ones flows depend on', () => {
    for (const type of ['query_db', 'run_script', 'send_email', 'webhook']) {
      expect(EXECUTABLE_STEP_TYPES as readonly string[]).toContain(type);
    }
  });
});
