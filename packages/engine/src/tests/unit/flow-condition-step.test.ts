/**
 * The flow `condition` step: CEL over `trigger` and `output` (the evaluator
 * validation rules use), false ending the run when no branch is named, the
 * losing branch skipped when one is, and an expression that cannot decide
 * failing the step rather than opening the gate.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { executeFlow } from '../../lib/flows/flow-executor.js';
import { validateStepConfig } from '../../lib/flows/flow-step-schemas.js';
import { evaluateCondition } from '../../lib/validation-engine.js';
import { CannedDb } from './fixtures/canned-db.js';

function dbForFlow(steps: unknown[]): CannedDb {
  const db = new CannedDb();
  db.when(/INSERT INTO zv_flow_runs/i, [{ id: 'run-1' }]);
  db.when(/SELECT \* FROM zv_flow_steps/i, steps);
  db.when(/tenant_id FROM zv_flows/i, [{ tenant_id: 'tenant-1' }]);
  db.whenAffected(/UPDATE zv_flow_runs/i, 1);
  return db;
}

const mark = (id: string, order: number) => ({
  id,
  name: id,
  type: 'run_script',
  step_order: order,
  config: { code: `return { ran: (input && input.ran ? input.ran + ',' : '') + '${id}' };` },
});

const condition = (config: Record<string, unknown>) => ({
  id: 'cond',
  name: 'cond',
  type: 'condition',
  step_order: 2,
  config,
});

function run(steps: unknown[], trigger: unknown) {
  return executeFlow(dbForFlow(steps).kysely as unknown as Database, 'flow-1', trigger);
}

describe('flow condition step', () => {
  it('continues when the expression holds, and passes the previous output through', async () => {
    const r = await run(
      [
        mark('a', 1),
        condition({ expression: 'trigger.total > 10000 && output.ran == "a"' }),
        mark('b', 3),
      ],
      { total: 12000 },
    );
    expect(r.status).toBe('success');
    expect(r.output.ran).toBe('a,b');
  });

  it('ends the run, successfully, when it does not hold and no branch is named', async () => {
    const r = await run(
      [mark('a', 1), condition({ expression: 'trigger.total > 10000' }), mark('b', 3)],
      {
        total: 50,
      },
    );
    expect(r.status).toBe('success');
    expect(r.output.ran).toBe('a');
    expect(r.output._step_logs?.cond).toEqual(['condition false: run ends here']);
  });

  it('skips the losing branch and runs the steps after it', async () => {
    const steps = [
      mark('a', 1),
      condition({ expression: 'trigger.big', true_branch: ['t'], false_branch: ['f'] }),
      mark('t', 3),
      mark('f', 4),
      mark('z', 5),
    ];
    expect((await run(steps, { big: true })).output.ran).toBe('a,t,z');
    expect((await run(steps, { big: false })).output.ran).toBe('a,f,z');
  });

  it.each([
    ['a non-boolean result', 'trigger.total'],
    ['an absent field', 'trigger.missing > 1'],
    ['a name outside its scope', 'record.total > 1'],
  ])('fails the run on %s instead of proceeding', async (_label, expression) => {
    const r = await run([mark('a', 1), condition({ expression }), mark('b', 3)], { total: 5 });
    expect(r.status).toBe('failed');
    expect(r.error ?? '').toContain('Condition');
  });

  it('fails the run, even with on_error continue, rather than run both branches', async () => {
    const r = await run(
      [
        mark('a', 1),
        {
          ...condition({ expression: 'trigger.total', false_branch: ['b'] }),
          on_error: 'continue',
        },
        mark('b', 3),
      ],
      { total: 5 },
    );
    expect(r.status).toBe('failed');
    expect(r.output.ran).toBe('a');
  });

  it('fails the run when a branch names a step that is not after it', async () => {
    const r = await run(
      [mark('a', 1), condition({ expression: 'trigger.big', true_branch: ['a'] }), mark('b', 3)],
      { big: false },
    );
    expect(r.status).toBe('failed');
    expect(r.error ?? '').toContain('not a later step');
  });

  it('sees a nested Date, bigint and undefined as JSON would', () => {
    const trigger = { record: { n: 3n, at: new Date('2026-10-19T00:00:00Z'), gone: undefined } };
    for (const expression of [
      'trigger.record.n * 2.0 == 6.0',
      'trigger.record.at.startsWith("2026-")',
      '!has(trigger.record.gone)',
    ]) {
      expect(evaluateCondition(expression, { trigger, output: null })).toEqual({
        status: 'passed',
      });
    }
  });

  it('refuses at save time an expression that can never evaluate', () => {
    const bad = validateStepConfig('condition', { expression: '{{record.status}} === "active"' });
    expect(bad.valid).toBe(false);
    const outOfScope = validateStepConfig('condition', { expression: 'record.status == "x"' });
    expect(outOfScope.valid).toBe(false);
    expect(outOfScope.errors.join(' ')).toContain('`trigger`, `output`');
    expect(
      validateStepConfig('condition', { expression: 'trigger.status == "active"' }).valid,
    ).toBe(true);
  });
});
