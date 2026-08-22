/**
 * postMessage protocol for MarketplaceSandbox (v1).
 *
 * Keep in sync with `MarketplaceSandbox.svelte` and EXTENSION-AUTHORING.md.
 */

export const MARKETPLACE_SANDBOX_PROTOCOL = 1 as const;

export type MarketplaceHostToFrame = {
  type: 'zveltio:marketplace:init';
  extensionId: string;
  locale: string;
};

export type MarketplaceFrameToHost =
  | { type: 'zveltio:marketplace:ready' }
  | { type: 'zveltio:marketplace:navigate'; path: string }
  | { type: 'zveltio:marketplace:toast'; level: string; message: string };

export const MARKETPLACE_FRAME_MESSAGE_TYPES = [
  'zveltio:marketplace:ready',
  'zveltio:marketplace:navigate',
  'zveltio:marketplace:toast',
] as const;
