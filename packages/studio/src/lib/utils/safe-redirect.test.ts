/**
 * `?redirect=` is attacker-supplied.
 *
 * The login page forwards to it after a successful sign-in, so a link like
 * `…/login?redirect=https://evil.example/login` walks the user through a real
 * authentication and then to a page that can look exactly like the one they
 * just used. The domain was genuine for the part they were watching.
 *
 * The cases below are the ways past a naive "starts with /" check, which is
 * the check most people write.
 */

import { describe, expect, it } from 'vitest';
import { safeRedirect } from './safe-redirect.js';

const BASE = '/admin';

describe('safeRedirect', () => {
  it('keeps an ordinary in-app path', () => {
    expect(safeRedirect('/admin/collections', BASE)).toBe('/admin/collections');
    expect(safeRedirect('/admin', BASE)).toBe('/admin');
  });

  it('falls back when there is nothing to redirect to', () => {
    expect(safeRedirect(null, BASE)).toBe('/admin/');
    expect(safeRedirect('', BASE)).toBe('/admin/');
    expect(safeRedirect(undefined, BASE)).toBe('/admin/');
  });

  it('refuses an absolute URL', () => {
    expect(safeRedirect('https://evil.example/login', BASE)).toBe('/admin/');
    expect(safeRedirect('http://evil.example', BASE)).toBe('/admin/');
  });

  it('refuses a scheme-relative URL', () => {
    // `//evil.example` is not a path — the browser reads it as a host, which
    // is why "starts with /" is not enough on its own.
    expect(safeRedirect('//evil.example', BASE)).toBe('/admin/');
    expect(safeRedirect('//evil.example/admin/collections', BASE)).toBe('/admin/');
  });

  it('refuses backslash smuggling', () => {
    // Some browsers normalise `\` to `/` in the authority position.
    expect(safeRedirect('/\\evil.example', BASE)).toBe('/admin/');
    expect(safeRedirect('/admin\\..\\evil', BASE)).toBe('/admin/');
  });

  it('refuses a javascript: payload', () => {
    expect(safeRedirect('javascript:alert(1)', BASE)).toBe('/admin/');
  });

  it('refuses a same-host path outside the app base', () => {
    // A deployment mounted at /admin must not be usable to bounce someone into
    // an unrelated app sharing the host.
    expect(safeRedirect('/other-app/page', BASE)).toBe('/admin/');
    // …and not by prefix confusion either.
    expect(safeRedirect('/adminevil/page', BASE)).toBe('/admin/');
  });

  it('works when the app is mounted at the root', () => {
    expect(safeRedirect('/collections', '')).toBe('/collections');
    expect(safeRedirect('//evil.example', '')).toBe('/');
  });
});
