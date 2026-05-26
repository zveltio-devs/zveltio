/**
 * Studio SDK surface (S3-02 + S3-03 + early S4-07 prep).
 *
 * Pure helpers for Studio extension authors:
 *   - `makeFormProxy` / `applyFormAlterHooks` — form-alter pipeline that
 *     `<Form>` renderers in core Studio call before render. Hooks add
 *     fields, hide fields, reorder, attach validators.
 *   - `sortSlotContributions` — stable priority-asc sort used by
 *     `<Slot name>` to order extension contributions.
 *
 * The reactive registries themselves (Svelte 5 `$state`) live in
 * `packages/studio/src/lib/extension-api.svelte.ts`. They import this
 * module so the algorithm is one source of truth, while the studio side
 * owns the runtime state.
 *
 * Exported via `@zveltio/sdk/studio`. Extension Svelte bundles can
 * import-and-call too — useful for advanced authors who want to apply
 * alters against their own custom forms.
 */

import type {
  FormAlterAPI,
  FormAlterHook,
  FormSchema,
  FormField,
  SlotContribution,
  StudioRoute,
  StudioFieldType,
  AssetPreviewHandler,
} from '../extension/index.js';

interface FormProxy extends FormAlterAPI {
  /** Commit the mutated schema after all hooks ran. */
  commit(): FormSchema;
}

export function makeFormProxy(initial: FormSchema): FormProxy {
  // Deep-copy fields so hooks can mutate without leaking to the original.
  const fields: FormField[] = initial.fields.map((f) => ({
    ...f,
    validators: [...(f.validators ?? [])],
  }));
  const hiddenSet = new Set<string>();

  return {
    get fields() {
      return fields;
    },
    addField({ after, before, field }) {
      if (!field?.name) {
        console.warn('[form-alter] addField: field.name is required');
        return;
      }
      if (fields.some((f) => f.name === field.name)) {
        console.warn(
          `[form-alter] addField: field "${field.name}" already exists — use mutate-by-name instead`,
        );
        return;
      }
      const target = after ?? before;
      const cloned = { ...field, validators: [...(field.validators ?? [])] };
      if (target) {
        const idx = fields.findIndex((f) => f.name === target);
        if (idx < 0) {
          // Anchor not found → push to end. Warn so the author knows.
          console.warn(
            `[form-alter] addField: anchor "${target}" not found; appending "${field.name}" at end`,
          );
          fields.push(cloned);
        } else {
          const at = after ? idx + 1 : idx;
          fields.splice(at, 0, cloned);
        }
      } else {
        fields.push(cloned);
      }
    },
    hideField(name: string) {
      hiddenSet.add(name);
    },
    reorder(order: string[]) {
      // Reorder only what's in `order`. Fields not mentioned keep their
      // original relative order, appended after the reordered block.
      const byName = new Map(fields.map((f) => [f.name, f]));
      const reorderedKnown = order.map((n) => byName.get(n)).filter(Boolean) as FormField[];
      const remaining = fields.filter((f) => !order.includes(f.name));
      fields.length = 0;
      fields.push(...reorderedKnown, ...remaining);
    },
    addValidator(fieldName, validator) {
      const f = fields.find((x) => x.name === fieldName);
      if (!f) {
        console.warn(`[form-alter] addValidator: field "${fieldName}" not found`);
        return;
      }
      f.validators = [...(f.validators ?? []), validator];
    },
    commit(): FormSchema {
      // Materialize hidden state. `hidden: true` keeps the field in the
      // schema so server-side defaults still apply; renderers skip rendering.
      const out = fields.map((f) => (hiddenSet.has(f.name) ? { ...f, hidden: true } : f));
      return { ...initial, fields: out };
    },
  };
}

/**
 * Run every registered hook against the schema and return the result.
 * Exception-safe: a throwing hook is logged and skipped, the rest still run.
 */
export function applyFormAlterHooks(
  hooks: FormAlterHook[],
  schema: FormSchema,
  ctx: Record<string, unknown> = {},
): FormSchema {
  if (hooks.length === 0) return schema;
  const proxy = makeFormProxy(schema);
  for (const hook of hooks) {
    try {
      hook(proxy, ctx);
    } catch (err) {
      console.error('[form-alter] hook threw:', err);
    }
  }
  return proxy.commit();
}

/**
 * Sort slot contributions deterministically: priority asc (lower first),
 * then registration order (stable sort).
 */
export function sortSlotContributions<T extends { priority?: number }>(items: T[]): T[] {
  // We rely on Array.prototype.sort being stable (TC39 since 2019).
  return items.slice().sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
}

// ── Typed re-exports of the runtime register* APIs ──────────────────────────
//
// These are the "ergonomic" surface for extension Studio bundles:
//
//   import { registerSlot } from '@zveltio/sdk/studio';
//   registerSlot('dashboard.widgets', { component: MyWidget });
//
// They thinly proxy `window.__zveltio.registerXxx`, set up by the Studio
// before extension bundles execute. If a bundle is loaded outside Studio
// (e.g. in a test harness without the global installed), these warn and
// no-op rather than throw — same defensive posture as the existing
// `register()` functions in the bundle scaffolds.

interface StudioGlobal {
  registerRoute(route: StudioRoute): void;
  registerSlot(name: string, contribution: SlotContribution): void;
  registerFormAlter(formId: string, hook: FormAlterHook): void;
  registerFieldType(ft: StudioFieldType): void;
  registerAssetPreview(handler: AssetPreviewHandler): void;
  engineUrl?: string;
}

function getStudioGlobal(): StudioGlobal | null {
  if (typeof window === 'undefined') return null;
  const g = (window as any).__zveltio as StudioGlobal | undefined;
  if (!g) {
    console.warn(
      '[zveltio/sdk/studio] window.__zveltio is not installed. Is the bundle running inside Studio?',
    );
    return null;
  }
  return g;
}

/** Register a top-level Studio page contributed by this extension. */
export function registerRoute(route: StudioRoute): void {
  getStudioGlobal()?.registerRoute(route);
}

/**
 * Register a Svelte component into a named composition slot (S3-03).
 *
 * @example
 *   import { registerSlot } from '@zveltio/sdk/studio';
 *   import RevenueWidget from './widgets/RevenueWidget.svelte';
 *
 *   registerSlot('dashboard.widgets', {
 *     component: RevenueWidget,
 *     priority: 10,
 *     visible: (ctx) => (ctx.user as any)?.roles?.includes('finance'),
 *   });
 */
export function registerSlot(name: string, contribution: SlotContribution): void {
  getStudioGlobal()?.registerSlot(name, contribution);
}

/**
 * Register a Drupal-style form-alter hook (S3-02).
 *
 * @example
 *   import { registerFormAlter } from '@zveltio/sdk/studio';
 *
 *   registerFormAlter('core:user-edit', (form) => {
 *     form.addField({ after: 'email', field: { name: 'phone', type: 'tel' } });
 *     form.hideField('legacy_pin');
 *   });
 */
export function registerFormAlter(formId: string, hook: FormAlterHook): void {
  getStudioGlobal()?.registerFormAlter(formId, hook);
}

/** Register a custom Studio field type contributed by this extension. */
export function registerFieldType(ft: StudioFieldType): void {
  getStudioGlobal()?.registerFieldType(ft);
}

/**
 * Register a custom preview handler for asset URLs / MIME types.
 *
 * @example
 *   import { registerAssetPreview } from '@zveltio/sdk/studio';
 *   import PdfPreview from './PdfPreview.svelte';
 *
 *   registerAssetPreview({
 *     match: (a) => a.mimeType === 'application/pdf',
 *     component: PdfPreview,
 *   });
 */
export function registerAssetPreview(handler: AssetPreviewHandler): void {
  getStudioGlobal()?.registerAssetPreview(handler);
}

/** Engine base URL — pre-installed by Studio for cross-origin fetches. */
export function getEngineUrl(): string {
  if (typeof window === 'undefined') return '';
  return ((window as any).__ZVELTIO_ENGINE_URL__ as string) || getStudioGlobal()?.engineUrl || '';
}

// Re-export types so an extension author can do a single
// `import { ... } from '@zveltio/sdk/studio'`.
export type {
  StudioExtensionAPI,
  StudioRoute,
  StudioFieldType,
  AssetPreviewHandler,
  SlotContribution,
  FormAlterHook,
  FormAlterAPI,
  FormSchema,
  FormField,
} from '../extension/index.js';
