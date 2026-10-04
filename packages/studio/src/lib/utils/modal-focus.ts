/**
 * Make an element behave like the modal it declares itself to be.
 *
 * `aria-modal="true"` tells a screen reader the page behind is gone, so the
 * keyboard has to agree: focus moves in when it opens, Tab cannot walk out into
 * the page it covers, Escape closes it wherever focus is, and closing hands focus
 * back to whatever opened it. `Modal` and `ConfirmModal` each carry their own
 * copy of this; the two drawers carried none, and bound Escape to a backdrop that
 * never takes focus.
 *
 * `open` follows the element's own lifecycle: a dialog mounted only while open
 * passes `true` and gives focus back on destroy; one that stays mounted and goes
 * `inert` when closed passes its state.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalFocusOptions {
  open: boolean;
  onEscape: () => void;
}

export function modalFocus(node: HTMLElement, options: ModalFocusOptions) {
  let opts = options;
  let restoreTo: HTMLElement | null = null;
  let active = false;

  const focusables = () =>
    [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      opts.onEscape();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables();
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const current = document.activeElement as HTMLElement | null;
    // Focus can be outside without the user tabbing there (a click behind the
    // backdrop, a programmatic focus); Tab from there must come back in too.
    const outside = !node.contains(current);
    if (e.shiftKey && (current === first || outside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (current === last || outside)) {
      e.preventDefault();
      first.focus();
    }
  }

  function activate() {
    active = true;
    restoreTo = document.activeElement as HTMLElement | null;
    window.addEventListener('keydown', onKeydown);
    // A tick, so content rendered in the same update is there to receive it.
    queueMicrotask(() => {
      if (active) (focusables()[0] ?? node).focus();
    });
  }

  function deactivate() {
    active = false;
    window.removeEventListener('keydown', onKeydown);
    restoreTo?.focus?.();
    restoreTo = null;
  }

  if (opts.open) activate();

  return {
    update(next: ModalFocusOptions) {
      opts = next;
      if (next.open && !active) activate();
      else if (!next.open && active) deactivate();
    },
    destroy() {
      if (active) deactivate();
    },
  };
}
