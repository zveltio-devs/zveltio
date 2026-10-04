/**
 * Capabilities as TYPES — roadmap R8: "an undeclared capability is a compile
 * error, not a runtime refusal".
 *
 * The engine refuses a gated `ctx.internals` member whose capability the
 * manifest does not declare (`CapabilityDeniedError`). That refusal happens the
 * first time the code path runs — often in production, on the request that
 * needed it. Declaring the capabilities to TypeScript as well moves the same
 * answer to the editor:
 *
 *   export default defineExtension(['ddl', 'secrets'], {
 *     name: 'my-ext',
 *     category: 'tools',
 *     async register(app, ctx) {
 *       await ctx.internals.encryptSecret('x');      // ok: 'secrets'
 *       await ctx.internals.deleteUser(db, 'u');      // compile error: needs 'auth:users'
 *     },
 *   });
 *
 * The list passed to `defineExtension` is a statement to the compiler; the
 * manifest's `permissions` remains what the engine enforces and what an
 * administrator approves. `zveltio extension validate` compares the two.
 *
 * These two tables mirror the engine's `CAPABILITIES` and `INTERNALS_CAPABILITY`
 * (`packages/engine/src/lib/extensions/capabilities.ts`); the engine's unit test
 * `sdk-capability-types.test.ts` fails when they drift apart.
 */

/** Every capability an extension may declare, `net:<host>` aside. */
export const EXTENSION_CAPABILITIES = [
  'db:admin',
  'tenant:enter',
  'ddl',
  'secrets',
  'auth:session',
  'auth:users',
  'identity:provision',
  'audit:read',
  'data:write',
  'data:system',
  'notifications',
  'files',
  'documents',
  'edge-functions',
  'introspection',
  'storage',
  'cron',
  'field-types',
] as const;

/** A capability name, including the parameterised `net:<host>`. */
export type Capability = (typeof EXTENSION_CAPABILITIES)[number] | `net:${string}`;

/** The `ctx.internals` members a capability unlocks. */
export const CAPABILITY_MEMBERS = {
  enqueueDDLJob: 'ddl',
  introspectSchema: 'introspection',
  extensionRegistry: 'introspection',
  encryptSecret: 'secrets',
  decryptSecret: 'secrets',
  deriveTokenHash: 'secrets',
  createBetterAuthSession: 'auth:session',
  deleteUser: 'auth:users',
  revokeUserSessions: 'auth:users',
  setUserActive: 'auth:users',
  liftOwnBan: 'auth:users',
  provisionUser: 'identity:provision',
  listTenantUsers: 'identity:provision',
  updateUserProfile: 'identity:provision',
  addTenantMember: 'identity:provision',
  removeTenantMember: 'identity:provision',
  setTenantMembershipEnd: 'identity:provision',
  readAuditActivity: 'audit:read',
  createRecord: 'data:write',
  updateRecord: 'data:write',
  deleteRecord: 'data:write',
  asSystem: 'data:system',
  sendNotification: 'notifications',
  moveToTrash: 'files',
  generatePDFAsync: 'documents',
  runEdgeFunction: 'edge-functions',
} as const satisfies Record<string, (typeof EXTENSION_CAPABILITIES)[number]>;

/** Members of `ctx.internals` that need a capability. */
export type GatedMember = keyof typeof CAPABILITY_MEMBERS;

/** The gated members the capabilities `C` unlock. */
export type MembersUnlockedBy<C extends string> = {
  [K in GatedMember]: (typeof CAPABILITY_MEMBERS)[K] extends C ? K : never;
}[GatedMember];

/** The gated members `C` does NOT unlock — removed from the narrowed type. */
export type MembersLockedFor<C extends string> = Exclude<GatedMember, MembersUnlockedBy<C>>;
