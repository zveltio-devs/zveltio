/**
 * SDUI schema validation.
 *
 * The host renders schema authored by extensions, so this function decides what
 * happens when an extension ships something malformed. Its own docstring makes
 * the promise: "a friendly error panel, never a white screen or a silently
 * mis-rendered page." That is a promise about behaviour on bad input, and bad
 * input is exactly what does not occur while developing against good schema.
 *
 * The version guard matters most. It is what lets a Studio meet a page built
 * for a newer host and say so, instead of rendering a page missing whatever the
 * new version added — the silent mis-render the docstring rules out. Getting
 * the comparison backwards would be invisible until an operator upgraded half
 * their estate.
 */

import { describe, expect, it } from 'vitest';
import { validateSchema } from './validate';
import { SDUI_SCHEMA_VERSION } from './types';

/** Smallest schema the list archetype accepts. */
const listSchema = () => ({
  title: 'Contacts',
  resources: [
    {
      id: 'contacts',
      dataSource: '/api/data/contacts',
      columns: [{ key: 'name', label: 'Name' }],
    },
  ],
});

const settingsSchema = () => ({
  kind: 'settings',
  title: 'Mail settings',
  dataSource: '/api/settings',
  saveEndpoint: '/api/settings/bulk',
});

describe('validateSchema — accepts', () => {
  it('a minimal list page', () => {
    const r = validateSchema(listSchema());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe('list');
  });

  it('a settings page', () => {
    const r = validateSchema(settingsSchema());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe('settings');
  });

  it('a schema at exactly the supported version', () => {
    // The boundary the version guard turns on. Off by one here and every page
    // authored for the current host is refused.
    const r = validateSchema({ ...listSchema(), sduiSchema: SDUI_SCHEMA_VERSION });
    expect(r.ok).toBe(true);
  });

  it('a schema with no version, treating it as v1', () => {
    const r = validateSchema(listSchema());
    expect(r.ok).toBe(true);
  });
});

describe('validateSchema — refuses, with something an operator can act on', () => {
  it('a schema from a newer host, naming both versions', () => {
    // The message has to say what to do. "Invalid schema" sends someone to read
    // the extension's source; this sends them to update Zveltio.
    const r = validateSchema({ ...listSchema(), sduiSchema: SDUI_SCHEMA_VERSION + 1 });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain(String(SDUI_SCHEMA_VERSION + 1));
      expect(r.error).toContain(String(SDUI_SCHEMA_VERSION));
      expect(r.error).toContain('Update Zveltio');
    }
  });

  it('a missing title', () => {
    const { title, ...rest } = listSchema();
    void title;
    const r = validateSchema(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('title');
  });

  it('an empty title', () => {
    const r = validateSchema({ ...listSchema(), title: '' });
    expect(r.ok).toBe(false);
  });

  it('a settings page missing its endpoints', () => {
    const r = validateSchema({ kind: 'settings', title: 'x', dataSource: '/api/settings' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('saveEndpoint');
  });

  it('a list page with no resources', () => {
    const r = validateSchema({ title: 'x', resources: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('resources');
  });

  it('a resource missing dataSource, naming which one', () => {
    // The index and id are in the message on purpose: a page with eight
    // resources and "missing dataSource" is a hunt.
    const r = validateSchema({
      title: 'x',
      resources: [
        { id: 'a', dataSource: '/api/a', columns: [] },
        { id: 'broken', columns: [] },
      ],
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('resources[1]');
      expect(r.error).toContain('broken');
    }
  });

  it('a resource missing columns', () => {
    const r = validateSchema({
      title: 'x',
      resources: [{ id: 'a', dataSource: '/api/a' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('columns');
  });

  it('a resource that is not an object', () => {
    const r = validateSchema({ title: 'x', resources: ['nope'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('resources[0]');
  });

  it('refuses unknown column types', () => {
    const r = validateSchema({
      title: 'x',
      resources: [
        {
          id: 'a',
          dataSource: '/api/a',
          columns: [{ key: 'x', label: 'X', type: 'chart' }],
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown type');
  });

  it('requires selectable when bulkActions is set', () => {
    const r = validateSchema({
      title: 'x',
      resources: [
        {
          id: 'a',
          dataSource: '/api/a',
          columns: [{ key: 'n', label: 'N' }],
          bulkActions: [{ id: 'del' }],
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('selectable');
  });
});

describe('validateSchema — version alias', () => {
  it('accepts deprecated sduiSchemaVersion alias', () => {
    const r = validateSchema({ ...listSchema(), sduiSchemaVersion: SDUI_SCHEMA_VERSION });
    expect(r.ok).toBe(true);
  });
});

describe('validateSchema — inputs that are not schema at all', () => {
  it('refuses null, arrays and primitives rather than throwing', () => {
    // These arrive when a fetch returns an error body, or a file is empty. The
    // renderer must get a refusal it can display, not an exception mid-render —
    // the white screen the docstring rules out.
    for (const v of [null, undefined, 'string', 42, [], [1, 2]]) {
      const r = validateSchema(v);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(typeof r.error).toBe('string');
    }
  });
});
