/**
 * Global Hono ContextVariableMap — makes c.set/c.get type-safe across all routes
 * without requiring Hono<{ Variables: { user: any } }> on every instance.
 */

export {};

declare module 'hono' {
  interface ContextVariableMap {
    user: any;
    authType: string;
    tenant: any;
    environment: any;
  }
}
