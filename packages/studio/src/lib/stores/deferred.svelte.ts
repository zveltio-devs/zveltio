/**
 * Do it in a moment, unless they take it back.
 *
 * A confirm dialog interrupts every delete to prevent the rare mistake. It is
 * paid on the common path — the one where the person meant it — and it buys
 * very little, because a dialog answered a hundred times is answered without
 * reading.
 *
 * The alternative is an undo window. It only works if the undo is REAL, and
 * here it has to be: `DELETE` on this engine is a hard delete, with no
 * `deleted_at` on any route, so there is nothing to restore afterwards. So the
 * request is not sent at all until the window closes. Nothing was deleted;
 * taking it back is simply not doing it.
 *
 * Two ways the window can end early, and both must run the work rather than
 * drop it: navigating away, and closing the tab. A pending delete that
 * evaporates because someone clicked a link is a worse outcome than the dialog
 * this replaces — the row is still there and the person believes it is gone.
 *
 * NOT for irreversible destruction of a whole structure. Dropping a collection
 * takes its data with it, and five seconds of grace is not the right protection
 * for that: those keep their confirm dialog on purpose.
 */
import { toast } from './toast.svelte.js';

type Pending = {
  run: () => Promise<unknown> | unknown;
  timer: ReturnType<typeof setTimeout>;
  toastId: number;
};

const pending = new Set<Pending>();

/** Runs everything still waiting. Called on navigation and on unload. */
export function flushDeferred(): void {
  for (const p of [...pending]) {
    clearTimeout(p.timer);
    pending.delete(p);
    void p.run();
  }
}

if (typeof window !== 'undefined') {
  // `pagehide` rather than `beforeunload`: it fires on the mobile
  // back-forward-cache path too, where `beforeunload` does not.
  window.addEventListener('pagehide', flushDeferred);
}

export interface DeferOptions {
  /** What the toast says while the window is open — "Contact deleted". */
  message: string;
  /** The undo label. */
  undoLabel: string;
  /** How long they have. Five seconds is long enough to notice, short enough
   *  not to feel like the app is lying about what it did. */
  windowMs?: number;
  /** Called if they take it back, so the row can come back on screen. */
  onUndo?: () => void;
}

/**
 * Show the outcome now, do the work in a moment.
 *
 * The caller is expected to remove the row from the list immediately — that is
 * the whole point — and to put it back in `onUndo`.
 */
export function deferWithUndo(run: () => Promise<unknown> | unknown, opts: DeferOptions): void {
  const windowMs = opts.windowMs ?? 5000;
  let entry: Pending;

  const toastId = toast.add('success', opts.message, {
    duration: windowMs,
    action: {
      label: opts.undoLabel,
      handler: () => {
        clearTimeout(entry.timer);
        pending.delete(entry);
        opts.onUndo?.();
      },
    },
  });

  entry = {
    run,
    toastId,
    timer: setTimeout(() => {
      pending.delete(entry);
      void run();
    }, windowMs),
  };
  pending.add(entry);
}

/** How many are still waiting — for tests, and for a navigation guard. */
export function pendingCount(): number {
  return pending.size;
}
