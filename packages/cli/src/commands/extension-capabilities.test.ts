// `zveltio extension validate` holds the capabilities an extension declares to
// TypeScript (`defineExtension([...], …)`) to the ones its manifest declares to
// the engine (R8). Either side alone is a lie: the types promise what the engine
// will refuse, or the manifest asks the administrator for power the code says it
// does not use.
import { describe, expect, it } from 'bun:test';
import { checkDeclaredCapabilities } from './extension-validate.js';

const src = (list: string) =>
  `import { defineExtension } from '@zveltio/sdk/extension';\nexport default defineExtension([${list}], { name: 'x', category: 'y', async register() {} });\n`;

describe('checkDeclaredCapabilities', () => {
  it('passes when the two lists agree, legacy labels aside', () => {
    expect(
      checkDeclaredCapabilities([src("'secrets', 'ddl'")], {
        permissions: ['ddl', 'database', 'secrets'],
      }),
    ).toEqual([]);
  });

  it('refuses a capability the manifest does not declare', () => {
    const out = checkDeclaredCapabilities([src("'secrets', 'auth:users'")], {
      permissions: ['secrets'],
    });
    expect(out.map((e) => e.code)).toEqual(['CAPABILITY_NOT_IN_MANIFEST']);
    expect(out[0]!.message).toContain('auth:users');
  });

  it('refuses a manifest capability the code does not declare', () => {
    const out = checkDeclaredCapabilities([src("'secrets'")], {
      permissions: ['secrets', 'db:admin'],
    });
    expect(out.map((e) => e.code)).toEqual(['CAPABILITY_NOT_IN_DEFINE']);
    expect(out[0]!.message).toContain('db:admin');
  });

  it('has nothing to compare without defineExtension', () => {
    expect(
      checkDeclaredCapabilities(['export default { name: "x" };'], { permissions: ['ddl'] }),
    ).toEqual([]);
  });
});
