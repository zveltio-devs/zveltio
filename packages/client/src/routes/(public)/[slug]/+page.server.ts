import type { PageServerLoad } from './$types';

const ENGINE_URL = process.env.PUBLIC_ENGINE_URL ?? 'http://localhost:3000';

/**
 * Loads a portal page by slug from the portal render API.
 * Supports both single-tenant (no tenant_id) and multi-tenant (X-Tenant-Id header) modes.
 */
export const load: PageServerLoad = async ({ params, fetch, request }) => {
  // Forward tenant header if present (multi-tenant mode)
  const tenantId = request.headers.get('x-tenant-id');
  const headers: Record<string, string> = {};
  if (tenantId) headers['x-tenant-id'] = tenantId;

  const res = await fetch(`${ENGINE_URL}/api/zones/client/render/${encodeURIComponent(params.slug)}`, { headers });

  if (!res.ok) {
    return { portalPage: null, views: [], status: res.status };
  }

  const data = await res.json();
  return { portalPage: data.page ?? null, views: data.views ?? [], status: 200 };
};
