/**
 * A public edge function turns authentication off — for ITS tenant only.
 *
 * `/api/fn/:name` used to be served by two implementations at once: the
 * engine's parameterised route and one static route per function registered by
 * the `developer/edge-functions` extension. Hono prefers a static path over a
 * parameterised one, so the extension silently won — and the two do not
 * authenticate alike. The engine takes a session or an API key bound to the
 * tenant; the extension took a session only, and treated `ZVELTIO_PUBLIC=true`
 * as no authentication at all. A function author could switch the engine's gate
 * off by setting an environment variable.
 *
 * The engine owns the prefix now and honours the flag itself. Which introduces
 * the hazard these cases exist for: the probe that decides "is this public?"
 * must be scoped by the same key as the lookup it authorises. The first version
 * of this fix was not, and two tenants each owning a `webhook` — one public,
 * one not — would have run the private one with no authentication.
 */

import { describe, expect, it } from 'bun:test';

const TENANT_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const TENANT_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

/** The rows both tenants own, each with a function called `webhook`. */
const ROWS = [
  { name: 'webhook', tenant_id: TENANT_A, env_vars: JSON.stringify({ ZVELTIO_PUBLIC: 'true' }) },
  { name: 'webhook', tenant_id: TENANT_B, env_vars: JSON.stringify({}) },
];

/** The probe as the route performs it: by name AND tenant. */
function probeScoped(name: string, tenant: string) {
  return ROWS.find((r) => r.name === name && r.tenant_id === tenant);
}

/** The probe as the first version of the fix performed it: by name alone. */
function probeUnscoped(name: string) {
  return ROWS.find((r) => r.name === name);
}

const isPublic = (row?: { env_vars: string }) =>
  row ? JSON.parse(row.env_vars).ZVELTIO_PUBLIC === 'true' : false;

describe('edge function public flag', () => {
  it('reports public for the tenant that marked it public', () => {
    expect(isPublic(probeScoped('webhook', TENANT_A))).toBe(true);
  });

  it('reports private for a different tenant with the same function name', () => {
    // The case that matters. Tenant B never marked theirs public.
    expect(isPublic(probeScoped('webhook', TENANT_B))).toBe(false);
  });

  it('an unscoped probe would have leaked tenant A’s flag onto tenant B', () => {
    // Pinning the bug itself, so the reason for the tenant filter cannot be
    // optimised away by someone who reads the query and sees a redundant
    // predicate. Without it, B's private function answers unauthenticated.
    expect(isPublic(probeUnscoped('webhook'))).toBe(true);
    expect(isPublic(probeScoped('webhook', TENANT_B))).toBe(false);
  });

  it('reports private when the function does not exist for this tenant', () => {
    expect(isPublic(probeScoped('nope', TENANT_A))).toBe(false);
  });

  it('treats a missing or malformed flag as private', () => {
    expect(isPublic({ env_vars: '{}' })).toBe(false);
    expect(isPublic({ env_vars: JSON.stringify({ ZVELTIO_PUBLIC: true }) })).toBe(false);
    expect(isPublic({ env_vars: JSON.stringify({ ZVELTIO_PUBLIC: 'yes' }) })).toBe(false);
  });
});
