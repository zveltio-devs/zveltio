/**
 * `action_url` on a broadcast notification is a link people click.
 *
 * The schema said `z.string().url().optional()`, which reads like validation
 * and is not: `new URL()` accepts `javascript:alert(1)` and
 * `data:text/html,…` quite happily, so both passed. The Studio renders the
 * value as the notification's link, and a notification that appears to come
 * from the platform is exactly the thing people click without reading — so a
 * tenant admin could hand every member of their tenant a click-to-execute
 * payload through a field that looked checked.
 *
 * These cases pin the shapes that must not survive, and the two that must.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

/** The schema as the broadcast route declares it. */
const actionUrl = z
  .string()
  .url()
  .refine(
    (u) => /^https?:\/\//i.test(u) || u.startsWith('/'),
    'action_url must be an http(s) URL or an in-app path',
  )
  .optional();

const accepts = (u: string) => actionUrl.safeParse(u).success;

describe('notification action_url', () => {
  it('accepts an ordinary https link', () => {
    expect(accepts('https://zveltio.com/invoices/42')).toBe(true);
  });

  it('accepts http, since self-hosted installs are not all on TLS', () => {
    expect(accepts('http://intranet.local/tickets/7')).toBe(true);
  });

  it('refuses javascript:', () => {
    // The whole finding. `z.string().url()` alone returns success here.
    expect(z.string().url().safeParse('javascript:alert(1)').success).toBe(true);
    expect(accepts('javascript:alert(1)')).toBe(false);
  });

  it('refuses data: URLs', () => {
    // `data:text/html,…` navigates to attacker-authored markup.
    expect(accepts('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('refuses other schemes', () => {
    expect(accepts('file:///etc/passwd')).toBe(false);
    expect(accepts('vbscript:msgbox(1)')).toBe(false);
  });

  it('refuses a bare word that is not a URL at all', () => {
    expect(accepts('dashboard')).toBe(false);
  });
});
