/** Table for ADR 0062 probe "fail-alone": bun failalone-report.ts <outdir> */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2]!;
const runs = readdirSync(dir)
  .filter((f) => f.endsWith('.summary.json'))
  .map((f) => f.replace('.summary.json', ''))
  .sort();
const rd = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const pct = (b: number | null, d: number | null) =>
  b && d ? `${d > b ? '+' : ''}${Math.round(((d - b) / b) * 100)}%` : 'n/a';
console.log(
  '| run | list p95 before>during | post p95 | invoice p95 | requests ok during (list/post/invoice) | first signal after bad start | disabled after bad start | log names ext+key | engine alive after |',
);
console.log('|---|---|---|---|---|---|---|---|---|');
for (const r of runs) {
  const raw = rd(join(dir, `${r}.summary.json`)).trim();
  if (!raw) continue;
  const s = JSON.parse(raw.split('\n').pop()!).summary;
  const t = Object.fromEntries(
    rd(join(dir, `${r}.times`))
      .split('\n')[0]!
      .split(' ')
      .map((kv) => kv.split('=')),
  );
  const bad0 = Number(t.bad_start);
  const log = rd(join(dir, `${r}.log`)).split('\n');
  const at = (re: RegExp) => {
    const l = log.find((x) => re.test(x));
    return l ? `${(Number(l.split(' ')[0]) - bad0).toFixed(1)}s` : 'none';
  };
  const cell = (k: string) =>
    `${s[`${k}/before`].p95}>${s[`${k}/during`].p95} (${pct(s[`${k}/before`].p95, s[`${k}/during`].p95)})`;
  const okd = (k: string) => `${s[`${k}/during`].ok}/${s[`${k}/during`].n}`;
  const named = log.some(
    (l) =>
      /\[ext:probe\/\w+ key=[\w-]+\]/.test(l) ||
      (/event loop blocked/.test(l) && /probe\//.test(l)),
  );
  const alive =
    rd(join(dir, `${r}.times`))
      .split('\n')[1]
      ?.trim() === '200'
      ? 'yes (200)'
      : 'NO';
  console.log(
    `| ${r} | ${cell('data-list')} | ${cell('data-post')} | ${cell('invoice')} | ${okd('data-list')} / ${okd('data-post')} / ${okd('invoice')} | ${at(/crash 1\/5|event loop blocked|timeout:/)} | ${at(/disabled after/)} | ${named ? 'yes' : 'no'} | ${alive} |`,
  );
}
