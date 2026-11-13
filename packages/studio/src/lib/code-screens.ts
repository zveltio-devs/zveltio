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

export const CODE_SCREENS: Readonly<Record<string, CodeScreen>> = {
  // content/pages: the block canvas over `pages.blocks`; its fallback is a form.
  'pages.builder': PageBuilderWorkspace,
};
