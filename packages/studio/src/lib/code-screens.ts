/**
 * Screens that need code (ADR 0042 decision 9): front-end packages Studio
 * ships, each drawn instead of one extension view, named by the view's `id`.
 *
 * The extension knows nothing of them: it ships its view, which every other
 * front end draws, and Studio draws the view too when no screen is listed for
 * it. A screen gets the view's parameters (`$param`) and nothing else; it
 * reaches data only through the SDK calls every view uses, as the user.
 */
import type { Component } from 'svelte';
import PageBuilderWorkspace from '#lib/page-builder/components/PageBuilderWorkspace.svelte';

export type CodeScreen = Component<{ params: Record<string, string> }>;

/** Keyed by extension and view id: a screen answers only its own extension's view. */
const SCREENS = new Map<string, CodeScreen>([
  // content/pages: the block canvas over `pages.blocks`; its fallback is a form.
  ['content/pages pages.builder', PageBuilderWorkspace],
]);

/** The screen Studio draws instead of `viewId` of `extension`, if any. */
export function codeScreen(extension: string, viewId: string | undefined): CodeScreen | undefined {
  return viewId ? SCREENS.get(`${extension} ${viewId}`) : undefined;
}
