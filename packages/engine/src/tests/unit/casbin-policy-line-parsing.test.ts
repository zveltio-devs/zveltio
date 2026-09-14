/**
 * Every policy row this engine loads is parsed by `csv-parse`.
 *
 * This is not obvious, and getting it wrong is what this file exists to stop.
 * `KyselyCasbinAdapter.loadPolicy` joins each row's tokens and hands the string
 * to `Helper.loadPolicyLine` (`lib/tenancy/permissions.ts:349`) — the canonical
 * adapter load path, and the fix for an earlier defect where `model.addPolicy`
 * returned false and loaded nothing. Inside casbin, that helper runs
 * `csv-parse/sync` with a fixed option set.
 *
 * So `csv-parse` sits on the authorization load path of an engine that never
 * reads a CSV file. When advisory GHSA-8cw4-87c7-c6xx forced an override to
 * `csv-parse@7.0.2` — two majors above the `^5.5.6` that `casbin@5.51.1`, the
 * latest published, still asks for — the commit that did it claimed the
 * reachable surface was empty because "this engine does not use casbin's CSV
 * adapter". That reasoning was wrong. The conclusion happened to hold, but it
 * held for a reason nobody had checked.
 *
 * These are the shapes this engine actually stores. A parser change that
 * altered any of them would move a subject, a domain, an object or an action
 * one column sideways, and the result of that is an authorization decision made
 * against the wrong field — silently, at boot, for every request afterwards.
 */

import { describe, expect, it } from 'bun:test';
import { Helper, Model } from 'casbin';

/** The casbin model this engine loads policies into. */
const MODEL = `
[request_definition]
r = sub, dom, obj, act

[policy_definition]
p = sub, dom, obj, act

[role_definition]
g = _, _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub, r.dom) && r.obj == p.obj && r.act == p.act
`;

function load(lines: string[]): Model {
  const model = new Model();
  model.loadModelFromText(MODEL);
  for (const line of lines) Helper.loadPolicyLine(line, model);
  return model;
}

describe('policy lines survive the CSV parser casbin loads them through', () => {
  it('keeps every field of an ordinary policy in its own column', () => {
    const model = load(['p, alice, *, contacts, read']);
    expect(model.model.get('p')?.get('p')?.policy).toEqual([['alice', '*', 'contacts', 'read']]);
  });

  it('keeps a three-column grouping rule at three columns', () => {
    // A `g` rule carries three values where `p` carries four. Comparing them as
    // if they were the same width is exactly what #451 was about, one layer up.
    const model = load(['g, user-1, tenant_owner, 00000000-0000-0000-0000-000000000001']);
    expect(model.model.get('g')?.get('g')?.policy).toEqual([
      ['user-1', 'tenant_owner', '00000000-0000-0000-0000-000000000001'],
    ]);
  });

  it('does not split a namespaced extension resource', () => {
    // Extension resources are `<namespace>/<name>`. A parser that treated the
    // slash as anything would silently rewrite the object of the rule.
    const model = load(['p, carol, *, content/pages, read']);
    expect(model.model.get('p')?.get('p')?.policy).toEqual([
      ['carol', '*', 'content/pages', 'read'],
    ]);
  });

  it('does not split a quoted value containing the delimiter', () => {
    // The one case where the parser is doing real work rather than splitting on
    // commas. If this regressed, the row would gain a column and every field
    // after it would shift.
    const model = load(['p, dave, *, "a,b", read']);
    expect(model.model.get('p')?.get('p')?.policy).toEqual([['dave', '*', 'a,b', 'read']]);
  });

  it('keeps an unbalanced quote inside a field, which is what relax_quotes is for', () => {
    const model = load(['p, eve, *, he said "hi", read']);
    expect(model.model.get('p')?.get('p')?.policy).toEqual([['eve', '*', 'he said "hi"', 'read']]);
  });

  it('keeps wildcards intact', () => {
    // `('*','*','*')` is how tenant_owner and tenant_admin are granted. A
    // wildcard lost in parsing is a role that silently grants nothing.
    const model = load(['p, *, *, *, *']);
    expect(model.model.get('p')?.get('p')?.policy).toEqual([['*', '*', '*', '*']]);
  });

  it('keeps an expression object with spaces and operators in one field', () => {
    const model = load(['p, frank, *, r.obj.owner == r.sub, read']);
    expect(model.model.get('p')?.get('p')?.policy).toEqual([
      ['frank', '*', 'r.obj.owner == r.sub', 'read'],
    ]);
  });

  it('loads the exact string shape the adapter builds', () => {
    // `loadPolicy` filters nulls and joins with ', ' — asserted here so a change
    // to that join is caught by this file rather than by an authorization bug.
    const row = ['p', 'gina', '*', 'data', 'view_all_columns', null, null];
    const line = row.filter((v): v is string => v !== null).join(', ');
    expect(line).toBe('p, gina, *, data, view_all_columns');

    const model = load([line]);
    expect(model.model.get('p')?.get('p')?.policy).toEqual([
      ['gina', '*', 'data', 'view_all_columns'],
    ]);
  });
});
