/**
 * Refuse edge-function code that reaches the module loader.
 *
 * The sandbox blocks dangerous globals by shadowing them — `Bun`, `process`,
 * `require`, `eval`, `Function`. `import()` cannot be blocked that way, because
 * it is syntax rather than a binding: there is no property on `globalThis` to
 * redefine, and no name to shadow as a parameter.
 *
 * That gap is the whole sandbox. An audit ran, inside an edge function:
 *
 *     typeof process → undefined            (blocked)
 *     typeof Bun     → undefined            (blocked)
 *     Function(…)    → blocked
 *     await import('node:fs')  → ALLOWED
 *       → read /etc/passwd, read the engine's own source,
 *       → WRITE a file that appeared on the host
 *
 * The write is the serious half: anything that can put bytes on the host disk
 * can overwrite the engine it runs beside.
 *
 * The subprocess runner — the default — narrows this but does not close it. It
 * hands the child a minimal environment, so `DATABASE_URL` and the encryption
 * keys do not leak. The child still runs as the same OS user with the same
 * filesystem, so `import('node:fs')` reads and writes exactly what the parent
 * could.
 *
 * WHY A TEXT CHECK IS ENOUGH HERE, WHICH IS USUALLY NOT TRUE
 *
 * A source-level rejection is normally weak, because code can construct what it
 * is forbidden to write. Not here: building an `import` call at runtime needs
 * `eval` or the `Function` constructor, and both already throw inside the
 * sandbox. With those closed, `import(` has to appear literally in the source
 * to run at all. So the check is not a filter over a gap — it is the other side
 * of a door that is already shut.
 *
 * Run against the TRANSPILED output rather than the author's source, so
 * comments and strings that merely mention the word are gone and cannot cause a
 * refusal that reads like a false accusation.
 *
 * WHAT THIS IS NOT
 *
 * Not the isolation decision. Edge functions are authored by the instance
 * administrator, who already has the SQL editor and a shell; the case that
 * needs real isolation is the day a TENANT can deploy code, and that trigger is
 * recorded in `SECURITY-AUDIT.md` § WASM-01. This closes the arbitrary
 * read/write that exists today, cheaply, without waiting for that decision.
 */

/** The one form that reaches the module loader. */
const DYNAMIC_IMPORT = /\bimport\s*\(/;

/**
 * Returns an error message when `transpiledCode` reaches the module loader, or
 * `null` when it is clean.
 *
 * Takes transpiled JavaScript, not TypeScript source — see the note above.
 */
export function findDynamicImport(transpiledCode: string): string | null {
  if (!DYNAMIC_IMPORT.test(transpiledCode)) return null;
  return (
    'Edge functions cannot import modules: `import()` reaches the module ' +
    'loader, which is how the sandbox is escaped. Static `import` statements ' +
    'and `require` are unavailable for the same reason. Use the bindings ' +
    'provided to the handler — `fetch` is already there and is SSRF-guarded.'
  );
}
