import { describe, expect, it } from 'bun:test';
import { redirectAllowed } from '../../lib/extensions/actions.js';

// ADR 0061 decision 1: an action's `{ redirect }` reaches only an https host
// the operator named for the extension.
describe('redirectAllowed', () => {
  const granted = [
    'egress:logincert.anaf.ro',
    'egress:anaf=api.anaf.ro',
    'egress:dropped.example',
    'data:read',
  ];
  const declared = {
    authorities: new Set(['egress:logincert.anaf.ro']),
    slots: new Set(['anaf']),
  };
  const ok = (target: unknown, g: readonly string[] = granted) =>
    redirectAllowed(g, declared, target);

  it('admits https on a consented authority or a slot binding', () => {
    expect(ok('https://logincert.anaf.ro/anaf-oauth2/v1/authorize?x=1')).toBe(true);
    expect(ok('https://api.anaf.ro/')).toBe(true);
  });

  it('refuses any other host, scheme, port or shape', () => {
    for (const target of [
      'https://evil.example/',
      // Consented once, no longer declared: dropped, as for a job.
      'https://dropped.example/',
      'https://logincert.anaf.ro.evil.example/',
      'http://logincert.anaf.ro/',
      'https://logincert.anaf.ro:8443/',
      'https://user:pw@logincert.anaf.ro/',
      'javascript:alert(1)',
      '/relative',
      42,
      null,
    ]) {
      expect(ok(target)).toBe(false);
    }
    expect(ok('https://logincert.anaf.ro/', [])).toBe(false);
    expect(redirectAllowed(granted, undefined, 'https://logincert.anaf.ro/')).toBe(false);
  });
});
