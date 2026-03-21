import type { Hono } from 'hono';

// Extension API types — used by extension authors

export interface ExtensionContext {
  db: any; // Kysely Database instance
  auth: any; // Better-Auth instance
  fieldTypeRegistry: FieldTypeRegistryAPI;
}

export interface FieldTypeRegistryAPI {
  register(definition: any): void;
  get(type: string): any;
  has(type: string): boolean;
  list(): string[];
}

export interface ZveltioExtension {
  name: string;
  category: string;
  register: (app: Hono, ctx: ExtensionContext) => Promise<void>;
  registerFieldTypes?: (registry: FieldTypeRegistryAPI) => void;
  getMigrations?: () => string[];
}

// Studio extension API types (available via window.__zveltio)
export interface StudioExtensionAPI {
  registerRoute(route: StudioRoute): void;
  registerFieldType(ft: StudioFieldType): void;
  engineUrl: string;
}

export interface StudioRoute {
  path: string;
  component: any; // Svelte component
  label: string;
  icon: string;
  category: string;
  children?: StudioRoute[];
}

export interface StudioFieldType {
  type: string;
  editor: () => Promise<{ default: any }>;
  display: () => Promise<{ default: any }>;
  filter?: () => Promise<{ default: any }>;
}

export type { Hono };
