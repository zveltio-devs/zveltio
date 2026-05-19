/**
 * Nav model — the source of truth for the admin sidebar's grouped items.
 *
 * Kept out of `+layout.svelte` so:
 *   - The structure has a single edit point.
 *   - Cmd+K palette + future "navigate to" extension hooks can reuse it.
 *   - Restructuring groups is a one-file change.
 *
 * Items with an `ext` key are visible only when that extension is active.
 * Items without `ext` are always visible.
 */
import { base } from '$app/paths';
import {
  LayoutDashboard, Database, Users, Shield, Webhook, Settings,
  Puzzle, HardDrive, Key, ClipboardList, Languages,
  Upload, Bell, Download, Workflow, Package, GitBranch, Plug,
  Building2, Images, DatabaseBackup, Layout, CheckSquare,
  ScanSearch, Code, Bookmark, BarChart2, Terminal, Activity,
  LayoutGrid, Zap, Sparkles,
} from '@lucide/svelte';
import type { Component } from 'svelte';

export type NavItem = { href: string; icon: Component; label: string; ext?: string };
export type NavGroup = { label?: string; items: NavItem[] };

/** Active extensions, shape passed by `$lib/extensions.svelte.js`. */
interface ExtensionState {
  initialized: boolean;
  meta: Array<{
    name: string;
    displayName?: string;
    studio?: { pages?: Array<{ path?: string; label?: string }> };
    contributes?: { studio?: boolean };
  }>;
  isActive(name: string): boolean;
}

/**
 * Static nav skeleton. Filtered at call-time by extension activation.
 *
 * Taxonomy redesigned in the UX refactor (wave 40) from 8 → 6 groups,
 * organized around user *intent* rather than feature category:
 *
 *   Build      — define the data + how it's presented
 *   Security   — control who can see / do what
 *   Workflows  — wire events into actions
 *   Insights   — see what's happening
 *   Developer  — low-level escape hatches
 *   System     — admin chores (storage, backup, settings)
 *
 * Restructure groups here, not in the layout component.
 */
const RAW_NAV: NavGroup[] = [
  {
    items: [
      { href: `${base}/`,           icon: LayoutDashboard, label: 'Dashboard'   },
      { href: `${base}/onboarding`, icon: Zap,             label: 'Quick Setup' },
    ],
  },
  {
    label: 'Build',
    items: [
      { href: `${base}/collections`, icon: Database,   label: 'Collections' },
      { href: `${base}/templates`,   icon: Sparkles,   label: 'Templates'   },
      { href: `${base}/views`,       icon: Layout,     label: 'Views'       },
      { href: `${base}/zones`,       icon: LayoutGrid, label: 'Zones'       },
      { href: `${base}/media`,       icon: Images,     label: 'Media',      ext: 'content/media' },
    ],
  },
  {
    label: 'Security',
    items: [
      { href: `${base}/users`,              icon: Users,     label: 'Users'           },
      { href: `${base}/permissions`,        icon: Shield,    label: 'Permissions'     },
      { href: `${base}/rls`,                icon: Shield,    label: 'Row Security'    },
      { href: `${base}/column-permissions`, icon: Shield,    label: 'Column Security' },
      { href: `${base}/api-keys`,           icon: Key,       label: 'API Keys'        },
      { href: `${base}/tenants`,            icon: Building2, label: 'Tenants'         },
    ],
  },
  {
    label: 'Workflows',
    items: [
      { href: `${base}/flows`,         icon: Workflow,    label: 'Flows'         },
      { href: `${base}/webhooks`,      icon: Webhook,     label: 'Webhooks'      },
      { href: `${base}/notifications`, icon: Bell,        label: 'Notifications' },
      { href: `${base}/approvals`,     icon: CheckSquare, label: 'Approvals'     },
    ],
  },
  {
    label: 'Insights',
    items: [
      { href: `${base}/insights`,     icon: BarChart2,     label: 'Analytics'     },
      { href: `${base}/audit`,        icon: ClipboardList, label: 'Audit Log'     },
      { href: `${base}/request-logs`, icon: Activity,      label: 'Request Logs'  },
    ],
  },
  {
    label: 'Developer',
    items: [
      { href: `${base}/edge-functions`,      icon: Code,       label: 'Edge Functions'      },
      { href: `${base}/rpc`,                 icon: Zap,        label: 'RPC Functions'       },
      { href: `${base}/schema-branches`,     icon: GitBranch,  label: 'Schema Branches'     },
      { href: `${base}/virtual-collections`, icon: Plug,       label: 'Virtual Collections' },
      { href: `${base}/saved-queries`,       icon: Bookmark,   label: 'Saved Queries'       },
      { href: `${base}/sql`,                 icon: Terminal,   label: 'SQL Editor'          },
      { href: `${base}/introspect`,          icon: ScanSearch, label: 'BYOD Import',        ext: 'developer/byod' },
    ],
  },
  {
    label: 'System',
    items: [
      { href: `${base}/storage`,      icon: HardDrive,      label: 'Storage'      },
      { href: `${base}/backup`,       icon: DatabaseBackup, label: 'Backup'       },
      { href: `${base}/import`,       icon: Upload,         label: 'Import',      ext: 'data/import' },
      { href: `${base}/export`,       icon: Download,       label: 'Export',      ext: 'data/export' },
      { href: `${base}/translations`, icon: Languages,      label: 'Translations', ext: 'i18n/translations' },
      { href: `${base}/marketplace`,  icon: Package,        label: 'Marketplace'  },
      { href: `${base}/settings`,     icon: Settings,       label: 'Settings'     },
    ],
  },
];

const RAW_NAV_EXT_NAMES: Set<string> = new Set(
  RAW_NAV.flatMap((g) => g.items).filter((i) => i.ext).map((i) => i.ext!),
);

/** Filtered nav for the current set of active extensions. */
export function buildNavModel(extensions: ExtensionState): NavGroup[] {
  return RAW_NAV
    .map((g) => ({
      ...g,
      items: g.items.filter((it) => !it.ext || extensions.isActive(it.ext)),
    }))
    .filter((g) => g.items.length > 0);
}

/**
 * Auto-injected nav items from active extensions whose Studio pages aren't
 * already wired into RAW_NAV. Renders under an "Extensions" heading.
 */
export function buildExtensionNav(extensions: ExtensionState): NavItem[] {
  if (!extensions.initialized) return [];
  return extensions.meta
    .filter((m) => extensions.isActive(m.name))
    .filter((m) => !RAW_NAV_EXT_NAMES.has(m.name))
    .filter((m) => (m.studio?.pages && m.studio.pages.length > 0) || m.contributes?.studio)
    .map((m) => {
      const firstPage = m.studio?.pages?.[0];
      const slug = firstPage?.path
        ? firstPage.path.replace(/^\/admin\//, '').replace(/^\//, '')
        : m.name;
      return {
        href: `${base}/${slug}`,
        icon: Puzzle,
        label: firstPage?.label || m.displayName || m.name,
      };
    });
}

/**
 * Flat list of every nav item — used by the Cmd+K command palette to surface
 * direct-jump options.
 */
export function flattenNav(nav: NavGroup[], allExtNav: NavItem[]): NavItem[] {
  return [...nav.flatMap((g) => g.items), ...allExtNav];
}
