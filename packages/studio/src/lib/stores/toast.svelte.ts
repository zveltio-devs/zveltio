export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastAction {
  /** Visible label on the action button. Keep short ("Undo", "Retry", "View"). */
  label: string;
  /** Called when the user clicks the action. Toast auto-dismisses after. */
  handler: () => void | Promise<void>;
}

export interface Toast {
  id: number;
  type: ToastType;
  message: string;
  /** Optional action (e.g. "Undo") rendered next to the message. */
  action?: ToastAction;
  /** Auto-dismiss after N ms. 0 = sticky until dismissed manually. */
  duration?: number;
}

let _toastId = 0;

export class ToastStore {
  items = $state<Toast[]>([]);

  /**
   * Push a toast. Returns the id so callers can dismiss it manually
   * (e.g. on retry success they want the "Retrying…" toast to go away).
   */
  add(type: ToastType, message: string, opts: { duration?: number; action?: ToastAction } = {}) {
    const id = ++_toastId;
    const duration = opts.duration ?? (type === 'error' ? 8000 : 5000);
    this.items.push({ id, type, message, action: opts.action, duration });

    if (duration > 0) {
      setTimeout(() => this.remove(id), duration);
    }

    return id;
  }

  remove(id: number) {
    this.items = this.items.filter((t) => t.id !== id);
  }

  success(message: string, opts: { action?: ToastAction } = {}) {
    return this.add('success', message, opts);
  }
  error(message: string, opts: { action?: ToastAction } = {}) {
    return this.add('error', message, opts);
  }
  warning(message: string, opts: { action?: ToastAction } = {}) {
    return this.add('warning', message, opts);
  }
  info(message: string, opts: { action?: ToastAction } = {}) {
    return this.add('info', message, opts);
  }

  /**
   * Helper for "destructive action with undo" pattern.
   *
   *   const id = toast.undoable('Deleted webhook', { onUndo: () => restore() });
   *
   * Shows a success-style toast with an "Undo" button. If the user
   * clicks it, the handler runs and the toast dismisses. If they don't,
   * the toast auto-dismisses after 6 s and the deletion is permanent.
   */
  undoable(
    message: string,
    opts: { onUndo: () => void | Promise<void>; duration?: number; type?: ToastType },
  ): number {
    return this.add(opts.type ?? 'success', message, {
      duration: opts.duration ?? 6000,
      action: {
        label: 'Undo',
        handler: opts.onUndo,
      },
    });
  }
}

export const toast = new ToastStore();
