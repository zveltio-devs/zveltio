/**
 * Smoke test — proves Vitest is wired correctly.
 *
 * The real value comes from the component tests in `src/lib/...test.ts`
 * (added incrementally). This file just exercises the harness end-to-end:
 * jsdom is available, @testing-library/jest-dom matchers loaded, app-state
 * stubs resolve, etc.
 */

import { describe, it, expect } from 'vitest';

describe('Vitest harness', () => {
  it('jsdom provides document + window', () => {
    expect(typeof document).toBe('object');
    expect(typeof window).toBe('object');
  });

  it('@testing-library/jest-dom matchers loaded', () => {
    const el = document.createElement('div');
    el.textContent = 'hi';
    document.body.appendChild(el);
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent('hi');
    document.body.removeChild(el);
  });

  it('polyfilled ResizeObserver + matchMedia survive component init', () => {
    expect(typeof (globalThis as any).ResizeObserver).toBe('function');
    expect(typeof globalThis.matchMedia).toBe('function');
    const m = globalThis.matchMedia('(prefers-color-scheme: dark)');
    expect(m.matches).toBe(false);
  });

  it('$app/state stub resolves with a default page object', async () => {
    const mod = await import('$app/state' as string);
    expect(mod.page.status).toBe(200);
    expect(mod.page.url).toBeInstanceOf(URL);
  });

  it('$app/navigation stub resolves with goto returning undefined', async () => {
    const mod = await import('$app/navigation' as string);
    await expect(mod.goto('/foo')).resolves.toBeUndefined();
  });
});

describe('SchemaForm pipeline reachable from Studio package', () => {
  it('@zveltio/sdk/studio exports the form-alter pipeline', async () => {
    const { applyFormAlterHooks, makeFormProxy } = await import('@zveltio/sdk/studio');
    expect(typeof applyFormAlterHooks).toBe('function');
    expect(typeof makeFormProxy).toBe('function');

    // Trivial end-to-end: addField runs.
    const schema = { id: 'test', fields: [{ name: 'a', type: 'text' }] };
    const out = applyFormAlterHooks(
      [(form) => form.addField({ field: { name: 'b', type: 'text' } })],
      schema,
    );
    expect(out.fields.map((f) => f.name)).toEqual(['a', 'b']);
  });
});
