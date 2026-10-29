// A declarative page may name the data API of a collection its extension declares
// (ADR 0012), and of no other; every other core endpoint stays foreign.
import { describe, expect, it } from 'bun:test';
import { validateSduiSchema } from '../validate/index.js';

const foreign = (endpoint: string, collections?: string[]) =>
  validateSduiSchema({
    schema: { title: 't', resources: [{ name: 'r', dataSource: endpoint }] },
    extName: 'projects/management',
    collections,
  })
    .filter((e) => e.code === 'SDUI_ENDPOINT_FOREIGN')
    .map((e) => e.message.split('"')[1]);

describe('SDUI data API endpoints', () => {
  it('allows its own collection and one of its records', () => {
    for (const e of [
      '/api/data/projects',
      '/api/data/projects?limit=5',
      '/api/data/projects/{id}',
      '/api/data/projects/:id',
      '/api/data/tasks/0b9c5c3e-1d2a-4f6b-9a1e-2c3d4e5f6a7b',
    ]) {
      expect(foreign(e, ['projects', 'tasks'])).toEqual([]);
    }
  });

  it('refuses a collection it does not declare, and any data path without a declaration', () => {
    expect(foreign('/api/data/invoices', ['projects'])).toEqual(['/api/data/invoices']);
    expect(foreign('/api/data/projects')).toEqual(['/api/data/projects']);
  });

  it('refuses every other path, a deeper one and a dot segment included', () => {
    for (const e of [
      '/api/users',
      '/api/data',
      '/api/data/projects/{id}/history',
      '/api/data/projects/../users',
      '/api/data/projects/..',
      '/api/collections/projects',
      '/api/data/Projects',
    ]) {
      expect(foreign(e, ['projects'])).toEqual([e]);
    }
  });
});
