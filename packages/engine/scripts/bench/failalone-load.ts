/**
 * ADR 0062 probe "fail-alone": a steady load on a running engine over HTTP, and
 * from a given second on, calls to a misbehaving extension's action.
 *   bun failalone-load.ts <extension name, e.g. probe/loop> <baseSecs> <totalSecs> <out.jsonl>
 * Load: the data API on probe_notes (GET list and POST alternating, concurrency 5)
 * and createInvoice on finance/invoicing (concurrency 1, 200 ms apart). From
 * <baseSecs> a caller posts <ext>/actions/misbehave, one at a time, 1 s apart,
 * 40 s timeout each. One JSON line per request: {t, kind, ms, status}. The summary
 * (p50/p95 per kind, before and during) is the last line printed.
 * The member's grants are written by failalone.sh.
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const PASSWORD = 'BenchMember123!';
const [ext, baseS, totalS, out] = process.argv.slice(2);
const EMAIL = 'bench-member@test.local';
const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', Origin: BASE },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!signIn.ok) throw new Error(`sign-in ${signIn.status} ${await signIn.text()}`);
const cookie = signIn.headers
  .getSetCookie()
  .map((x) => x.split(';')[0])
  .join('; ');
const H = { 'content-type': 'application/json', cookie, Origin: BASE };
const invoice = {
  client_name: 'Bench Client SRL',
  lines: [0, 1, 2].map((i) => ({
    description: `l${i}`,
    quantity: 2,
    unit_price: 10 + i,
    tax_rate: 19,
  })),
};
const T0 = performance.now();
const baseMs = Number(baseS) * 1000;
const endMs = Number(totalS) * 1000;
type R = { t: number; kind: string; ms: number; status: number };
const rows: R[] = [];
const log: string[] = [];
const bodies: string[] = [];
async function timed(kind: string, url: string, init: RequestInit, timeoutMs: number) {
  const s = performance.now();
  let status = 0;
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    status = res.status;
    if (kind === 'bad' && !bodies.some((b) => b.startsWith(`${status} `)) && bodies.length < 8)
      bodies.push(`${status} ${text.slice(0, 160)}`);
  } catch {
    status = -1; // timeout, reset or refused
  }
  const r = {
    t: Math.round(s - T0),
    kind,
    ms: Math.round((performance.now() - s) * 10) / 10,
    status,
  };
  rows.push(r);
  return r;
}
const alive = () => performance.now() - T0 < endMs;
const data = async (i: number) => {
  for (let n = i; alive(); n++) {
    if (n % 2)
      await timed(
        'data-post',
        `${BASE}/api/data/${process.env.COLL ?? 'probe_notes'}`,
        { method: 'POST', headers: H, body: JSON.stringify({ title: `n${n}` }) },
        10_000,
      );
    else
      await timed(
        'data-list',
        `${BASE}/api/data/${process.env.COLL ?? 'probe_notes'}?limit=20`,
        { headers: H },
        10_000,
      );
  }
};
const inv = async () => {
  while (alive()) {
    await timed(
      'invoice',
      `${BASE}/ext/finance/invoicing/actions/createInvoice`,
      { method: 'POST', headers: H, body: JSON.stringify(invoice) },
      10_000,
    );
    await Bun.sleep(200);
  }
};
const bad = async () => {
  await Bun.sleep(Math.max(0, baseMs - (performance.now() - T0)));
  while (alive()) {
    const r = await timed(
      'bad',
      `${BASE}/ext/${ext}/actions/misbehave`,
      { method: 'POST', headers: H, body: '{}' },
      40_000,
    );
    log.push(`${r.t} bad ${r.status} ${r.ms}ms`);
    await Bun.sleep(1000);
  }
};
await Promise.all([...[0, 1, 2, 3, 4].map(data), inv(), bad()]);
await Bun.write(out!, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null;
};
const summary: Record<string, unknown> = {};
for (const kind of ['data-list', 'data-post', 'invoice', 'bad']) {
  for (const [phase, lo, hi] of [
    ['before', 0, baseMs],
    ['during', baseMs, endMs],
  ] as const) {
    const rs = rows.filter((r) => r.kind === kind && r.t >= lo && r.t < hi);
    const ok = rs.filter((r) => r.status >= 200 && r.status < 300).map((r) => r.ms);
    const codes: Record<string, number> = {};
    for (const r of rs) codes[r.status] = (codes[r.status] ?? 0) + 1;
    summary[`${kind}/${phase}`] = {
      n: rs.length,
      ok: ok.length,
      p50: pct(ok, 50),
      p95: pct(ok, 95),
      codes,
    };
  }
}
console.log(JSON.stringify({ summary, bad_calls: log.slice(0, 12), bad_bodies: bodies }));
