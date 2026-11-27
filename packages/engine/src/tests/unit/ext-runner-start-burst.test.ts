// ADR 0062 step 2b, start burst: a runner unit started from down runs its first
// START_BURST_MS at 20% with a 1 s CPU period, then the engine puts the unit's
// own quota and the 100 ms period back (F26). A fake `systemctl` on PATH records what the engine asks systemd.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startUnit } from '../../lib/ext-runner.js';

const dir = mkdtempSync(join(tmpdir(), 'burst-'));
const log = join(dir, 'log');
const path = process.env.PATH;
const U = 'zveltio-ext-runner@acme_x_1234abcd.service';
const LIFT = `set-property --runtime ${U} CPUQuota=20% CPUQuotaPeriodSec=1s`;
const END = `set-property --runtime ${U} CPUQuota=10% CPUQuotaPeriodSec=`;
const TEMPLATE = '# /etc/systemd/system/zveltio-ext-runner@.service\n[Service]\nCPUQuota=10%\n';
const RUNTIME = `# /run/systemd/system.control/${U}.d/50-CPUQuota.conf\n[Service]\nCPUQuota=20%\n`;

beforeAll(() => {
  writeFileSync(
    join(dir, 'systemctl'),
    `#!/bin/sh
shift # --no-ask-password
echo "$*" >> "$FAKE_LOG"
[ "$*" = "$FAKE_FAIL" ] && { echo refused >&2; exit 1; }
[ "$1" = cat ] && { printf '%s' "$FAKE_CAT"; exit 0; }
[ "$1" = show ] && printf 'ActiveState=%s\\nCPUQuotaPeriodUSec=%s\\n' "$FAKE_STATE" "$FAKE_PERIOD"
exit 0
`,
  );
  chmodSync(join(dir, 'systemctl'), 0o755);
  process.env.PATH = `${dir}:${path}`;
  process.env.FAKE_LOG = log;
});
afterAll(() => {
  process.env.PATH = path;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  writeFileSync(log, '');
  process.env.FAKE_STATE = 'inactive';
  process.env.FAKE_PERIOD = 'infinity';
  process.env.FAKE_FAIL = '';
  process.env.FAKE_CAT = TEMPLATE + RUNTIME;
});
// Without the reads (`show`, `cat`): what the engine asks systemd to do.
const calls = () =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l && !/^(show|cat) /.test(l));

describe('startUnit (start burst)', () => {
  it('starts a unit that was down in its burst, and ends the burst after it', async () => {
    await startUnit(U, 50);
    expect(calls().sort()).toEqual([LIFT, `start ${U}`].sort());
    await Bun.sleep(120);
    expect(calls().at(-1)).toBe(END);
  });

  it('gives a running unit no burst and does not start it again', async () => {
    process.env.FAKE_STATE = 'active';
    await startUnit(U, 50);
    await Bun.sleep(80);
    expect(calls()).toEqual([]);
  });

  // The engine died in a burst: the unit is handed no channel before it ends.
  it('ends a burst left on a running unit before returning', async () => {
    process.env.FAKE_STATE = 'active';
    process.env.FAKE_PERIOD = '1s';
    await startUnit(U, 50);
    expect(calls()).toEqual([END]);
  });

  it('stops a unit whose burst cannot be ended', async () => {
    process.env.FAKE_STATE = 'active';
    process.env.FAKE_PERIOD = '1s';
    process.env.FAKE_FAIL = END;
    await expect(startUnit(U, 50)).rejects.toThrow('left in its start burst');
    expect(calls()).toEqual([END, `stop ${U}`]);
  });

  it('stops the unit when the end of its burst is refused', async () => {
    process.env.FAKE_FAIL = END;
    await startUnit(U, 30);
    await Bun.sleep(120);
    expect(calls()).toContain(`stop ${U}`);
  });

  it('ends the burst of a start that failed, and says why it failed', async () => {
    process.env.FAKE_FAIL = `start ${U}`;
    await expect(startUnit(U, 30)).rejects.toThrow('refused');
    await Bun.sleep(80);
    expect(calls().at(-1)).toBe(END);
  });

  // The unit's own quota, never the engine's runtime drop-in, and never lowered.
  it("puts an operator's quota back and never lowers it", async () => {
    process.env.FAKE_CAT = `${TEMPLATE}# /etc/systemd/system/${U}.d/cpu.conf\n[Service]\nCPUQuota=50%\n${RUNTIME}`;
    await startUnit(U, 30);
    await Bun.sleep(80);
    expect(calls()).toContain(`set-property --runtime ${U} CPUQuota=50% CPUQuotaPeriodSec=1s`);
    expect(calls().at(-1)).toBe(`set-property --runtime ${U} CPUQuota=50% CPUQuotaPeriodSec=`);
  });

  // An empty CPUQuota= in the unit's files is no cap; the end must not invent one.
  it('keeps an uncapped unit uncapped', async () => {
    process.env.FAKE_CAT = `${TEMPLATE}# /etc/systemd/system/${U}.d/cpu.conf\n[Service]\nCPUQuota=\n`;
    await startUnit(U, 30);
    await Bun.sleep(80);
    expect(calls().at(-1)).toBe(`set-property --runtime ${U} CPUQuota= CPUQuotaPeriodSec=`);
  });

  // A polkit rule an older `setup` wrote: the start goes on, capped, and
  // nothing is left to end.
  it('starts without a burst when the burst is refused', async () => {
    process.env.FAKE_FAIL = LIFT;
    await startUnit(U, 30);
    await Bun.sleep(80);
    expect(calls().sort()).toEqual([LIFT, `start ${U}`].sort());
  });
});
