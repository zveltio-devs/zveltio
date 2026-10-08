import type { ServiceRegistry } from '@zveltio/sdk/extension';

/**
 * Inter-extension service registry implementation.
 *
 * Extensions publish services via `register()` for other extensions to consume.
 * This is the engine's Drupal-style services container — it is the ONLY supported
 * mechanism for cross-extension communication. Direct imports between extensions
 * are forbidden by convention.
 *
 * Ownership model:
 *   - The global registry tracks (name -> { value, owner }).
 *   - Each extension receives a *scoped* view via `scope(extName)` — register/
 *     unregister calls through that view are tagged with the extension name.
 *   - On extension unload, `unregisterAll(extName)` removes all services owned
 *     by that extension. Hot-reload becomes safe because re-registering from
 *     the same owner is treated as replacement.
 *
 * Naming rule (enforced by `scope`): an extension registers only
 * `<its name>.<feature>` — `ai.providers`, `operations/inventory.products.list` —
 * and reads only services owned by itself, by an extension its manifest names
 * in `dependencies` / `optionalDependencies`, or named in ENGINE_PUBLIC_SERVICES.
 */
interface Entry {
  value: unknown;
  owner: string;
}

/** Engine-owned services an extension may read without declaring anything. None yet. */
export const ENGINE_PUBLIC_SERVICES: ReadonlySet<string> = new Set();

/** The extension whose namespace `name` is in (extension names carry no dot); '' for none. */
function namespaceOf(name: string): string {
  const dot = name.indexOf('.');
  return dot < 0 ? '' : name.slice(0, dot);
}

/** Why `extName` may not register `name`, or null. */
export function serviceRegisterRefusal(extName: string, name: string): string | null {
  // A dot in the extension name would make `a.` a prefix of `a.b.`.
  if (extName.includes('.') || namespaceOf(name) !== extName) {
    return `extension "${extName}" may register only services named "${extName}.<name>"`;
  }
  return null;
}

/**
 * Why `caller` may not use `name`, owned by `owner`, or null. `mayCall` is its
 * manifest `dependencies` + `optionalDependencies`; `engine` in it opens nothing.
 */
export function serviceCallRefusal(
  caller: string,
  mayCall: ReadonlySet<string>,
  owner: string,
  name: string,
): string | null {
  if (owner === caller) return null;
  if (owner === 'engine') {
    return ENGINE_PUBLIC_SERVICES.has(name)
      ? null
      : `extension "${caller}" may not call service "${name}": it is not an engine-public service`;
  }
  if (mayCall.has(owner)) return null;
  return (
    `extension "${caller}" may not call service "${name}": ` +
    `declare "${owner}" in its manifest dependencies or optionalDependencies`
  );
}

export class ServiceRegistryImpl {
  private services = new Map<string, Entry>();
  private waiters = new Map<string, Array<(value: unknown) => void>>();

  has(name: string): boolean {
    return this.services.has(name);
  }

  get<T = unknown>(name: string): T | null {
    const e = this.services.get(name);
    return e ? (e.value as T) : null;
  }

  list(): string[] {
    return [...this.services.keys()];
  }

  /** The extension (or `'engine'`) that registered `name`, or null. */
  ownerOf(name: string): string | null {
    return this.services.get(name)?.owner ?? null;
  }

  /**
   * Internal full-context register.
   * @param owner   Extension name claiming this service. Use `'engine'` for core.
   * @param name    Service name.
   * @param value   The service value (object/function/anything).
   * @throws If a *different* owner already holds the name.
   */
  registerAs(owner: string, name: string, value: unknown): void {
    const existing = this.services.get(name);
    if (existing && existing.owner !== owner) {
      throw new Error(
        `Service "${name}" is already registered by extension "${existing.owner}". ` +
          `Extension "${owner}" must use a different name.`,
      );
    }
    this.services.set(name, { value, owner });
    const pending = this.waiters.get(name);
    if (pending) {
      pending.forEach((resolve) => resolve(value));
      this.waiters.delete(name);
    }
  }

  /** Remove a service if owner matches. No-op if not present or owned by someone else. */
  unregisterAs(owner: string, name: string): void {
    const existing = this.services.get(name);
    if (existing && existing.owner === owner) {
      this.services.delete(name);
    }
  }

  /** Remove every service owned by `owner`. Called by the extension loader on unload. */
  unregisterAll(owner: string): void {
    for (const [name, entry] of this.services) {
      if (entry.owner === owner) this.services.delete(name);
    }
  }

  async waitFor<T = unknown>(name: string, timeoutMs = 30_000): Promise<T> {
    const e = this.services.get(name);
    if (e) return e.value as T;
    return new Promise<T>((resolve, reject) => {
      const wrapped = (v: unknown) => {
        clearTimeout(timer);
        resolve(v as T);
      };
      const timer = setTimeout(() => {
        const arr = this.waiters.get(name);
        if (arr) {
          const idx = arr.indexOf(wrapped);
          if (idx >= 0) arr.splice(idx, 1);
        }
        reject(new Error(`Timeout waiting for service "${name}" after ${timeoutMs}ms`));
      }, timeoutMs);
      if (!this.waiters.has(name)) this.waiters.set(name, []);
      this.waiters.get(name)!.push(wrapped);
    });
  }

  /**
   * The `ServiceRegistry` an extension gets as `ctx.services`. Its registrations
   * are attributed to `extName` and held to its namespace; its reads are held to
   * the owners in `mayCall` (manifest `dependencies` + `optionalDependencies`)
   * — the rule the worker broker applies, so an inline extension is under it too.
   * A name nobody registered reads as absent (`null`): an optional dependency
   * that is not installed. The engine's own scope is unrestricted.
   */
  scope(extName: string, mayCall: Iterable<string> = []): ServiceRegistry {
    if (extName === 'engine') {
      return {
        register: <T>(name: string, value: T) => this.registerAs(extName, name, value),
        unregister: (name: string) => this.unregisterAs(extName, name),
        get: <T>(name: string) => this.get<T>(name),
        has: (name: string) => this.has(name),
        waitFor: <T>(name: string, timeoutMs?: number) => this.waitFor<T>(name, timeoutMs),
        list: () => this.list(),
      };
    }
    const allowed = new Set(mayCall);
    /** Throws when the registered `name` belongs to an owner `extName` did not declare. */
    const check = (name: string): void => {
      const owner = this.ownerOf(name);
      const refusal = owner && serviceCallRefusal(extName, allowed, owner, name);
      if (refusal) throw new Error(refusal);
    };
    return {
      register: <T>(name: string, value: T) => {
        const refusal = serviceRegisterRefusal(extName, name);
        if (refusal) throw new Error(refusal);
        this.registerAs(extName, name, value);
      },
      unregister: (name: string) => this.unregisterAs(extName, name),
      get: <T>(name: string) => {
        check(name);
        return this.get<T>(name);
      },
      has: (name: string) => {
        check(name);
        return this.has(name);
      },
      waitFor: async <T>(name: string, timeoutMs?: number) => {
        const value = await this.waitFor<T>(name, timeoutMs);
        check(name);
        return value;
      },
      list: () => this.list(),
    };
  }
}

/** Process-wide singleton. */
export const serviceRegistry = new ServiceRegistryImpl();
