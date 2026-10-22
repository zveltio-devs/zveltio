/**
 * `ctx.broadcast` — an extension's own messages across engine replicas.
 *
 * An extension that caches what its routes write (`ai` keeps each firm's
 * providers) dropped the cache only on the replica that served the write; every
 * other replica kept serving the old value until it restarted. This carries the
 * drop on the realtime bus the engine already uses for its own caches.
 *
 * The engine owns the envelope: the bus event is always
 * `EXTENSION_BROADCAST_EVENT`, `collection` is the publishing extension's name
 * and `tenantId` its current tenant, so an extension can name only its own
 * message — never an engine event, never another extension's. Delivery reaches
 * every replica, the publisher's included, through the same `deliver`, so a
 * handler is the one place a cache is dropped; and it waits for the publisher's
 * commit, so no replica re-reads the rows before they are there.
 */
import type { ExtensionBroadcast } from '@zveltio/sdk/extension';
import {
  EXTENSION_BROADCAST_EVENT,
  ORIGIN_ID,
  PG_NOTIFY_PAYLOAD_MAX,
  type RealtimeBusMessage,
  realtimeBus,
} from '../runtime/index.js';
import {
  getCurrentDomainOrNull,
  getCurrentTrxTenant,
  onAfterCommit,
  runOutsideTenantContext,
  withTenantIsolation,
} from '../tenancy/index.js';

type Handler = (data: unknown) => void | Promise<void>;
type MissedHandler = () => void | Promise<void>;

/** extension → message name → handlers. */
const handlers = new Map<string, Map<string, Set<Handler>>>();
const missedHandlers = new Map<string, Set<MissedHandler>>();

const NAME = /^[A-Za-z0-9._:-]{1,64}$/;

function checkName(extName: string, name: unknown): asserts name is string {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new Error(
      `extension "${extName}": broadcast name ${JSON.stringify(name)} must match [A-Za-z0-9._:-]{1,64}`,
    );
  }
}

/** Drop every handler an extension registered. On (re)load and unload, like its listeners. */
export function clearExtensionBroadcasts(extName: string): void {
  handlers.delete(extName);
  missedHandlers.delete(extName);
}

/** Each handler in its own tenant transaction (none without a tenant); a failure is logged, never shared. */
function deliver(
  extName: string,
  name: string,
  data: unknown,
  tenantId: string | null,
): Promise<void> {
  const list = [...(handlers.get(extName)?.get(name) ?? [])];
  return Promise.all(
    list.map((handler) =>
      runOutsideTenantContext(async () => {
        try {
          if (tenantId) await withTenantIsolation(tenantId, async () => handler(data));
          else await handler(data);
        } catch (err) {
          console.error(
            `[extension-broadcast] ${extName}: "${name}" handler failed:`,
            (err as Error).message,
          );
        }
      }),
    ),
  ).then(() => undefined);
}

/** The `ctx.broadcast` handed to `extName`. */
export function extensionBroadcast(extName: string): ExtensionBroadcast {
  return {
    async publish(name, data) {
      checkName(extName, name);
      // The tenant `ctx.db` runs as here: the transaction's, else the request's.
      const tenantId = getCurrentTrxTenant() ?? getCurrentDomainOrNull();
      const msg: Omit<RealtimeBusMessage, 'originId'> = {
        event: EXTENSION_BROADCAST_EVENT,
        collection: extName,
        data: { name, data },
        tenantId,
        timestamp: new Date().toISOString(),
      };
      const encoded = JSON.stringify({ ...msg, originId: ORIGIN_ID });
      const bytes = Buffer.byteLength(encoded, 'utf8');
      // Refused for every backend: pg_notify would drop `data` and deliver an empty message.
      if (bytes > PG_NOTIFY_PAYLOAD_MAX) {
        throw new Error(
          `extension "${extName}": broadcast "${name}" is ${bytes} bytes encoded, over the ` +
            `${PG_NOTIFY_PAYLOAD_MAX}-byte bus limit; send an id and let each replica read the rest`,
        );
      }
      // What a remote handler gets: `data` after a JSON round trip.
      const delivered = (JSON.parse(encoded) as { data: { data?: unknown } }).data.data;
      onAfterCommit(async () => {
        await realtimeBus()
          .publish(msg)
          .catch((err: Error) => {
            console.error(`[extension-broadcast] ${extName}: "${name}" not sent:`, err.message);
          });
        await deliver(extName, name, delivered, tenantId);
      });
    },
    on(name, handler) {
      checkName(extName, name);
      const byName = handlers.get(extName) ?? new Map<string, Set<Handler>>();
      handlers.set(extName, byName);
      const set = byName.get(name) ?? new Set<Handler>();
      byName.set(name, set);
      set.add(handler);
      return () => void handlers.get(extName)?.get(name)?.delete(handler);
    },
    onMissed(handler) {
      const set = missedHandlers.get(extName) ?? new Set<MissedHandler>();
      missedHandlers.set(extName, set);
      set.add(handler);
      return () => void missedHandlers.get(extName)?.delete(handler);
    },
  };
}

/** A broadcast from another replica (`dispatchToWs`). The bus already dropped this replica's own. */
export function receiveExtensionBroadcast(msg: RealtimeBusMessage): Promise<void> | undefined {
  const { name, data } = (msg.data ?? {}) as { name?: unknown; data?: unknown };
  if (!msg.collection || typeof name !== 'string') return;
  return deliver(msg.collection, name, data, msg.tenantId ?? null);
}

/** The bus came back: whatever was sent meanwhile is gone. */
export function extensionBroadcastsMissed(): Promise<void> {
  const all = [...missedHandlers].flatMap(([extName, set]) =>
    [...set].map((handler) =>
      runOutsideTenantContext(async () => {
        try {
          await handler();
        } catch (err) {
          console.error(
            `[extension-broadcast] ${extName}: missed-messages handler failed:`,
            (err as Error).message,
          );
        }
      }),
    ),
  );
  return Promise.all(all).then(() => undefined);
}
