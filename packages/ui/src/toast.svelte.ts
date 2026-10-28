/**
 * Toasts (`@zveltio/ui`): `toast.show(text, kind)` from anywhere, one `<Toaster>`
 * per app draws them in a live region so a screen reader reads each one.
 */

export type ToastKind = 'info' | 'success' | 'warning' | 'error';
export interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

let next = 0;

function createToasts() {
  let items = $state<ToastItem[]>([]);
  const dismiss = (id: number) => {
    items = items.filter((t) => t.id !== id);
  };
  return {
    get items() {
      return items;
    },
    /** Errors stay until dismissed; the rest leave after `ms`. */
    show(text: string, kind: ToastKind = 'info', ms = 4000) {
      const id = ++next;
      items = [...items, { id, text, kind }];
      if (kind !== 'error') setTimeout(() => dismiss(id), ms);
      return id;
    },
    dismiss,
  };
}

export const toast = createToasts();
