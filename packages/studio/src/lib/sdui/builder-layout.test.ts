import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `secondary.timestampKey` and `secondary.dataKey` are typed `Dotted`, and the
 * builder read them with a plain index: a nested key produced `Invalid Date`
 * on every row and an empty answers column.
 */
const submissions = [
  {
    id: 's-1',
    meta: { submitted_at: '2026-01-02T03:04:05Z' },
    payload: { answers: { q1: 'yes' } },
  },
];

const get = vi.fn(async (url: string) =>
  url.includes('/responses')
    ? { submissions, form: { fields: [{ id: 'q1', label: 'Question one' }] } }
    : { id: 'f-1', name: 'Form 1', fields: [] },
);
vi.mock('$lib/api.js', () => ({
  api: {
    get: (url: string) => get(url),
    post: vi.fn(),
    patch: vi.fn(async () => ({})),
    put: vi.fn(),
    delete: vi.fn(),
    fetch: vi.fn(),
  },
}));
vi.mock('$app/state', () => ({ page: { url: new URL('http://x/admin/forms/f-1') } }));

const resource = {
  id: 'forms',
  label: 'forms',
  layout: 'builder',
  builder: {
    loadEndpoint: '/ext/forms/{id}',
    saveEndpoint: '/ext/forms/{id}',
    fields: [{ name: 'name', label: 'name' }],
    collection: { key: 'fields', itemFields: [{ name: 'label', label: 'label' }] },
    secondary: {
      id: 'responses',
      label: 'responses',
      dataSource: '/ext/forms/{id}/responses',
      dataPath: 'submissions',
      answerLabelsFrom: 'form.fields',
      timestampKey: 'meta.submitted_at',
      dataKey: 'payload.answers',
    },
  },
};

afterEach(cleanup);

describe('BuilderLayout secondary panel', () => {
  it('walks dotted timestamp and data keys', async () => {
    const { default: BuilderLayout } = await import('./BuilderLayout.svelte');
    const { container, getByText } = render(BuilderLayout, {
      props: { resource: resource as any, routeParams: { id: 'f-1' }, extName: 'forms' },
    });

    await waitFor(() => expect(getByText('responses')).toBeTruthy());
    await fireEvent.click(getByText('responses'));

    await waitFor(() => expect(container.textContent).toContain('Question one'));
    expect(container.textContent).toContain('yes');
    expect(container.textContent).not.toContain('Invalid Date');
  }, 60_000);
});
