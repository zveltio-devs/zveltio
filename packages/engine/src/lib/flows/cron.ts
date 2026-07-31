/**
 * Standard 5-field cron, evaluated locally.
 *
 * `routes/flows.ts` accepts `trigger: { type: 'cron', cron: '0 3 * * *' }` and
 * stores it. The scheduler read only `interval_seconds` and fell back to a
 * 60-second default, so a flow an operator scheduled for 03:00 daily ran every
 * minute — 1440 times a day instead of once. That is worse than the inert
 * settings found elsewhere in this codebase: it does not do nothing, it does
 * the wrong thing continuously, and with an `ai_decision` step it does it at
 * a per-call cost.
 *
 * Written here rather than pulled in, because adding a dependency to the engine
 * is a supply-chain decision with its own review, and this is the well-specified
 * 5-field subset:
 *
 *     minute  hour  day-of-month  month  day-of-week
 *     0-59    0-23  1-31          1-12   0-6 (0 = Sunday)
 *
 * Each field accepts `*`, `n`, `a,b,c`, `a-b`, `*&#47;n` and `a-b&#47;n`. Seconds,
 * `@daily`-style macros, `L`/`W`/`#` and named months are NOT supported — an
 * expression using them is rejected rather than approximated, because a
 * schedule that silently means something else is exactly the defect this
 * replaces.
 *
 * Day-of-month and day-of-week follow the standard quirk: when BOTH are
 * restricted the match is an OR, not an AND. `0 0 13 * 5` is "the 13th, and
 * every Friday", not "Friday the 13th".
 */

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** Expand one field into the set of values it matches, or null if malformed. */
function parseField(raw: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    if (stepPart !== undefined && !/^\d+$/.test(stepPart)) return null;
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
    if (step < 1) return null;

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(rangePart!)) {
      lo = Number.parseInt(rangePart!, 10);
      // A bare number with a step means "from n to the end, every step".
      hi = stepPart === undefined ? lo : max;
    } else {
      const m = /^(\d+)-(\d+)$/.exec(rangePart!);
      if (!m) return null;
      lo = Number.parseInt(m[1]!, 10);
      hi = Number.parseInt(m[2]!, 10);
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

/** Parse a 5-field expression. Returns null when it cannot be honoured exactly. */
export function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const minute = parseField(parts[0]!, 0, 59);
  const hour = parseField(parts[1]!, 0, 23);
  const dom = parseField(parts[2]!, 1, 31);
  const month = parseField(parts[3]!, 1, 12);
  const dow = parseField(parts[4]!, 0, 6);
  if (!minute || !hour || !dom || !month || !dow) return null;

  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

/** Whether a given date satisfies the day part, honouring the dom/dow OR rule. */
function dayMatches(f: CronFields, d: Date): boolean {
  if (!f.month.has(d.getMonth() + 1)) return false;
  const domHit = f.dom.has(d.getDate());
  const dowHit = f.dow.has(d.getDay());
  if (f.domRestricted && f.dowRestricted) return domHit || dowHit;
  if (f.domRestricted) return domHit;
  if (f.dowRestricted) return dowHit;
  return true;
}

/**
 * The next time `expr` fires strictly after `from`, or null when the expression
 * cannot be parsed or matches nothing within four years (e.g. `0 0 30 2 *` —
 * February 30th).
 *
 * Searches day by day and only then within the day, so the worst case is about
 * 1500 date checks rather than the two million minutes a naive scan would take.
 */
export function nextCronRun(expr: string, from: Date = new Date()): Date | null {
  const f = parseCron(expr);
  if (!f) return null;

  // Start from the next whole minute after `from`.
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const hours = [...f.hour].sort((a, b) => a - b);
  const minutes = [...f.minute].sort((a, b) => a - b);

  for (let day = 0; day < 366 * 4; day++) {
    const probe = new Date(cursor.getTime());
    probe.setDate(probe.getDate() + day);
    if (!dayMatches(f, probe)) continue;

    // On the first day the search may start mid-day; later days start at 00:00.
    const startHour = day === 0 ? cursor.getHours() : 0;
    for (const h of hours) {
      if (h < startHour) continue;
      const startMinute = day === 0 && h === cursor.getHours() ? cursor.getMinutes() : 0;
      for (const m of minutes) {
        if (m < startMinute) continue;
        const hit = new Date(probe.getTime());
        hit.setHours(h, m, 0, 0);
        if (hit.getTime() > from.getTime()) return hit;
      }
    }
  }
  return null;
}
