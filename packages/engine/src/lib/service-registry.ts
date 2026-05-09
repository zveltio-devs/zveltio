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
 * Naming convention (recommended): `<extension>.<feature>` or
 * `<extension>.<resource>.<verb>`. Examples: `ai.providers`, `ai.embed`,
 * `crm.contacts.lookup`.
 */
interface Entry { value: unknown; owner: string }

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
   * Returns a `ServiceRegistry` view scoped to the given extension. Calls to
   * register/unregister through the returned object are attributed to `extName`.
   * Read methods (get/has/waitFor/list) are unrestricted.
   */
  scope(extName: string): ServiceRegistry {
    return {
      register: <T>(name: string, value: T) => this.registerAs(extName, name, value),
      unregister: (name: string) => this.unregisterAs(extName, name),
      get: <T>(name: string) => this.get<T>(name),
      has: (name: string) => this.has(name),
      waitFor: <T>(name: string, timeoutMs?: number) => this.waitFor<T>(name, timeoutMs),
      list: () => this.list(),
    };
  }
}

/** Process-wide singleton. */
export const serviceRegistry = new ServiceRegistryImpl();
