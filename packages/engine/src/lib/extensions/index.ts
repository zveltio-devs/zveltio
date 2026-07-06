// Extensions subsystem — the extension loader, registry, marketplace/download,
// sandbox, licensing, dependency + path resolution, and the H-04 load pipeline
// (discovery, lifecycle, register, manifest-schema, migration-runner, …). Public
// API; outside (non-test) code imports from `lib/extensions`, never deep files.
export * from './extension-catalog.js';
export * from './extension-context.js';
export * from './extension-deps.js';
export * from './extension-download.js';
export * from './extension-errors.js';
export * from './extension-license.js';
export * from './extension-loader.js';
export * from './extension-marketplace-routes.js';
export * from './extension-paths.js';
export * from './extension-registry.js';
export * from './extension-sandbox.js';
export * from './extension-utils.js';

// `_internalForTests` is a test-only hook exported by both extension-context and
// extension-sandbox; tests import it via deep paths, so the barrel value is
// unused. Re-export one explicitly to resolve the `export *` ambiguity.
export { _internalForTests } from './extension-context.js';
