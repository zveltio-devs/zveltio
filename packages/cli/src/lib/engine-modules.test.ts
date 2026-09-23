import { describe, it, expect } from 'bun:test';
import { loadEngineMigrationModules, EngineModulesUnavailable } from './engine-modules.js';

/**
 * `migrate --database-url` and `rollback` reached the engine's runner with a
 * path that is correct from `src/commands/` and one level too high from the
 * bundle `bun build` emits, so every run of the published CLI answered
 * `Cannot find module '…/zveltio/engine/src/db/index.js'`.
 */
describe('loadEngineMigrationModules', () => {
  it('resolves the engine modules from inside the repository', async () => {
    const { db, migrations } = await loadEngineMigrationModules();
    expect(typeof db.initDatabase).toBe('function');
    expect(typeof migrations.runMigrations).toBe('function');
    expect(typeof migrations.rollbackMigration).toBe('function');
  });

  it('names the error after what the operator should run instead', () => {
    const err = new EngineModulesUnavailable();
    expect(err.message).toContain('does not ship the engine');
    expect(err.message).toContain('--url');
    // Never a module path: that is what the old failure printed, and it told an
    // operator nothing about what to do next.
    expect(err.message).not.toContain('/db/index.js');
  });
});
