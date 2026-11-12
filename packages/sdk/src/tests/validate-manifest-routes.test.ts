// `zveltio extension validate` takes the declared routes the engine takes (ADR 0039).
import { describe, expect, it } from 'bun:test';
import { validateManifest } from '../validate/index.js';

const base = {
  name: 'a',
  displayName: 'A',
  category: 'custom',
  description: 'd',
  version: '1.0.0',
};
const hook = { method: 'POST', path: '/hook/:id', access: 'public', handler: 'hook' };
const codes = (manifest: Record<string, unknown>) =>
  validateManifest({ manifest: { ...base, ...manifest } })
    .filter((e) => e.severity !== 'warning')
    .map((e) => e.code);

describe('manifest routes', () => {
  it('takes a declared route; a public one is what a job may name', () => {
    const job = {
      name: 'ingest',
      input: { type: 'object' },
      fromPublicRoutes: ['/hook/:id'],
    };
    expect(codes({ routes: [hook], jobs: [job] })).toEqual([]);
    expect(codes({ routes: [{ ...hook, access: 'caller' }], jobs: [job] })).toEqual([
      'MANIFEST_BAD_JOB',
    ]);
    expect(
      codes({ routes: [hook], forwardCredentials: { '/hook/:id': ['authorization'] } }),
    ).toEqual([]);
  });

  it('refuses what the engine refuses', () => {
    for (const bad of [
      { path: '/hook/*' },
      { path: '/actions/run' },
      { method: 'HEAD' },
      { access: 'admin' },
      { handler: 'Hook' },
      { extra: 1 },
    ]) {
      expect(codes({ routes: [{ ...hook, ...bad }] }), JSON.stringify(bad)).toEqual([
        'MANIFEST_BAD_ROUTE',
      ]);
    }
    expect(codes({ routes: [hook, { ...hook, handler: 'other' }] })).toEqual([
      'MANIFEST_BAD_ROUTE',
    ]);
    expect(codes({ routes: {} })).toEqual(['MANIFEST_BAD_ROUTE']);
  });
});

describe('manifest signInProviders (ADR 0039 decision 8)', () => {
  const login = { method: 'POST', path: '/login', access: 'public', handler: 'login' };
  const start = { method: 'GET', path: '/start', access: 'public', handler: 'start' };
  const dir = { id: 'dir', label: 'Directory', kind: 'credentials', route: '/login' };

  it('takes a provider started by a declared public route of its kind', () => {
    expect(
      codes({
        routes: [login, start],
        signInProviders: [dir, { id: 'sso', label: 'SSO', kind: 'redirect', route: '/start' }],
      }),
    ).toEqual([]);
  });

  it('refuses what the engine refuses', () => {
    for (const bad of [
      { kind: 'redirect' },
      { route: '/start' },
      { route: '/nowhere' },
      { id: 'Dir' },
      { label: '' },
      { kind: 'oauth' },
      { extra: 1 },
    ]) {
      expect(
        codes({ routes: [login, start], signInProviders: [{ ...dir, ...bad }] }),
        JSON.stringify(bad),
      ).toEqual(['MANIFEST_BAD_SIGN_IN_PROVIDER']);
    }
    expect(codes({ routes: [{ ...login, access: 'caller' }], signInProviders: [dir] })).toEqual([
      'MANIFEST_BAD_SIGN_IN_PROVIDER',
    ]);
    expect(codes({ routes: [login], signInProviders: [dir, dir] })).toEqual([
      'MANIFEST_BAD_SIGN_IN_PROVIDER',
    ]);
  });
});
