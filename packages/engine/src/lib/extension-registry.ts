/**
 * Extension Registry
 *
 * Allows optional extensions to register handlers that core components
 * (e.g. flow-scheduler) need to call — without creating hard import
 * dependencies across package boundaries.
 *
 * Usage in an extension's register():
 *   import { extensionRegistry } from '@zveltio/engine/lib/extension-registry.js';
 *   extensionRegistry.registerTrashPurgeHandler(async (db) => { ... });
 */

import type { Database } from '../db/index.js';

export type TrashPurgeHandler = (db: Database) => Promise<void>;

class ExtensionRegistry {
  private _trashPurgeHandler: TrashPurgeHandler | null = null;

  registerTrashPurgeHandler(handler: TrashPurgeHandler): void {
    this._trashPurgeHandler = handler;
  }

  getTrashPurgeHandler(): TrashPurgeHandler | null {
    return this._trashPurgeHandler;
  }
}

export const extensionRegistry = new ExtensionRegistry();
