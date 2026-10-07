/**
 * No harness file replaces a process-wide timer.
 *
 * `bun test` runs every harness file in one process, beside the pg-boss DDL
 * queue the app boots. ghost-ddl-index-names replaced `globalThis.setTimeout`
 * for one GhostDDL run to catch its cleanup; every timer set meanwhile was
 * swallowed with it, among them each pg-boss worker's poll delay, so those
 * workers never polled again and every later DDL job sat queued until its test
 * timed out — Handler Coverage, red on most runs since 2026-09-30. A test that
 * needs a timer's callback takes it from the code that set it.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HARNESS = join(import.meta.dir, '..', 'harness');
const REPLACES_TIMER =
  /\b(?:globalThis|global|window)\s*\.\s*(?:setTimeout|setInterval|clearTimeout|clearInterval|setImmediate)\s*=(?!=)/;

describe('harness tests', () => {
  it('never assign a global timer', () => {
    const offenders = readdirSync(HARNESS)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => REPLACES_TIMER.test(readFileSync(join(HARNESS, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
