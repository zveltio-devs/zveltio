/** ADR 0062 probe "restrictive PaaS": one call to each extension as the bench member. Prints one JSON line. */
const BASE = 'http://127.0.0.1:3000';
const H0 = { 'content-type': 'application/json', Origin: BASE };
const si = await fetch(`${BASE}/api/auth/sign-in/email`, {
  method: 'POST',
  headers: H0,
  body: JSON.stringify({ email: 'bench-member@test.local', password: 'BenchMember123!' }),
});
const cookie = si.headers
  .getSetCookie()
  .map((x) => x.split(';')[0])
  .join('; ');
const H = { ...H0, cookie };
const call = async (name: string, url: string, init: RequestInit) => {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    return { [name]: { status: r.status, body: (await r.text()).slice(0, 200) } };
  } catch (e) {
    return { [name]: { error: String(e).slice(0, 100) } };
  }
};
const inv = {
  client_name: 'PaaS SRL',
  lines: [{ description: 'l', quantity: 1, unit_price: 10, tax_rate: 19 }],
};
console.log(
  JSON.stringify({
    signin: si.status,
    ...(await call(
      'inline finance/invoicing createInvoice',
      `${BASE}/ext/finance/invoicing/actions/createInvoice`,
      { method: 'POST', headers: H, body: JSON.stringify(inv) },
    )),
    ...(await call('worker probe/plain ping', `${BASE}/ext/probe/plain/actions/ping`, {
      method: 'POST',
      headers: H,
      body: '{}',
    })),
  }),
);
