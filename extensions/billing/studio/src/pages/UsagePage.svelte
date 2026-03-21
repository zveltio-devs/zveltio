<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';

  let usageByDay = $state<Array<{ event_type: string; day: string; total: number }>>([]);
  let liveEvents = $state<any[]>([]);
  let filterType = $state('');
  let loading = $state(true);
  let error = $state<string | null>(null);

  // All unique event types
  let eventTypes = $derived([...new Set(usageByDay.map((r) => r.event_type))]);

  // Filter live events
  let filteredEvents = $derived(
    filterType ? liveEvents.filter((e) => e.event_type === filterType) : liveEvents,
  );

  // Build SVG chart data for api_calls over last 30 days
  let chartData = $derived(() => {
    const apiRows = usageByDay.filter((r) => r.event_type === 'api_call');
    if (apiRows.length === 0) return { points: '', labels: [], maxVal: 0 };

    // Sort by day ascending
    const sorted = [...apiRows].sort((a, b) => a.day.localeCompare(b.day));
    const maxVal = Math.max(...sorted.map((r) => r.total), 1);

    const width = 600;
    const height = 200;
    const padLeft = 50;
    const padBottom = 30;
    const innerW = width - padLeft - 10;
    const innerH = height - padBottom - 10;

    const points = sorted
      .map((r, i) => {
        const x = padLeft + (i / Math.max(sorted.length - 1, 1)) * innerW;
        const y = 10 + innerH - (r.total / maxVal) * innerH;
        return `${x},${y}`;
      })
      .join(' ');

    const labels = sorted
      .filter((_, i) => i === 0 || i === sorted.length - 1 || i % 5 === 0)
      .map((r, _, arr) => {
        const idx = sorted.indexOf(r);
        const x = padLeft + (idx / Math.max(sorted.length - 1, 1)) * innerW;
        return { x, label: r.day.slice(5, 10) };
      });

    return { points, labels, maxVal };
  });

  onMount(async () => {
    try {
      const [usageRes, liveRes] = await Promise.all([
        api.get('/extensions/billing/usage'),
        api.get('/extensions/billing/usage/live'),
      ]);
      usageByDay = (usageRes.usage ?? []).map((r: any) => ({
        ...r,
        total: Number(r.total),
      }));
      liveEvents = liveRes.events ?? [];
    } catch (e: any) {
      error = e.message ?? 'Failed to load usage data';
    } finally {
      loading = false;
    }
  });
</script>

<div class="usage-page">
  <h1>Usage Dashboard</h1>

  {#if loading}
    <p class="loading">Loading usage data…</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else}
    <section class="chart-section">
      <h2>API Calls — Last 30 Days</h2>
      {@const chart = chartData()}
      {#if chart.points}
        <div class="chart-wrapper">
          <svg viewBox="0 0 600 200" class="line-chart" aria-label="API calls chart">
            <!-- Grid lines -->
            {#each [0.25, 0.5, 0.75, 1] as frac}
              {@const y = 10 + (1 - frac) * 160}
              <line x1="50" y1={y} x2="590" y2={y} stroke="#f3f4f6" stroke-width="1" />
              <text x="44" y={y + 4} font-size="9" fill="#9ca3af" text-anchor="end">
                {Math.round(chart.maxVal * frac).toLocaleString()}
              </text>
            {/each}
            <!-- Line -->
            <polyline
              points={chart.points}
              fill="none"
              stroke="#6366f1"
              stroke-width="2"
              stroke-linejoin="round"
            />
            <!-- Area fill -->
            {#if chart.points}
              {@const firstX = chart.points.split(' ')[0]?.split(',')[0]}
              {@const lastX = chart.points.split(' ').at(-1)?.split(',')[0]}
              <polygon
                points="{chart.points} {lastX},170 {firstX},170"
                fill="#6366f1"
                fill-opacity="0.08"
              />
            {/if}
            <!-- X-axis labels -->
            {#each chart.labels as lbl}
              <text x={lbl.x} y="195" font-size="9" fill="#9ca3af" text-anchor="middle">
                {lbl.label}
              </text>
            {/each}
          </svg>
        </div>
      {:else}
        <p class="no-data">No API call data available.</p>
      {/if}
    </section>

    <section class="events-section">
      <div class="events-header">
        <h2>Recent Events</h2>
        <select bind:value={filterType} class="filter-select">
          <option value="">All types</option>
          {#each eventTypes as et}
            <option value={et}>{et}</option>
          {/each}
        </select>
      </div>

      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Event Type</th>
              <th>Collection</th>
              <th>Tenant</th>
              <th>Quantity</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {#each filteredEvents as ev}
              <tr>
                <td><span class="badge">{ev.event_type}</span></td>
                <td>{ev.collection ?? '—'}</td>
                <td>{ev.tenant_id ?? '—'}</td>
                <td>{ev.quantity}</td>
                <td class="time">{new Date(ev.created_at).toLocaleString()}</td>
              </tr>
            {:else}
              <tr><td colspan="5" class="empty">No events found.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}
</div>

<style>
  .usage-page { max-width: 960px; margin: 0 auto; padding: 2rem; }
  h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 1.5rem; }
  h2 { font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; }
  section { margin-bottom: 2rem; }
  .loading { color: #6b7280; }
  .error { color: #ef4444; }
  .no-data { color: #9ca3af; font-size: 0.9rem; }
  .chart-wrapper { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem; }
  .line-chart { width: 100%; height: auto; display: block; }
  .events-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
  .filter-select { padding: 0.35rem 0.75rem; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 0.875rem; }
  .table-wrapper { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
  th { text-align: left; padding: 0.5rem 0.75rem; background: #f9fafb; border-bottom: 1px solid #e5e7eb; font-weight: 600; color: #374151; }
  td { padding: 0.5rem 0.75rem; border-bottom: 1px solid #f3f4f6; color: #6b7280; }
  .badge { background: #ede9fe; color: #7c3aed; padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 500; }
  .time { font-size: 0.8rem; white-space: nowrap; }
  .empty { text-align: center; color: #9ca3af; }
</style>
