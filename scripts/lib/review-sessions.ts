/**
 * The order the review checklist reads sessions in: by date, then by the
 * sequence number in the file name (`A04-2026-09-04-2.json` is that day's
 * second), then by name.
 *
 * A section's latest verdict is the LAST session in this order. It was the last
 * file `Bun.Glob` happened to return, and glob order is the directory's — not
 * the dates' — so on one checkout A04 read "2026-09-30 — closed" and on another
 * "2026-09-04 — logged", and the generated checklist rewrote some 600 lines
 * with no session added. Entries from the legacy single file, which carry no
 * name, keep their array order among the same date.
 */
export interface OrderedSession<S> {
  session: S & { date: string };
  /** The ledger file name; absent for the legacy single-file entries. */
  file?: string;
}

const SEQUENCE = /-(\d+)\.json$/;

export function orderSessions<S>(entries: OrderedSession<S>[]): Array<S & { date: string }> {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const byDate = a.e.session.date.localeCompare(b.e.session.date);
      if (byDate !== 0) return byDate;
      const seq = (f?: string) => (f ? Number(SEQUENCE.exec(f)?.[1] ?? 0) : -1);
      const bySeq = seq(a.e.file) - seq(b.e.file);
      if (bySeq !== 0) return bySeq;
      const byName = (a.e.file ?? '').localeCompare(b.e.file ?? '');
      return byName !== 0 ? byName : a.i - b.i;
    })
    .map(({ e }) => e.session);
}
