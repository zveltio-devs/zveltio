// `zveltio extension validate` checks both dependency lists the broker reads.
import { describe, expect, it } from 'bun:test';
import { validateManifest } from '../validate/index.js';

const base = {
  name: 'a',
  displayName: 'A',
  category: 'custom',
  description: 'd',
  version: '1.0.0',
};
const codes = (extra: object) =>
  validateManifest({ manifest: { ...base, ...extra } })
    .filter((e) => e.code === 'MANIFEST_BAD_DEPENDENCY')
    .map((e) => e.message);

describe('manifest dependencies / optionalDependencies', () => {
  it('accepts both lists', () => {
    expect(
      codes({
        dependencies: [{ name: 'crm', minVersion: '1.0.0' }],
        optionalDependencies: [{ name: 'ai' }],
      }),
    ).toEqual([]);
  });

  it('refuses a malformed entry, a bad minVersion and a name in both lists', () => {
    expect(codes({ optionalDependencies: 'ai' })).toHaveLength(1);
    expect(codes({ optionalDependencies: [{ minVersion: '1.0.0' }] })[0]).toContain('has no name');
    expect(codes({ optionalDependencies: [{ name: 'ai', minVersion: 'x' }] })[0]).toContain(
      'not semver',
    );
    expect(
      codes({ dependencies: [{ name: 'ai' }], optionalDependencies: [{ name: 'ai' }] })[0],
    ).toContain('"ai" is listed in "dependencies" and "optionalDependencies"');
  });
});
