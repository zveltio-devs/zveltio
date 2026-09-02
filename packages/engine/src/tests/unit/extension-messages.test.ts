/**
 * Per-extension message catalogues on the wire
 * (lib/extensions/manifest-schema.ts — loadExtensionMessages / locale guard).
 *
 * The catalogue reaches a foreign host through
 * `GET /api/extensions?messages=<locale>`, which means the locale is
 * attacker-controlled and gets joined into a filesystem path. The guard is
 * tested here rather than at the route, because the route is not its only
 * caller.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  isSupportedLocaleName,
  loadExtensionMessages,
} from '../../lib/extensions/manifest-schema.js';

function tmpExt(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-msg-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('isSupportedLocaleName', () => {
  it('accepts the shapes locales actually take', () => {
    for (const ok of ['en', 'ro', 'fr', 'pt-BR', 'zh-CN']) {
      expect(isSupportedLocaleName(ok)).toBe(true);
    }
  });

  it('refuses anything that could leave the messages directory', () => {
    for (const bad of ['..', '../../etc/passwd', 'en/../../../secret', 'en ', '', 'ENGLISH', 'e']) {
      expect(isSupportedLocaleName(bad)).toBe(false);
    }
  });
});

describe('loadExtensionMessages', () => {
  it('reads a catalogue for the requested locale', async () => {
    const dir = tmpExt({
      'studio/messages/en.json': JSON.stringify({ 'crm.title': 'CRM' }),
      'studio/messages/ro.json': JSON.stringify({ 'crm.title': 'CRM RO' }),
    });
    expect(await loadExtensionMessages(dir, 'en')).toEqual({ 'crm.title': 'CRM' });
    expect(await loadExtensionMessages(dir, 'ro')).toEqual({ 'crm.title': 'CRM RO' });
  });

  it('drops $schema and any non-string value', async () => {
    const dir = tmpExt({
      'studio/messages/en.json': JSON.stringify({
        $schema: 'https://inlang.com/schema/inlang-message-format',
        'crm.title': 'CRM',
        'crm.count': 3,
        'crm.nested': { a: 'b' },
      }),
    });
    expect(await loadExtensionMessages(dir, 'en')).toEqual({ 'crm.title': 'CRM' });
  });

  it('returns undefined for a locale the extension does not translate', async () => {
    const dir = tmpExt({ 'studio/messages/en.json': JSON.stringify({ a: 'b' }) });
    expect(await loadExtensionMessages(dir, 'hu')).toBeUndefined();
  });

  it('returns undefined rather than throwing on a malformed catalogue', async () => {
    // One extension shipping broken JSON must not fail the whole
    // /api/extensions response for every other extension.
    const dir = tmpExt({ 'studio/messages/en.json': '{ not json' });
    expect(await loadExtensionMessages(dir, 'en')).toBeUndefined();
  });

  it('refuses a traversing locale before touching the filesystem', async () => {
    const dir = tmpExt({ 'studio/messages/en.json': JSON.stringify({ a: 'b' }) });
    expect(await loadExtensionMessages(dir, '../../../../etc/passwd')).toBeUndefined();
  });
});
