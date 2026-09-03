/**
 * The first tests this package has had.
 *
 * Same reason as `@zveltio/react`'s: `@zveltio/vue` is published to npm and CI
 * ran nothing against it. What is asserted here is the same pair — the export
 * surface, and the injection boundary every composable in the package depends
 * on — because those are what a refactor breaks silently in a package whose
 * consumers all live in other repositories.
 *
 * Rendered with `vue/server-renderer`, so no DOM and nothing to configure.
 */

import { describe, expect, it } from 'bun:test';
import { type App, createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { ZveltioClient } from '@zveltio/sdk';
import * as pkg from './index.js';
import { ZVELTIO_CLIENT_KEY, ZveltioPlugin, type ZveltioPluginOptions } from './plugin.js';
import { useCollection } from './composables/useCollection.js';

const fakeClient = { baseUrl: 'http://example.invalid' } as unknown as ZveltioClient;

describe('@zveltio/vue export surface', () => {
  const composables = [
    'useCollection',
    'useRecord',
    'useSyncCollection',
    'useSyncStatus',
    'useRealtime',
    'useAuth',
    'useStorage',
  ] as const;

  it.each([...composables])('exports %s as a function', (name: string) => {
    expect(typeof (pkg as Record<string, unknown>)[name]).toBe('function');
  });

  it('exports the plugin, its injection key and the re-exported core client', () => {
    expect(typeof pkg.ZveltioPlugin.install).toBe('function');
    expect(pkg.ZVELTIO_CLIENT_KEY).toBe('zveltio-client');
    expect(typeof pkg.createZveltioClient).toBe('function');
    expect(typeof pkg.ZveltioClient).toBe('function');
  });
});

describe('ZveltioPlugin', () => {
  it('provides the client under the documented key', () => {
    const provided: Record<string, unknown> = {};
    // A one-method stand-in for `App`, on purpose: installing into a real app
    // would drag in a renderer to assert a single `provide` call. Cast through
    // `unknown` rather than `any` so the narrowing is stated once, here.
    const app = {
      provide: (k: string, v: unknown) => {
        provided[k] = v;
      },
    } as unknown as App;

    ZveltioPlugin.install(app, { client: fakeClient });

    expect(provided[ZVELTIO_CLIENT_KEY]).toBe(fakeClient);
  });

  it('refuses to install without a client rather than providing undefined', () => {
    const app = { provide: () => {} } as unknown as App;
    const noOptions = {} as unknown as ZveltioPluginOptions;

    expect(() => ZveltioPlugin.install(app, noOptions)).toThrow(
      /\[ZveltioPlugin\] options\.client is required/,
    );
  });
});

describe('the injection boundary', () => {
  it('throws a named error when a composable runs without the plugin', async () => {
    const Orphan = defineComponent({
      setup() {
        useCollection('anything');
        return () => h('span', 'unreachable');
      },
    });

    // Vue reports a setup-phase throw through the app's error handler, so catch
    // it there rather than relying on renderToString to reject.
    let caught: unknown;
    const app = createSSRApp(Orphan);
    app.config.errorHandler = (err) => {
      caught = err;
    };
    await renderToString(app);

    expect(String((caught as Error | undefined)?.message)).toMatch(
      /useCollection must be used within ZveltioPlugin/,
    );
  });
});
