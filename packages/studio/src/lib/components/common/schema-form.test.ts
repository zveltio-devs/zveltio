import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FormSchema } from '@zveltio/sdk/extension';

vi.mock('$lib/extension-api.svelte.js', () => ({
  studioApi: { applyFormAlters: (_id: string, schema: FormSchema) => schema },
}));

import SchemaForm from './SchemaForm.svelte';

/**
 * `validateAll()` is the host's submit gate — the users page refuses to send an
 * invite when it returns false. It ran only the field's own `validators` array,
 * and the invite schema declares `required: true` with no validators, so an
 * empty email passed. The native `required` attribute covered it there only
 * because that host happens to wrap the form in Modal's <form>; the component's
 * documented standalone usage had no check at all.
 */
const schema: FormSchema = {
  id: 'test:form',
  fields: [
    { name: 'email', type: 'email', label: 'Email', required: true },
    { name: 'note', type: 'text', label: 'Note' },
  ],
};

afterEach(cleanup);

describe('SchemaForm.validateAll', () => {
  it('fails a required field left empty', () => {
    const { component } = render(SchemaForm, {
      props: { formId: 'test:form', schema, values: { email: '', note: 'x' } },
    });
    expect((component as unknown as { validateAll: () => boolean }).validateAll()).toBe(false);
  });

  it('passes once the required field has a value', () => {
    const { component } = render(SchemaForm, {
      props: { formId: 'test:form', schema, values: { email: 'a@b.c', note: '' } },
    });
    expect((component as unknown as { validateAll: () => boolean }).validateAll()).toBe(true);
  });
});
