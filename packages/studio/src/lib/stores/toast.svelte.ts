export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

let _toastId = 0;

export class ToastStore {
  items = $state<Toast[]>([]);

  add(type: ToastType, message: string, duration = 5000) {
    const id = ++_toastId;
    this.items.push({ id, type, message });

    if (duration > 0) {
      setTimeout(() => this.remove(id), duration);
    }

    return id;
  }

  remove(id: number) {
    this.items = this.items.filter((t) => t.id !== id);
  }

  success(message: string) { return this.add('success', message); }
  error(message: string) { return this.add('error', message, 8000); }
  warning(message: string) { return this.add('warning', message); }
  info(message: string) { return this.add('info', message); }
}

export const toast = new ToastStore();
