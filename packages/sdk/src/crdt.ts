/**
 * Lightweight CRDT primitives for offline-first sync.
 * No external dependencies — pure TypeScript.
 */

// LWW-Register (Last Write Wins) with Lamport timestamp per field
export interface LWWField<T = any> {
  value: T;
  lamport: number;   // Lamport clock value at time of write
  clientId: string;  // tie-breaker: higher string wins on same lamport
}

export type LWWDocument = Record<string, LWWField>;

/**
 * Merge two LWW documents — field-level last-write-wins.
 * The field with the higher lamport wins; on ties, higher clientId wins.
 */
export function mergeLWW(local: LWWDocument, remote: LWWDocument): LWWDocument {
  const result: LWWDocument = { ...local };
  for (const key of Object.keys(remote)) {
    const remoteField = remote[key];
    const localField = local[key];
    if (!localField) {
      result[key] = remoteField;
    } else if (remoteField.lamport > localField.lamport) {
      result[key] = remoteField;
    } else if (
      remoteField.lamport === localField.lamport &&
      remoteField.clientId > localField.clientId
    ) {
      result[key] = remoteField;
    }
    // else: local wins — no change
  }
  return result;
}

/** Convert a plain record to an LWW document */
export function toDocument(
  data: Record<string, any>,
  lamport: number,
  clientId: string,
): LWWDocument {
  const doc: LWWDocument = {};
  for (const [key, value] of Object.entries(data)) {
    doc[key] = { value, lamport, clientId };
  }
  return doc;
}

/** Extract plain data from an LWW document */
export function fromDocument(doc: LWWDocument): Record<string, any> {
  const data: Record<string, any> = {};
  for (const [key, field] of Object.entries(doc)) {
    data[key] = field.value;
  }
  return data;
}

// ── OR-Set (Observed-Remove Set) for array fields ─────────────────────────────

export interface ORSetElement<T = any> {
  value: T;
  uid: string;       // unique tag for this add operation
  removed: boolean;
}

export type ORSet<T = any> = ORSetElement<T>[];

export function orSetAdd<T>(set: ORSet<T>, value: T): ORSet<T> {
  return [...set, { value, uid: crypto.randomUUID(), removed: false }];
}

export function orSetRemove<T>(set: ORSet<T>, uid: string): ORSet<T> {
  return set.map((el) => (el.uid === uid ? { ...el, removed: true } : el));
}

export function orSetMerge<T>(local: ORSet<T>, remote: ORSet<T>): ORSet<T> {
  const merged = new Map<string, ORSetElement<T>>();
  for (const el of [...local, ...remote]) {
    const existing = merged.get(el.uid);
    // Once removed in either replica, it's removed everywhere
    if (!existing || el.removed) {
      merged.set(el.uid, el);
    }
  }
  return Array.from(merged.values()).filter((el) => !el.removed);
}

export function orSetValues<T>(set: ORSet<T>): T[] {
  return set.filter((el) => !el.removed).map((el) => el.value);
}

// ── Lamport Clock ─────────────────────────────────────────────────────────────

export class LamportClock {
  private value: number;
  private readonly clientId: string;

  constructor(clientId: string, initial = 0) {
    this.value = initial;
    this.clientId = clientId;
  }

  /** Increment and return the new value */
  tick(): number {
    return ++this.value;
  }

  /** Update from a received timestamp, then increment */
  update(received: number): number {
    this.value = Math.max(this.value, received) + 1;
    return this.value;
  }

  get current(): number {
    return this.value;
  }

  get id(): string {
    return this.clientId;
  }
}
