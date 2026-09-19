import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { stepSchemas } from '../../lib/flows/flow-step-schemas.js';
import { validateStepConfig } from '../../lib/flows/flow-step-schemas.js';

/**
 * The route stores `safeParse(...).data`, and `z.object` STRIPS unknown keys. So
 * every config key the executor reads and the schema omits is deleted on the way
 * in — silently, by the validator, on a request that answers 200.
 *
 * Measured before this test existed: `ai_decision.fallback` and `.temperature`,
 * `send_email.body_html`, `webhook.body` and `run_script.input` were all read by
 * the executor and all stripped by the schema. A step whose AI answered
 * off-list returned `decision: undefined` and reported success, because the
 * fallback the operator configured never reached the row.
 *
 * Worse, it depended on the route: `POST /flows` stores `s.config` raw, so the
 * same step created two ways behaved two ways.
 *
 * This reads the executor's own source for the keys each arm consumes and
 * asserts the schema keeps them. It cannot pass by accident: add a `cfg.x` read
 * to an arm and this fails until `x` is in that arm's schema.
 */
describe('flow step config keys survive validation', () => {
  /** `{ stepType: [key, …] }` — every `cfg.<key>` inside each switch arm. */
  function keysReadByExecutor(): Record<string, string[]> {
    const src = readFileSync(new URL('../../lib/flows/flow-executor.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('switch (step.type)'));
    const arms = [...body.matchAll(/^\s+case '([a-z_]+)':/gm)];
    const out: Record<string, string[]> = {};
    for (const [i, m] of arms.entries()) {
      const from = m.index! + m[0]!.length;
      const to = i + 1 < arms.length ? arms[i + 1]!.index! : body.length;
      const arm = body.slice(from, to);
      // Only real reads: skip prose in comments, which names historical keys
      // (`cfg.code`) that no longer exist.
      const code = arm.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const direct = [...code.matchAll(/\bcfg\.([a-z_]+)/g)].map((k) => k[1]!);
      // `const { a, b } = cfg` is a read of `a` and `b` too. The first version of
      // this test looked only for `cfg.x`, so it stayed green with
      // `ai_decision.fallback` deleted from the schema — the very key that
      // prompted it. Only the hand-written assertion below failed, which is the
      // "passes for the wrong reason" shape this file is supposed to catch.
      const destructured = [...code.matchAll(/\{([^{}]*)\}\s*=\s*cfg\b/g)].flatMap((m2) =>
        m2[1]!
          .split(',')
          .map((part) => part.split(':')[0]!.trim())
          .filter((k) => /^[a-z_]+$/.test(k)),
      );
      out[m[1]!] = [...new Set([...direct, ...destructured])];
    }
    return out;
  }

  /**
   * Keys the executor reads DELIBERATELY without a schema entry. Each one is a
   * read of something the schema must not accept on the way in, so add to this
   * list only with the reason — an empty entry here re-opens the defect.
   */
  const deliberatelyUnvalidated: Record<string, string[]> = {
    // `code` is the pre-schema name for `script`, read so that flows authored
    // before the schema keep running. New steps must send `script`, which is
    // why the schema does not offer `code`.
    run_script: ['code'],
  };

  const read = keysReadByExecutor();

  it('finds the switch arms', () => {
    expect(Object.keys(read).length).toBeGreaterThan(5);
  });

  for (const [type, keys] of Object.entries(read)) {
    if (!(type in stepSchemas)) continue; // covered by flow-step-types.test.ts
    it(`${type}: the schema keeps every key the executor reads`, () => {
      // A schema may be wrapped in .refine(), which hides .shape — reach the
      // object underneath rather than skipping the check.
      const schema = stepSchemas[type as keyof typeof stepSchemas] as {
        shape?: Record<string, unknown>;
        _def?: { schema?: { shape?: Record<string, unknown> } };
      };
      const shape = schema.shape ?? schema._def?.schema?.shape;
      expect(shape, `${type}: could not read the schema shape`).toBeDefined();
      const allowed = deliberatelyUnvalidated[type] ?? [];
      const missing = keys.filter((k) => !(k in shape!) && !allowed.includes(k));
      expect(missing, `${type} reads config keys its schema strips`).toEqual([]);
    });
  }

  it('a stripped key is what this test is about — ai_decision.fallback survives', () => {
    const r = validateStepConfig('ai_decision', {
      prompt: 'p',
      options: ['a', 'b'],
      fallback: 'a',
    });
    expect(r.valid).toBe(true);
    expect((r.config as { fallback?: string }).fallback).toBe('a');
  });
});
