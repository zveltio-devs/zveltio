/**
 * Core collections — retired for CRM entities.
 *
 * Contacts, organizations, and transactions are owned by `@zveltio/ext-crm`
 * (migrations + `adoptCrmCollections` on register). This module stays as an
 * empty hook so boot still calls `ensureCoreCollections` without inventing
 * business tables on bare BaaS.
 *
 * Do not re-add CREATE/adopt for CRM here — that recreates the dual-owner
 * metadata fight (registerMetadata overwrites fields).
 */
import type { Database } from '../db/index.js';

/** Empty — CRM extension owns domain collections. Kept for import stability. */
export const CORE_COLLECTIONS: readonly never[] = [];

/** No-op. CRM adopt runs during extension load, before routes are built. */
export async function ensureCoreCollections(_db: Database): Promise<void> {
  // Intentionally empty.
}
