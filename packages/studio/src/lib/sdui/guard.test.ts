import { describe, expect, it } from 'vitest';
import { isOwnNamespace } from './guard.js';

describe('isOwnNamespace', () => {
  it('accepts the namespace root and anything under it', () => {
    expect(isOwnNamespace('hr', '/ext/hr')).toBe(true);
    expect(isOwnNamespace('hr', '/ext/hr/employees')).toBe(true);
    expect(isOwnNamespace('hr', '/ext/hr/employees/42')).toBe(true);
  });

  it('refuses core endpoints and a neighbouring extension', () => {
    expect(isOwnNamespace('hr', '/api/users')).toBe(false);
    expect(isOwnNamespace('hr', '/ext/payroll/runs')).toBe(false);
    // A longer name that merely starts with ours is a different extension.
    expect(isOwnNamespace('hr', '/ext/hrx/secrets')).toBe(false);
  });

  it('refuses a path that escapes the namespace with "..", as fetch() resolves it', () => {
    // fetch() normalizes before the request leaves the browser, so a raw
    // prefix test would accept this and the call would reach /api/users.
    expect(isOwnNamespace('hr', '/ext/hr/../../api/users')).toBe(false);
    expect(isOwnNamespace('hr', '/ext/hr/a/../../payroll/runs')).toBe(false);
  });

  it('refuses an absolute URL to another origin', () => {
    expect(isOwnNamespace('hr', 'https://evil.example/ext/hr/x')).toBe(false);
  });

  it('accepts the data API of a collection the extension declares, and of no other', () => {
    const own = ['projects', 'tasks'];
    expect(isOwnNamespace('hr', '/api/data/projects', own)).toBe(true);
    expect(isOwnNamespace('hr', '/api/data/tasks/42?x=1', own)).toBe(true);
    expect(isOwnNamespace('hr', '/api/data/invoices', own)).toBe(false);
    expect(isOwnNamespace('hr', '/api/data/projects')).toBe(false);
    expect(isOwnNamespace('hr', '/api/data/projects/42/history', own)).toBe(false);
    expect(isOwnNamespace('hr', '/api/data/projects/../invoices', own)).toBe(false);
    expect(isOwnNamespace('hr', '/api/data/projects/%2e%2e/invoices', own)).toBe(false);
    expect(isOwnNamespace('hr', '/api/users', own)).toBe(false);
    expect(isOwnNamespace('hr', 'https://evil.example/api/data/projects', own)).toBe(false);
  });
});
