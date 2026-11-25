/**
 * ADR 0062 probe "small VPS": a member calls `finance/invoicing` `createInvoice`
 * (3 lines) against a running engine over HTTP, from outside.
 *   bun small-vps-load.ts setup <email>            sign up, print the user id
 *   bun small-vps-load.ts run <seconds> <concurrency> <email>
 * The member's grants are written by small-vps.sh (SQL, before the engine boots).
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const PASSWORD = 'BenchMember123!';
const ORIGIN = { Origin: BASE };
const [cmd, a, b, c] = process.argv.slice(2);

const post = (path: string, body: unknown, cookie = '') =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, ...ORIGIN },
    body: JSON.stringify(body),
  });

if (cmd === 'setup') {
  const res = await post('/api/auth/sign-up/email', { email: a, password: PASSWORD, name: 'Bench' });
  if (!res.ok) throw new Error(`sign-up ${res.status} ${await res.text()}`);
  console.log(((await res.json()) as { user: { id: string } }).user.id);
  process.exit(0);
}

const secs = Number(a);
const conc = Number(b);
const signIn = await post('/api/auth/sign-in/email', { email: c, password: PASSWORD });
if (!signIn.ok) throw new Error(`sign-in ${signIn.status} ${await signIn.text()}`);
const cookie = signIn.headers
  .getSetCookie()
  .map((x) => x.split(';')[0])
  .join('; ');
const body = {
  client_name: 'Bench Client SRL',
  lines: [0, 1, 2].map((i) => ({ description: `line ${i}`, quantity: 2, unit_price: 10 + i, tax_rate: 19 })),
};
const call = () => post('/ext/finance/invoicing/actions/createInvoice', body, cookie);

type O = { ms: number; status: number; busy: boolean; body?: string };
const one = async (): Promise<O> => {
  const t = performance.now();
  const res = await call();
  const text = await res.text();
  return {
    ms: performance.now() - t,
    status: res.status,
    busy: text.includes('extension.busy'),
    body: res.status === 200 ? undefined : text.slice(0, 200),
  };
};
for (let i = 0; i < 10; i++) {
  const w = await one();
  if (w.status !== 200) throw new Error(`warm-up ${w.status} ${w.body}`);
}
const out: O[] = [];
const end = performance.now() + secs * 1000;
const t0 = performance.now();
await Promise.all(
  Array.from({ length: conc }, async () => {
    while (performance.now() < end) out.push(await one());
  }),
);
const wall = performance.now() - t0;
const ok = out.filter((o) => o.status === 200).map((o) => o.ms).sort((x, y) => x - y);
const pct = (p: number) => ok[Math.min(ok.length - 1, Math.ceil((p / 100) * ok.length) - 1)];
console.log(
  JSON.stringify({
    concurrency: conc,
    seconds: +(wall / 1000).toFixed(1),
    total: out.length,
    ok: ok.length,
    busy: out.filter((o) => o.busy).length,
    otherErrors: out.filter((o) => o.status !== 200 && !o.busy).length,
    firstError: out.find((o) => o.status !== 200 && !o.busy)?.body ?? null,
    p50: +pct(50)!.toFixed(1),
    p95: +pct(95)!.toFixed(1),
    max: +ok[ok.length - 1]!.toFixed(1),
    perSec: +(ok.length / (wall / 1000)).toFixed(1),
  }),
);
