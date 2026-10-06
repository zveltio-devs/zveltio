/**
 * The source message keys a compiled Paraglide module does not export as a
 * function. Empty means the compile carried every message across.
 */
export function missingMessageKeys(sourceKeys: Iterable<string>, compiled: object): string[] {
  const exports = compiled as Record<string, unknown>;
  return [...sourceKeys].filter((key) => typeof exports[key] !== 'function');
}
