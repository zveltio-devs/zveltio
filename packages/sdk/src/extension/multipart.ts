/**
 * Reading a multipart body without turning a bad request into a crash.
 *
 * Six extensions opened an upload handler with
 *
 *     const formData = await c.req.formData();
 *     const file = formData.get('file') as File;
 *     if (!file) return c.json({ error: 'No file provided' }, 400);
 *
 * The 400 on the third line says plainly what the author intended a malformed
 * request to get. It is unreachable: `formData()` throws when the body is not
 * multipart at all — a client that sends JSON, or sends nothing, or gets the
 * content-type wrong — so those requests never reach line three. They surface as
 * an unhandled rejection and a bare 500.
 *
 * That is worth more than tidiness. A 500 tells a caller, a retrying webhook
 * sender, and an uptime monitor that the SERVER is broken, so the client keeps
 * resending a request that can never succeed and the operator is paged for a
 * fault that is not theirs. The same request through this helper gets the 400
 * the handler already meant to send.
 *
 * Deliberately not a middleware: a middleware would have to guess which routes
 * are multipart, and being wrong in either direction is worse than one explicit
 * call per handler.
 */

/**
 * The body every caller sends with the 400. One string, so the six upload
 * handlers cannot drift into six different ways of saying the same thing.
 */
export const MULTIPART_REQUIRED = { error: 'Expected a multipart/form-data body.' } as const;

/**
 * Parse a multipart body, answering `null` rather than throwing when it is not one.
 *
 * ```ts
 * const form = await readMultipart(c);
 * if (!form) return c.json(MULTIPART_REQUIRED, 400);
 * const file = form.get('file');
 * ```
 *
 * Returns `FormData | null` rather than a `{ ok }` result object deliberately.
 * The extensions repo compiles with `strict: false`, and without
 * `strictNullChecks` TypeScript will not narrow a discriminated union on a
 * boolean member — every call site got `Property 'error' does not exist on type
 * MultipartResult`. A nullable return needs no narrowing to be safe under either
 * setting, and reads the same.
 *
 * `c` is typed structurally rather than as Hono's `Context` on purpose: the SDK
 * has never taken a dependency on Hono, and every extension bundles its own
 * copy, so a nominal type here would reject the caller's own context object.
 */
export async function readMultipart(c: {
  req: { formData: () => Promise<FormData> };
}): Promise<FormData | null> {
  try {
    return await c.req.formData();
  } catch {
    // The parser's own message is not passed through. It reads like "FormData
    // parse error" — nothing the caller can act on — and echoing a body parser's
    // internals back over HTTP is how request contents end up in error strings.
    return null;
  }
}
