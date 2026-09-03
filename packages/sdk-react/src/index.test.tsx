/**
 * The first tests this package has had.
 *
 * `@zveltio/react` is published to npm and CI ran nothing against it — no test
 * step and, until now, not even a `typecheck` step of its own; the only thing
 * standing between a broken hook and a release was `tsc` inside `bun run build`
 * at publish time.
 *
 * Two things are worth asserting without a browser, and both are what actually
 * breaks in a package like this:
 *
 *   1. The export surface. `index.ts` is the contract — eight hooks, a provider
 *      and a re-exported client. A hook renamed or dropped in a refactor is
 *      invisible to every consumer until `npm i` and a red screen.
 *   2. The provider boundary. `useZveltioClient` promises a specific error when
 *      it is used outside `ZveltioProvider`, and that promise is the one thing
 *      every other hook in the package depends on.
 *
 * Rendered with `react-dom/server`, so there is no DOM, no jsdom dependency and
 * nothing to configure — Bun runs it as-is.
 */

import { describe, expect, it } from 'bun:test';
import { renderToString } from 'react-dom/server';
import type { ZveltioClient } from '@zveltio/sdk';
import * as pkg from './index.js';
import { ZveltioProvider, useZveltioClient } from './context.js';

/** Enough of a client to be identity-checked; the hooks only pass it through. */
const fakeClient = { baseUrl: 'http://example.invalid' } as unknown as ZveltioClient;

describe('@zveltio/react export surface', () => {
  const hooks = [
    'useCollection',
    'useRecord',
    'useSyncCollection',
    'useSyncStatus',
    'useRealtime',
    'useAuth',
    'useStorage',
    'useZveltioClient',
  ] as const;

  it.each([...hooks])('exports %s as a function', (name: string) => {
    expect(typeof (pkg as Record<string, unknown>)[name]).toBe('function');
  });

  it('exports the provider and the re-exported core client', () => {
    expect(typeof pkg.ZveltioProvider).toBe('function');
    expect(typeof pkg.createZveltioClient).toBe('function');
    expect(typeof pkg.ZveltioClient).toBe('function');
  });
});

describe('the provider boundary', () => {
  it('hands the client to a hook rendered inside it', () => {
    // Captured through a box: assigned to a plain `let` inside the component,
    // TypeScript cannot see the write and narrows the variable back to `null`
    // at the assertion below.
    const captured: { client: ZveltioClient | null } = { client: null };
    function Probe() {
      captured.client = useZveltioClient();
      return <span>ok</span>;
    }

    const html = renderToString(
      <ZveltioProvider client={fakeClient}>
        <Probe />
      </ZveltioProvider>,
    );

    expect(html).toContain('ok');
    expect(captured.client).toBe(fakeClient);
  });

  it('throws a named error when a hook is used outside the provider', () => {
    function Orphan() {
      useZveltioClient();
      return null;
    }

    // React wraps a render-phase throw, so assert on the message rather than on
    // an error identity that React owns.
    expect(() => renderToString(<Orphan />)).toThrow(
      /useZveltioClient must be used within a ZveltioProvider/,
    );
  });
});
