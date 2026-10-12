// `zveltio extension validate` refuses the forwardCredentials the engine would refuse.
import { describe, expect, it } from 'bun:test';
import { validateManifest } from '../validate/index.js';

const base = {
  name: 'a',
  displayName: 'A',
  category: 'custom',
  description: 'd',
  version: '1.0.0',
  publicRoutes: ['/scim/*'],
};
const errors = (forwardCredentials: unknown) =>
  validateManifest({ manifest: { ...base, forwardCredentials } }).filter(
    (e) => e.code === 'MANIFEST_BAD_FORWARD_CREDENTIALS',
  );

describe('manifest forwardCredentials', () => {
  it('accepts a credential header on a public route', () => {
    expect(errors({ '/scim/*': ['authorization'] })).toEqual([]);
  });

  it('refuses an unknown header, a non-public route and a non-object', () => {
    expect(errors({ '/scim/*': ['stripe-signature'] })).toHaveLength(1);
    expect(errors({ '/admin/*': ['cookie'] })).toHaveLength(1);
    expect(errors(['authorization'])).toHaveLength(1);
  });

  // The engine's schema takes arrays only, and refused at load what this passed.
  it('refuses a bare header name where the engine wants a list', () => {
    expect(errors({ '/scim/*': 'authorization' })).toHaveLength(1);
  });
});

describe('manifest apiKeyRoutes', () => {
  const routeErrors = (apiKeyRoutes: unknown) =>
    validateManifest({ manifest: { ...base, apiKeyRoutes } }).filter(
      (e) => e.code === 'MANIFEST_BAD_API_KEY_ROUTE',
    );

  it('accepts a list of method + pattern', () => {
    expect(routeErrors(['GET /items'])).toEqual([]);
  });

  it('refuses a bare string where the engine wants a list', () => {
    expect(routeErrors('GET /items')).toHaveLength(1);
  });
});
