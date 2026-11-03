/**
 * Turns (db/trx-sequencer.ts): a statement sent from a scope after that scope
 * ended queues where the scope did, so it cannot run inside a sibling scope
 * that is running alone on the transaction.
 */

import { expect, it } from 'bun:test';
import { Turns } from '../../db/trx-sequencer.js';

it('a statement left running past its scope waits for a sibling scope', async () => {
  const turns = new Turns();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });

  let leaked!: Promise<unknown>;
  await turns.exclusive(async () => {
    // Fire-and-forget: sent only after this scope has returned.
    leaked = gate.then(() => turns.run(async () => order.push('leaked')));
  });

  const sibling = turns.exclusive(async () => {
    order.push('sibling:start');
    release();
    await new Promise((r) => setTimeout(r, 10));
    order.push('sibling:end');
  });

  await Promise.all([sibling, leaked]);
  expect(order).toEqual(['sibling:start', 'sibling:end', 'leaked']);
});
