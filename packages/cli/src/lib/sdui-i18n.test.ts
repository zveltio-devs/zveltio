import { describe, it, expect } from 'bun:test';
import { validateSduiSchema, SHARED_MESSAGE_KEYS } from '@zveltio/sdk/validate';

/**
 * SDUI i18n validation.
 *
 * An SDUI schema is data, so every user-visible string sits in a named slot and
 * can be checked exactly — no source parsing, no guessing at what is prose.
 * That property is the reason declarative pages are the better i18n story, and
 * these tests are what keeps it true.
 *
 * The failure this prevents: the host resolves a string through `t()`, which
 * looks it up in the message bundle and falls back to the literal. A typo'd or
 * missing key therefore renders to the user as `auth.saml.ui.begin_certificate`
 * with no error anywhere — invisible in review, invisible at runtime.
 */

const base = {
  kind: 'settings' as const,
  title: 'demo.title',
  dataSource: '/ext/demo/config',
  saveEndpoint: '/ext/demo/config',
};

/** Validate without endpoint checks so tests isolate the i18n behaviour. */
function i18nErrors(schema: object, messageKeys?: Iterable<string>) {
  return validateSduiSchema({ schema, extName: 'demo', messageKeys, file: 'demo.json' }).filter(
    (e) => e.code.startsWith('SDUI_I18N'),
  );
}

describe('SDUI i18n — missing keys', () => {
  it('accepts a key the extension ships itself', () => {
    expect(i18nErrors(base, ['demo.title'])).toEqual([]);
  });

  it('accepts a key from the shared vocabulary', () => {
    const s = { ...base, fields: [{ name: 'x', label: 'common.save' }] };
    expect(i18nErrors(s, ['demo.title', ...SHARED_MESSAGE_KEYS])).toEqual([]);
  });

  it('rejects a key-shaped string that resolves nowhere', () => {
    const s = { ...base, fields: [{ name: 'x', label: 'demo.ui.typoo' }] };
    const out = i18nErrors(s, ['demo.title']);
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe('SDUI_I18N_KEY_MISSING');
    expect(out[0].severity).not.toBe('warning'); // must fail validation
    expect(out[0].message).toContain('demo.ui.typoo');
  });

  it('rejects a key belonging to another extension', () => {
    // Resolves today only because the host ships the union of every
    // extension's catalogue. Install this one alone and the user sees the key.
    const s = { ...base, fields: [{ name: 'x', label: 'crm.form.currency' }] };
    const out = i18nErrors(s, ['demo.title', ...SHARED_MESSAGE_KEYS]);
    expect(out.map((e) => e.code)).toEqual(['SDUI_I18N_KEY_MISSING']);
  });

  it('checks every slot, at any depth', () => {
    const s = {
      ...base,
      sections: [
        {
          title: 'demo.bad.section',
          fields: [{ name: 'x', label: 'demo.bad.label', placeholder: 'demo.bad.ph' }],
        },
      ],
      actions: [{ id: 'a', label: 'demo.bad.action', confirm: 'demo.bad.confirm' }],
    };
    const out = i18nErrors(s, ['demo.title']);
    expect(out).toHaveLength(5);
    expect(out.every((e) => e.code === 'SDUI_I18N_KEY_MISSING')).toBe(true);
  });
});

describe('SDUI i18n — hardcoded text', () => {
  it('warns on prose, without failing validation', () => {
    const s = { ...base, fields: [{ name: 'x', label: 'Row limit (0 = all)' }] };
    const out = i18nErrors(s, ['demo.title']);
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe('SDUI_I18N_HARDCODED');
    expect(out[0].severity).toBe('warning');
  });

  it('stays quiet on tokens that read the same in every locale', () => {
    // Flagging CSV or JSON would train authors to ignore the warning.
    const s = {
      ...base,
      fields: [
        { name: 'a', label: 'CSV' },
        { name: 'b', label: 'JSON' },
        { name: 'c', label: 'NDJSON' },
      ],
    };
    expect(i18nErrors(s, ['demo.title'])).toEqual([]);
  });

  it('stays quiet on code samples and identifiers', () => {
    const s = {
      ...base,
      fields: [
        { name: 'a', placeholder: 'status=active' },
        { name: 'b', placeholder: 'https://example.com/hook' },
        { name: 'c', placeholder: 'collection_name' },
      ],
    };
    expect(i18nErrors(s, ['demo.title'])).toEqual([]);
  });
});

describe('SDUI i18n — opt-out', () => {
  it('skips i18n checks when no catalogue is supplied', () => {
    // An extension that ships no messages at all should not be drowned in
    // findings; the endpoint checks still run.
    const s = { ...base, fields: [{ name: 'x', label: 'anything at all here' }] };
    expect(i18nErrors(s)).toEqual([]);
  });
});

describe('shared vocabulary', () => {
  it('carries the generic keys extensions actually reuse', () => {
    for (const k of ['common.save', 'common.cancel', 'common.col.status', 'ext.confirmDelete']) {
      expect(SHARED_MESSAGE_KEYS.has(k)).toBe(true);
    }
  });

  it('does not bless core page-specific keys', () => {
    // Borrowing `insights.title` couples an extension to a core page it does
    // not own; the validator should report it, not accept it.
    for (const k of ['insights.title', 'rls.allCollectionsOpt', 'nav.collections']) {
      expect(SHARED_MESSAGE_KEYS.has(k)).toBe(false);
    }
  });
});
