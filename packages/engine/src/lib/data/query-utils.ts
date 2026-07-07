/**
 * Escapes LIKE metacharacters in a string so it is treated as a literal
 * value in a PostgreSQL LIKE / ILIKE expression.
 *
 * Escaped characters: \ % _
 */
export function escapeLike(s: string): string {
  return s.replace(/([\\%_])/g, '\\$1');
}
