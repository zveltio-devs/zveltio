// extension-api v1 — FROZEN 2026-10-19 (3.0.0-beta.84). Do not edit.
//
// A verbatim copy of the action/job contract as it shipped. `compat.ts` checks
// that the live types in `src/extension` still accept every extension written
// against this file. A change that makes it fail breaks v1 extensions: make it
// additive instead (a new optional member, a wider union, a new export).

export interface DataApiReadQuery {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  filter?: Record<string, unknown> | string;
  search?: string;
  cursor?: string;
  count?: 'exact' | 'none';
  expand?: string;
}

export type ExtensionAction = (input: unknown, host: ActionHost) => Promise<unknown>;

export interface ActionHost {
  collections: HostCollections;
  timezone: string;
  enqueue(job: string, input: unknown): Promise<string>;
}

export interface HostCollections {
  read(collection: string, id: string): Promise<Record<string, unknown> | null>;
  list(collection: string, query?: DataApiReadQuery): Promise<Record<string, unknown>>;
  insert(collection: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  update(
    collection: string,
    id: string,
    data: Record<string, unknown>,
    options?: { expect?: UpdateExpect },
  ): Promise<Record<string, unknown>>;
  delete(collection: string, id: string): Promise<void>;
}

export type UpdateExpect = Record<string, readonly (string | number | boolean | null)[]>;

export type ExtensionJob = (input: unknown, host: JobHost) => Promise<void>;

export interface JobHost {
  collections: HostCollections;
  timezone: string;
}

export declare const ACTION_REFUSAL: unique symbol;

export type RefusalStatus = 400 | 403 | 404 | 409 | 410 | 412 | 422 | 423 | 429;

export declare class ActionRefusal extends Error {
  readonly [ACTION_REFUSAL]: true;
  readonly status: RefusalStatus;
  readonly code: string;
  constructor(status: RefusalStatus, code: string, message: string);
}

export declare function todayIn(timeZone: string, now?: Date): string;

export interface ZveltioExtensionV1 {
  actions?: Record<string, ExtensionAction>;
  jobs?: Record<string, ExtensionJob>;
}
