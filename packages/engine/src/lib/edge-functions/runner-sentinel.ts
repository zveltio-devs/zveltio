/**
 * The argument that tells a compiled binary to be an edge-function runner
 * rather than an engine.
 *
 * Its own module so that `binary-entry.ts` can read it without importing the
 * runner — and therefore without importing anything the runner pulls in — while
 * the runner still owns the name.
 */
export const EDGE_RUNNER_SENTINEL = '__edge-runner';

/**
 * Whether this process is a compiled binary rather than `bun` running source.
 *
 * In a compiled binary the module graph lives in a virtual filesystem, so
 * `Bun.main` and `argv[1]` point inside `/$bunfs/`. Measured in a real binary:
 *
 *   execPath = /tmp/binprobe
 *   argv     = ["bun", "/$bunfs/root/binprobe"]
 *
 * It matters because `process.execPath` is then the ENGINE, and spawning
 * `<execPath> run <file>` re-executes the engine with two arguments instead of
 * running the file.
 */
export function runningAsCompiledBinary(): boolean {
  const main = typeof Bun !== 'undefined' ? (Bun.main ?? '') : '';
  return main.startsWith('/$bunfs/') || (process.argv[1] ?? '').startsWith('/$bunfs/');
}

/**
 * How to ask an interpreter to run the bootstrap, given what kind it is.
 *
 * Pure and exported so both branches can be asserted without compiling a binary
 * — the compile-and-run check is a separate gate, because a unit test cannot
 * see a build-entry mistake and this cannot see a runtime one.
 */
export function runnerInterpreterArgs(isCompiledBinary: boolean): string[] {
  return isCompiledBinary ? [EDGE_RUNNER_SENTINEL] : ['run'];
}
