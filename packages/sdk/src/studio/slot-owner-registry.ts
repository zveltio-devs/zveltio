import type { SlotContribution } from '../extension/index.js';

/** Owner tag set by compile-time `contribute.ts` modules; absent on legacy window.__zveltio calls. */
export type OwnedSlotContribution = SlotContribution & { owner?: string };

/** Remove every contribution registered by `owner` across all slot names. */
export function removeOwnerFromSlots(
  slots: Record<string, OwnedSlotContribution[]>,
  owner: string,
): Record<string, OwnedSlotContribution[]> {
  const out: Record<string, OwnedSlotContribution[]> = {};
  for (const [name, list] of Object.entries(slots)) {
    const kept = list.filter((c) => c.owner !== owner);
    if (kept.length > 0) out[name] = kept;
  }
  return out;
}

/**
 * Register (or replace) a single owner's contribution on one slot.
 * Prior entries from the same owner on that slot are dropped first.
 */
export function registerOwnedOnSlot(
  slots: Record<string, OwnedSlotContribution[]>,
  owner: string,
  slotName: string,
  contribution: SlotContribution,
): Record<string, OwnedSlotContribution[]> {
  const out = { ...slots };
  const prev = out[slotName] ?? [];
  const kept = prev.filter((c) => c.owner !== owner);
  out[slotName] = [...kept, { ...contribution, owner }];
  return out;
}
