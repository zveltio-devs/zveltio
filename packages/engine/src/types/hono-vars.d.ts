/**
 * Global Hono ContextVariableMap — makes c.set/c.get type-safe across all routes
 * without requiring Hono<{ Variables: { user: any } }> on every instance.
 */

export {};

declare module 'hono' {
  interface ContextVariableMap {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    user: any;
    authType: string;
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    tenant: any;
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    environment: any;
  }
}
