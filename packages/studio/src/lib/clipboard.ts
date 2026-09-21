import { m } from '$lib/i18n.svelte.js';
import { toast } from '$lib/stores/toast.svelte.js';

/**
 * Copy text to the clipboard, reporting failure instead of pretending success.
 *
 * `navigator.clipboard.writeText` rejects without a secure context or the
 * clipboard permission, and the object itself is absent in some embeddings.
 * Every call site had to remember that; most did not, so a rejected write
 * showed the "copied" tick anyway — and on this screen the copied text is an
 * API key that is shown exactly once.
 *
 * The same repair had already been made twice, in `SettingsPage.copy` (C03) and
 * `SnippetGenerator` (C06), while five other call sites kept the defect. It
 * lives here now so there is one of it.
 *
 * @returns whether the text actually reached the clipboard — gate any
 * "copied" feedback on it.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast.error(m['ext.copyFailed']());
    return false;
  }
}
