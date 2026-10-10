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
});
