/**
 * Today's date, `YYYY-MM-DD`, in `timeZone` (IANA) — what `ActionHost.timezone`
 * and `JobHost.timezone` are for. `new Date().toISOString().slice(0, 10)` is the
 * UTC date: wrong for the hours a non-UTC tenant's day and UTC's differ.
 */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  // en-CA formats a date as ISO YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
