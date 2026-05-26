<!--
  Sparkline — small inline trend chart powered by Layerchart (S5-10).

  Dashboard stat cards now show a 7/30/90-day trend at a glance without
  requiring a separate page navigation. Layerchart is a Svelte 5-first
  wrapper over D3 (Svelte 5 runes for reactivity, D3 for math).

  Props are intentionally minimal — pass a number array and the
  component picks sensible axes + scales. For richer visualisations
  (axes labeled, multiple series, tooltips), use Layerchart's Chart /
  Svg primitives directly in the calling page.
-->
<script lang="ts">
import { Chart, Svg, Spline, Area } from 'layerchart';
import { scaleLinear } from 'd3-scale';

interface Props {
  /** Values in chronological order. Empty / single-value renders nothing. */
  data: number[];
  /** Width / height in px. Defaults sized for a stat-card footer. */
  width?: number;
  height?: number;
  /** Hex / CSS color for the line. Defaults to currentColor. */
  color?: string;
  /** Fill under the line. Defaults to color at 15% alpha. */
  showArea?: boolean;
}

let { data, width = 120, height = 32, color = 'currentColor', showArea = true }: Props = $props();

// Reshape the raw numbers into {x, y} points Layerchart expects. We
// index by position so the x axis is the just the natural order;
// callers pass time-ordered data, no date math needed inside the chart.
const points = $derived(data.map((y, x) => ({ x, y })));

// Tight y-domain so small variations don't get squashed. min/max with a
// small padding so the line never touches the SVG edge.
const yDomain = $derived.by(() => {
  if (data.length === 0) return [0, 1] as [number, number];
  const min = Math.min(...data);
  const max = Math.max(...data);
  if (min === max) return [min - 1, max + 1] as [number, number];
  const pad = (max - min) * 0.1;
  return [min - pad, max + pad] as [number, number];
});
</script>

{#if points.length >= 2}
  <div style="width: {width}px; height: {height}px;">
    <Chart
      data={points}
      x="x"
      y="y"
      xScale={scaleLinear()}
      yScale={scaleLinear()}
      yDomain={yDomain}
      padding={{ top: 2, bottom: 2, left: 0, right: 0 }}
    >
      <Svg>
        {#if showArea}
          <Area line={false} fill={color} fill-opacity={0.15} />
        {/if}
        <Spline stroke={color} stroke-width={1.5} fill="none" />
      </Svg>
    </Chart>
  </div>
{/if}
