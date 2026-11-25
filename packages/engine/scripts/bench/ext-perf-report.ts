/**
 * Turns the JSON files `ext-perf.sh` wrote into the tables and the verdict of
 * the ADR 0062 performance probe.   bun ext-perf-report.ts <dir>
 *
 * Thresholds (decided, project_adr_0062_proof_plan): runner p95 <= +20 % over
 * inline; cold start < 150 ms; zero `extension.busy` at the default pool.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '/tmp/ext-perf';
type S = { p50: number; p95: number; perSec: number; busy: number; ok: number; otherErrors: number };
type R = {
  mode: string;
  poolInUse: number;
  poolMax: string;
  boxLimit: number | null;
  lines: Record<string, { seq: S; conc: S }>;
  memory: Record<string, { rss_kb: number; pss_kb: number; cmd: string }[]>;
  cold?: { startToRegistered: { p50: number; p95: number }; startToFirstAction: { p50: number; p95: number } };
  coldUnit?: { systemctlStart: { p50: number }; startToSocket: { p50: number; p95: number } };
};
const runs = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ f, ...(JSON.parse(readFileSync(join(dir, f), 'utf8')) as R) }));
const pool = (r: { f: string }) => /pool([^.]+)\.json/.exec(r.f)![1]!;
const of = (mode: string, p: string) => runs.filter((r) => r.mode === mode && pool(r) === p);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const m = (rs: R[], pick: (r: R) => number) => mean(rs.map(pick));
const f1 = (x: number) => x.toFixed(1);

for (const p of ['default', '40', '10']) {
  const ins = of('inline', p);
  if (!ins.length) continue;
  console.log(`\n### pool ${p} (in use: ${ins[0]!.poolInUse}; worker box limit ${of('runner', p)[0]?.boxLimit}); mean of ${ins.length} rounds\n`);
  console.log('| createInvoice | inline p50/p95 | process p50/p95 | runner p50/p95 | runner p95 vs inline | busy (process/runner) |');
  console.log('|---|---|---|---|---|---|');
  for (const l of ['3', '20']) {
    for (const k of ['seq', 'conc'] as const) {
      const cell = (mode: string) => {
        const rs = of(mode, p);
        return `${f1(m(rs, (r) => r.lines[l]![k].p50))} / ${f1(m(rs, (r) => r.lines[l]![k].p95))}`;
      };
      const ip95 = m(ins, (r) => r.lines[l]![k].p95);
      const rp95 = m(of('runner', p), (r) => r.lines[l]![k].p95);
      const tp = (mode: string) => f1(m(of(mode, p), (r) => r.lines[l]![k].perSec));
      const busy = (mode: string) => of(mode, p).map((r) => r.lines[l]![k].busy).join('+');
      console.log(
        `| ${l} lines, ${k === 'seq' ? 'sequential n=300' : 'concurrency 10 n=500'} | ${cell('inline')}${k === 'conc' ? ` (${tp('inline')}/s)` : ''} | ${cell('process')}${k === 'conc' ? ` (${tp('process')}/s)` : ''} | ${cell('runner')}${k === 'conc' ? ` (${tp('runner')}/s)` : ''} | ${(((rp95 / ip95) - 1) * 100).toFixed(0)} % | ${busy('process')} / ${busy('runner')} |`,
      );
    }
  }
}

const cold = of('runner', 'default').filter((r) => r.cold);
if (cold.length) {
  console.log('\n### cold start on systemd (pool default), ms\n');
  for (const r of cold)
    console.log(`- ${r.f}: unit start -> action served p50 ${r.cold!.startToFirstAction.p50} / p95 ${r.cold!.startToFirstAction.p95}; start -> registered p50 ${r.cold!.startToRegistered.p50}; systemctl start p50 ${r.coldUnit?.systemctlStart.p50}; start -> socket p50 ${r.coldUnit?.startToSocket.p50} / p95 ${r.coldUnit?.startToSocket.p95}`);
}
console.log('\n### memory (pool default; kB)\n');
for (const r of runs.filter((x) => pool(x) === 'default')) {
  if (r.mode === 'runner') {
    const rows = readFileSync(join(dir, r.f.replace('.json', '.mem')), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const when of ['idle', 'after'])
      console.log(`- ${r.f} ${when}: ${rows.filter((x) => x.when === when).map((x) => `${x.cmd.split('/').pop()?.slice(0, 28).trim()} rss ${x.rss_kb} pss ${x.pss_kb}`).join('; ')}`);
  } else
    for (const when of ['idle', 'afterRun'])
      console.log(`- ${r.f} ${when}: ${((r.memory[when] as { rss_kb: number; pss_kb: number; cmd: string }[]) ?? []).map((x) => `${x.cmd.split('/').pop()?.slice(0, 28).trim()} rss ${x.rss_kb} pss ${x.pss_kb}`).join('; ')}`);
}

const worst = (mode: string, p: string) => {
  let w = -Infinity;
  for (const l of ['3', '20']) for (const k of ['seq', 'conc'] as const) {
    const d = m(of(mode, p), (r) => r.lines[l]![k].p95) / m(of('inline', p), (r) => r.lines[l]![k].p95) - 1;
    w = Math.max(w, d);
  }
  return w * 100;
};
const coldP95 = Math.max(...cold.map((r) => r.cold!.startToFirstAction.p95));
const busyDefault = of('runner', 'default').reduce((a, r) => a + r.lines['3']!.conc.busy + r.lines['20']!.conc.busy + r.lines['3']!.seq.busy + r.lines['20']!.seq.busy, 0);
console.log('\n### thresholds\n');
console.log(`- runner p95 <= +20 % vs inline (worst of 4 cells, default pool): ${worst('runner', 'default').toFixed(0)} % -> ${worst('runner', 'default') <= 20 ? 'PASS' : 'FAIL'}`);
console.log(`- cold start < 150 ms (p95 ${coldP95} ms): ${coldP95 < 150 ? 'PASS' : 'FAIL'}`);
console.log(`- zero extension.busy at the default pool (runner): ${busyDefault} -> ${busyDefault === 0 ? 'PASS' : 'FAIL'}`);
