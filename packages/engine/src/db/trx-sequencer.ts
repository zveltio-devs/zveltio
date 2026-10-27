/**
 * One transaction's statements, kept in an order that leaves multi-statement
 * scopes whole.
 *
 * A savepoint block (`withSavepoint`) and a role window (`asEngineRole`, an
 * extension's statement) are several statements on the transaction's one
 * connection. Kysely runs one statement at a time there, not one scope: a
 * `Promise.all` sibling's statement landed between them. Measured on a request
 * transaction: two savepoint blocks that both succeeded aborted it (`RELEASE a`
 * releases `b` too, and `b`'s own RELEASE then fails), a failing block undid a
 * sibling's write, and a plain read sent during the engine's window ran as its
 * login — a superuser, past every row policy.
 *
 * So each transaction's connection is handed out by a sequencer: `exclusive`
 * runs a scope alone on it, and every other statement or scope waits for it.
 * Work inside a scope queues at that scope's level — nested scopes and their
 * statements run in it, siblings among them still take turns — so a scope never
 * waits for itself. Ceiling: a scope that awaits a statement issued OUTSIDE it,
 * on the same transaction and after it began, waits forever.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  CompiledQuery,
  ConnectionProvider,
  DatabaseConnection,
  QueryExecutor,
  QueryResult,
} from 'kysely';

interface Level {
  tail: Promise<unknown>;
  parent: Level | null;
  closed: boolean;
}

/** The scope this async context runs in, per turn-taker. */
const inside = new AsyncLocalStorage<ReadonlyMap<Turns, Level>>();

/**
 * Set while `exclusive` asks who provides a transaction's connection. Kysely
 * (0.29.7+) wraps the consumer on its way down, so the probe is known by its
 * async context, not by its identity: the sequencer hands itself to the
 * consumer as the connection, and every wrapper passes that back up. Any other
 * provider lends its real connection, which is not a `Sequencer`.
 */
const probing = new AsyncLocalStorage<true>();
const IDENTIFY = async (c: DatabaseConnection): Promise<DatabaseConnection> => c;

/**
 * The turns of one transaction: `run` queues one statement, `exclusive` one
 * scope. Also what a worker-isolated extension's runtime orders its request's
 * statements with, where the transaction lives across the bridge.
 */
export class Turns {
  readonly #root: Level = { tail: Promise.resolve(), parent: null, closed: false };

  /** Where this context queues: its innermost scope still open, else the root. */
  #level(): Level {
    let level = inside.getStore()?.get(this) ?? this.#root;
    // A statement left running past its scope's end queues where the scope did.
    while (level.closed && level.parent) level = level.parent;
    return level;
  }

  #queue<T>(level: Level, run: () => Promise<T>): Promise<T> {
    const mine = level.tail.then(run);
    level.tail = mine.catch(() => undefined);
    return mine;
  }

  run<T>(run: () => Promise<T>): Promise<T> {
    return this.#queue(this.#level(), run);
  }

  exclusive<T>(run: () => Promise<T>): Promise<T> {
    const parent = this.#level();
    const level: Level = { tail: Promise.resolve(), parent, closed: false };
    const scope = new Map(inside.getStore()).set(this, level);
    return this.#queue(parent, () =>
      inside.run(scope, run).finally(() => {
        level.closed = true;
      }),
    );
  }
}

class Sequencer extends Turns implements ConnectionProvider {
  constructor(readonly inner: ConnectionProvider) {
    super();
  }

  provideConnection<T>(
    consumer: (connection: DatabaseConnection) => Promise<T>,
    options?: Parameters<ConnectionProvider['provideConnection']>[1],
  ): Promise<T> {
    if (probing.getStore()) return consumer(this as unknown as DatabaseConnection);
    return this.run(() => this.inner.provideConnection(consumer, options));
  }
}

/**
 * Hand every transaction (and pinned connection) `db` opens out through a
 * sequencer. An own property on `db`'s executor, which is what `transaction()`,
 * `startTransaction()` and `connection()` wrap their one connection with; a
 * handle derived first (`db.withPlugin(…).transaction()`) is not covered.
 */
export function sequenceTransactions<D extends { getExecutor(): QueryExecutor }>(db: D): D {
  const executor = db.getExecutor();
  const wrap = executor.withConnectionProvider.bind(executor);
  Object.defineProperty(executor, 'withConnectionProvider', {
    value: (provider: ConnectionProvider) => wrap(new Sequencer(provider)),
  });
  return db;
}

/**
 * Run `run` alone on the transaction `db` is on: after everything already
 * queued there, before anything sent after it. Outside a transaction, or on one
 * no sequencer hands out, it just runs.
 */
export async function exclusive<T>(
  db: {
    readonly isTransaction: boolean;
    getExecutor(): Pick<ConnectionProvider, 'provideConnection'>;
  },
  run: () => Promise<T>,
): Promise<T> {
  if (!db.isTransaction) return run();
  const provider: unknown = await probing.run(true, () =>
    db.getExecutor().provideConnection(IDENTIFY),
  );
  return provider instanceof Sequencer ? provider.exclusive(run) : run();
}

/**
 * The turns of the transaction `db` is on, and a way to send a statement on its
 * connection WITHOUT taking a turn — for a caller that takes the turn itself
 * (`turns.run`/`exclusive`) and sends several statements in it: a worker
 * extension joining a request's transaction. Undefined outside a transaction,
 * or on one no sequencer hands out; throws once it committed or rolled back.
 */
export async function transactionTurns(db: {
  readonly isTransaction: boolean;
  getExecutor(): Pick<ConnectionProvider, 'provideConnection'>;
}): Promise<{ turns: Turns; send(q: CompiledQuery): Promise<QueryResult<unknown>> } | undefined> {
  if (!db.isTransaction) return undefined;
  const provider: unknown = await probing.run(true, () =>
    db.getExecutor().provideConnection(IDENTIFY),
  );
  if (!(provider instanceof Sequencer)) return undefined;
  return {
    turns: provider,
    send: (q) => provider.inner.provideConnection((c) => c.executeQuery(q)),
  };
}
