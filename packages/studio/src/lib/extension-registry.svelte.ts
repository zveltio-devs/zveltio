import type { Component } from 'svelte';

export interface ExtensionRoute {
  path: string;
  component: Component;
  label: string;
  icon: string;
  category: string;
  children?: ExtensionRoute[];
}

export interface StudioFieldType {
  type: string;
  editor: () => Promise<{ default: Component }>;
  display: () => Promise<{ default: Component }>;
  filter?: () => Promise<{ default: Component }>;
}

export interface AssetPreviewHandler {
  match: (asset: { url: string; name?: string; mimeType?: string }) => boolean;
  component: Component;
}

let routes = $state<ExtensionRoute[]>([]);
let fieldTypes = $state<Map<string, StudioFieldType>>(new Map());
let assetPreviewers = $state<AssetPreviewHandler[]>([]);

export const extensionRegistry = {
  registerRoute(route: ExtensionRoute) {
    routes = [...routes, route];
  },

  registerFieldType(ft: StudioFieldType) {
    const map = new Map(fieldTypes);
    map.set(ft.type, ft);
    fieldTypes = map;
  },

  registerAssetPreview(handler: AssetPreviewHandler) {
    assetPreviewers = [...assetPreviewers, handler];
  },

  get routes() { return routes; },

  getFieldType(type: string) { return fieldTypes.get(type); },

  getAssetPreviewer(asset: { url: string; name?: string; mimeType?: string }): AssetPreviewHandler | null {
    return assetPreviewers.find((h) => h.match(asset)) ?? null;
  },

  resolveComponent(extPath: string, subPath: string): Component | null {
    const route = routes.find((r) => r.path === extPath);
    if (!route) return null;
    if (!subPath || subPath === '/') return route.component;
    const child = route.children?.find((c) => c.path === `${extPath}${subPath}`);
    return child?.component || route.component;
  },
};

// Global API for extensions to self-register
if (typeof window !== 'undefined') {
  (window as any).__zveltio = {
    registerRoute: extensionRegistry.registerRoute.bind(extensionRegistry),
    registerFieldType: extensionRegistry.registerFieldType.bind(extensionRegistry),
    registerAssetPreview: extensionRegistry.registerAssetPreview.bind(extensionRegistry),
    get engineUrl() { return (window as any).__ZVELTIO_ENGINE_URL__; },
  };
}
