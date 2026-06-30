// Extension quota constants + lifecycle error classes.
//
// Extracted from extension-loader.ts (loader split) into a leaf module so both
// the loader and the marketplace routes can throw/catch them without an import
// cycle.

export const DEFAULT_QUOTAS = {
  bundleSizeKbMax: 50_000,
  nodeModulesSizeMbMax: 200,
  migrationsMax: 100,
} as const;

export class QuotaExceededError extends Error {
  constructor(
    public readonly quota: 'bundleSizeKb' | 'nodeModulesSizeMb' | 'migrations',
    public readonly observed: number,
    public readonly limit: number,
    extName: string,
  ) {
    super(
      `Extension "${extName}" exceeded ${quota} quota: observed ${observed}, limit ${limit}. ` +
        `Raise the limit in manifest.json "quotas" or reduce the extension's footprint.`,
    );
    this.name = 'QuotaExceededError';
  }
}

export class DownMissingError extends Error {
  constructor(
    public readonly extensionName: string,
    public readonly missingMigrations: string[],
  ) {
    super(
      `Extension "${extensionName}" cannot be purged: ${missingMigrations.length} migration(s) ` +
        `have no DOWN section recorded: ${missingMigrations.join(', ')}. ` +
        `Either edit the migrations to add a "-- DOWN" section before retrying, or roll them back manually.`,
    );
    this.name = 'DownMissingError';
  }
}
