/** Tables from small-vps.sh's <state>.jsonl files: bun small-vps-report.ts <outdir> */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '/tmp/small-vps';
const mb = (kb: number) => (kb / 1024).toFixed(0);
const rows: string[] = [];
for (const state of ['alone', 'inline', 'runner', 'runner-load']) {
  const f = join(dir, `${state}.jsonl`);
  if (!existsSync(f)) continue;
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const boot = lines.find((l) => l.boot_ms);
  for (const phase of new Set(lines.filter((l) => l.group).map((l) => l.phase as string))) {
    const procs = lines.filter((l) => l.phase === phase && l.group);
    const eng = procs.filter((p) => p.group === 'engine');
    const units = procs.filter((p) => p.group !== 'engine');
    const sum = (xs: typeof procs, k: string) => xs.reduce((s, x) => s + x[k], 0);
    const cg = lines.filter((l) => l.phase === phase && l.cgroup);
    const scope = cg.find((c) => c.cgroup === 'engine');
    const unitCur = cg.filter((c) => c.cgroup !== 'engine').reduce((s, c) => s + c.current, 0);
    const sys = lines.find((l) => l.phase === phase && l.system)?.system;
    rows.push(
      [
        `${state}/${phase}`,
        mb(sum(eng, 'pss_kb')), mb(sum(eng, 'rss_kb')),
        new Set(units.map((u) => u.group)).size,
        mb(sum(units, 'pss_kb')), mb(sum(units, 'rss_kb')),
        mb(sum(procs, 'pss_kb')), mb(sum(procs, 'rss_kb')),
        mb((scope?.current ?? 0) / 1024), mb((scope?.peak ?? 0) / 1024),
        mb(((scope?.swap_peak ?? 0)) / 1024), (scope?.events ?? '').match(/oom_kill (\d+)/)?.[1] ?? '?',
        mb(unitCur / 1024),
        sys ? mb(sys.mem_used_kb) : '',
        state === 'alone' || state === 'inline' || phase === 'running' ? (boot?.boot_ms / 1000).toFixed(1) : '',
      ].join(' | '),
    );
  }
}
console.log(
  '| state/phase | engine PSS MB | engine RSS | units | units PSS | units RSS | TOTAL PSS | TOTAL RSS | scope cur | scope peak | scope swap peak | oom_kill | units cgroup cur | system used | boot s |',
);
console.log(`|${' --- |'.repeat(15)}`);
for (const r of rows) console.log(`| ${r} |`);
