/**
 * A `run_script` step that passes validation must actually run.
 *
 * `flow-step-schemas.ts` requires `script: z.string().min(1)`. The executor read
 * `cfg.code` and, finding nothing, returned the previous output unchanged — so
 * every step authored through the validated path was a no-op and the flow
 * reported success. That is the "failure that renders as a success" class,
 * living inside the executor whose own `default:` branch was fixed for it.
 *
 * The scripts here really execute. An earlier draft used `mock.module` on the
 * script runner and passed in isolation while breaking
 * `script-runner-error-body.test.ts` in the same run — bun's module mocks leak
 * across files, which this repository has been bitten by before. Running the
 * real thing is both truer and cheaper than arranging not to.
 */

import { describe, it, expect } from 'bun:test';
import type { Database } from '../../db/index.js';
import { _internalForTests } from '../../lib/flows/flow-executor.js';
import { CannedDb } from './fixtures/canned-db.js';

const { executeStep } = _internalForTests;
const db = () => new CannedDb().kysely as unknown as Database;

describe('flow executor — run_script reads the key the schema writes', () => {
  it('runs a step configured with `script`, the key the schema demands', async () => {
    const { output } = await executeStep(
      db(),
      { name: 's1', type: 'run_script', config: { script: 'return { ran: "script" }' } },
      { previous: true },
      {},
    );
    expect(output).toEqual({ ran: 'script' });
    // The distinguishing assertion: the bug returned the PREVIOUS output, which
    // is why it looked like a successful step to everything downstream.
    expect(output).not.toEqual({ previous: true });
  });

  it('still runs a legacy step configured with `code`', async () => {
    // Flows authored before the schema existed carry `code` in
    // zv_flow_steps.config. Refusing those on upgrade would break working flows
    // in order to fix a typo.
    const { output } = await executeStep(
      db(),
      { name: 's2', type: 'run_script', config: { code: 'return { ran: "code" }' } },
      { previous: true },
      {},
    );
    expect(output).toEqual({ ran: 'code' });
  });

  it('refuses a step with neither, instead of reporting a run that did nothing', async () => {
    await expect(
      executeStep(db(), { name: 's3', type: 'run_script', config: {} }, { previous: true }, {}),
    ).rejects.toThrow(/no script/i);
  });

  it('refuses an empty script rather than treating it as absent work', async () => {
    await expect(
      executeStep(
        db(),
        { name: 's4', type: 'run_script', config: { script: '' } },
        { previous: true },
        {},
      ),
    ).rejects.toThrow(/no script/i);
  });
});
