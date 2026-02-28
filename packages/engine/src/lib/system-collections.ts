/**
 * System Collections — Better-Auth tables exposed as read-accessible collections in Studio.
 *
 * These are NOT user-defined collections (no DDL operations allowed).
 * They are registered so Studio can browse/edit the underlying auth tables directly.
 */

export interface SystemCollectionField {
  name: string;
  type: string;
  required: boolean;
}

export interface SystemCollection {
  name: string;
  tableName: string;
  displayName: string;
  icon: string;
  isSystem: true;
  readonly: boolean;
  fields: SystemCollectionField[];
}

export const SYSTEM_COLLECTIONS: SystemCollection[] = [
  {
    name: 'user',
    tableName: 'user',
    displayName: 'Users',
    icon: 'Users',
    isSystem: true,
    readonly: false,
    fields: [
      { name: 'id', type: 'uuid', required: true },
      { name: 'name', type: 'text', required: true },
      { name: 'email', type: 'email', required: true },
      { name: 'emailVerified', type: 'boolean', required: false },
      { name: 'image', type: 'text', required: false },
      { name: 'createdAt', type: 'datetime', required: true },
      { name: 'updatedAt', type: 'datetime', required: true },
      { name: 'role', type: 'text', required: false },
    ],
  },
  {
    name: 'session',
    tableName: 'session',
    displayName: 'Sessions',
    icon: 'Key',
    isSystem: true,
    readonly: true, // sessions are read-only — managed by Better-Auth
    fields: [
      { name: 'id', type: 'uuid', required: true },
      { name: 'userId', type: 'uuid', required: true },
      { name: 'token', type: 'text', required: true },
      { name: 'expiresAt', type: 'datetime', required: true },
      { name: 'createdAt', type: 'datetime', required: true },
    ],
  },
];

/** Returns the system collection definition for a given name, or undefined. */
export function getSystemCollection(name: string): SystemCollection | undefined {
  return SYSTEM_COLLECTIONS.find((c) => c.name === name);
}
