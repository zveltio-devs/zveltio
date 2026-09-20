/**
 * Pager arithmetic for declarative pages.
 *
 * `totalPath` is optional in the schema. When it is absent the renderer has no
 * row count, only the page it just received — so "is there a next page?" must
 * be answered from the page being full, not from a total it does not have.
 */

/** Rows came back for page `pageNum`; is there a page after it? */
export function hasNextPage(opts: {
  limit: number;
  pageNum: number;
  rowCount: number;
  /** Row count reported by the server; `undefined` when the schema has no `totalPath`. */
  total?: number;
}): boolean {
  const { limit, pageNum, rowCount, total } = opts;
  if (!limit || limit < 1) return false;
  if (total === undefined) return rowCount >= limit;
  return pageNum * limit < total;
}

/** Whether the pager is worth rendering at all. */
export function showPager(opts: {
  limit: number;
  pageNum: number;
  rowCount: number;
  total?: number;
}): boolean {
  return opts.pageNum > 1 || hasNextPage(opts);
}
