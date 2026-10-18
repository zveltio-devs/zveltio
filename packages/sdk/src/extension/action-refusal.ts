/**
 * How an action says no to its caller: a business rule refused the request
 * ("this invoice is already cancelled"), as opposed to the action failing.
 *
 * Any other throw answers 500. A thrown `ActionRefusal` answers its own 4xx
 * status and `code`, and still rolls back what the action wrote before it.
 *
 * The engine recognises it by a registered symbol, not by `instanceof`: each
 * extension bundles its own copy of this SDK, so its class is never the
 * engine's.
 */
export const ACTION_REFUSAL: unique symbol = Symbol.for('zveltio.extension.action-refusal');

/** The statuses an action may refuse with. 401 and 407 are the host's: they mean "sign in". */
export type RefusalStatus = 400 | 403 | 404 | 409 | 410 | 412 | 422 | 423 | 429;

export class ActionRefusal extends Error {
  readonly [ACTION_REFUSAL] = true;

  /**
   * @param status one of `RefusalStatus`; the engine answers 500 for any other.
   * @param code a stable, machine-readable reason, `snake_case`.
   * @param message shown to the caller as the problem's `detail` — never put
   *   internal error text in it.
   */
  constructor(
    readonly status: RefusalStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ActionRefusal';
  }
}
