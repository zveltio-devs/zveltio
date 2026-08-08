/**
 * The sentence a person reads when the product says no.
 *
 * The engine sends a refusal as data — which resource, whether it is
 * confidential, who can grant it — and an English `detail` for logs and curl.
 * The sentence is built here so it arrives in the reader's own language, and so
 * changing how it reads is a change in one file rather than in the engine and
 * twenty-eight extension bundles.
 *
 * Two forms, because they are different facts. "Payroll is confidential" is a
 * rule somebody chose and the reader should not feel accused by it. "You do not
 * have access to invoices" is an omission, and probably a mistake worth fixing.
 * Both end with a name, because a refusal without a next step is a dead end.
 */
import { m } from './i18n.svelte.js';

export interface Denial {
  resource?: string;
  confidential?: boolean;
  canGrant?: Array<{ name: string }>;
}

/** True when this error is a refusal the UI can explain, rather than a failure. */
export function isDenial(e: unknown): e is Error & Denial & { code: string } {
  return Boolean(
    e && typeof e === 'object' && (e as { code?: string }).code === 'permission_required',
  );
}

export function denialMessage(d: Denial): string {
  const resource = d.resource ?? '';
  const what = d.confidential
    ? m['denial.confidential']({ resource })
    : m['denial.noAccess']({ resource });

  const names = (d.canGrant ?? []).map((g) => g.name).filter(Boolean);
  if (names.length === 0) return `${what} ${m['denial.askAdmin']()}`;

  // Joining with the locale's own list separator rather than a hardcoded "or",
  // which would be wrong in most of the nine languages here.
  const who = new Intl.ListFormat(undefined, { type: 'disjunction' }).format(names);
  return `${what} ${m['denial.askPerson']({ name: who })}`;
}
