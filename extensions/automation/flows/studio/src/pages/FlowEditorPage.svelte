<script lang="ts">
  import { onMount } from 'svelte';
  import { Save, Plus, Trash2, Play, CheckCircle, ZoomIn, ZoomOut, Maximize2, ArrowLeft, Link } from '@lucide/svelte';

  // ─── Constants ────────────────────────────────────────────────────────────────

  const engineUrl = (window as any).__ZVELTIO_ENGINE_URL__ || '';
  const flowId = window.location.hash.match(/\/flows\/([^/]+)\/edit/)?.[1];

  const NODE_W = 220;
  const NODE_H = 80;
  const NODE_H_COND = 100;
  const PORT_R = 7;

  const STEP_TYPES = [
    { type: 'condition',      label: 'Condition',     icon: 'C', description: 'Branch based on a value',    defaultConfig: { field: '', operator: 'eq', value: '' } },
    { type: 'send_email',     label: 'Send Email',    icon: 'E', description: 'Send an email notification', defaultConfig: { to: '', subject: '', body: '' } },
    { type: 'webhook',        label: 'HTTP Request',  icon: 'H', description: 'Call an external URL',       defaultConfig: { url: '', method: 'POST', body: '' } },
    { type: 'create_record',  label: 'Create Record', icon: 'CR', description: 'Insert into a collection',  defaultConfig: { collection: '', data: '{}' } },
    { type: 'update_record',  label: 'Update Record', icon: 'UR', description: 'Update a record',           defaultConfig: { collection: '', id: '{{id}}', data: '{}' } },
    { type: 'delay',          label: 'Delay',         icon: '⏱', description: 'Wait before continuing',    defaultConfig: { hours: 0, minutes: 0 } },
    { type: 'ai_completion',  label: 'AI Completion', icon: 'AI', description: 'Run an AI prompt',         defaultConfig: { prompt: '', system: '' } },
    { type: 'ai_decision',    label: 'AI Decision',   icon: 'AD', description: 'AI-powered branching',     defaultConfig: { prompt: '', system: '' } },
  ];

  function nodeIcon(type: string): string {
    if (type === 'trigger')       return 'T';
    const found = STEP_TYPES.find(s => s.type === type);
    return found?.icon ?? type.slice(0, 2).toUpperCase();
  }

  function nodeColor(type: string): string {
    if (type === 'trigger')      return '#6366f1'; // indigo
    if (type === 'condition' || type === 'ai_decision') return '#f59e0b'; // amber
    if (type === 'send_email')   return '#10b981'; // green
    if (type === 'webhook')      return '#3b82f6'; // blue
    if (type === 'delay')        return '#8b5cf6'; // purple
    if (type === 'ai_completion') return '#ec4899'; // pink
    return '#6b7280'; // gray
  }

  function nodeHeight(type: string): number {
    return (type === 'condition' || type === 'ai_decision') ? NODE_H_COND : NODE_H;
  }

  // ─── Interfaces ───────────────────────────────────────────────────────────────

  interface FlowNode {
    id: string;
    type: string;
    label: string;
    config: Record<string, any>;
    x: number;
    y: number;
  }

  interface FlowEdge {
    id: string;
    sourceId: string;
    sourcePort: 'output' | 'true' | 'false';
    targetId: string;
  }

  // ─── State ────────────────────────────────────────────────────────────────────

  let flow           = $state<any>(null);
  let loading        = $state(true);
  let saving         = $state(false);
  let saved          = $state(false);
  let runs           = $state<any[]>([]);

  let selectedNodeId = $state<string | null>(null);
  let pan            = $state({ x: 0, y: 0 });
  let zoom           = $state(1);

  let isDragging     = $state(false);
  let dragNodeId     = $state<string | null>(null);
  let dragOffset     = $state({ x: 0, y: 0 });

  let isPanning      = $state(false);
  let panStart       = $state({ x: 0, y: 0 });
  let panOrigin      = $state({ x: 0, y: 0 });

  let isConnecting   = $state(false);
  let connectFrom    = $state<{ nodeId: string; port: string } | null>(null);
  let connectMouse   = $state({ x: 0, y: 0 });

  let showNodePicker = $state(false);
  let nodePickerPos  = $state({ x: 0, y: 0 });  // canvas coords
  let nodePickerScreen = $state({ x: 0, y: 0 }); // screen coords for positioning the dialog

  // ─── Derived ──────────────────────────────────────────────────────────────────

  let nodes    = $derived<FlowNode[]>((flow?.steps as FlowNode[]) ?? []);
  let edges    = $derived<FlowEdge[]>((flow?.edges as FlowEdge[]) ?? []);
  let selectedNode = $derived(nodes.find(n => n.id === selectedNodeId) ?? null);

  // ─── Port geometry ────────────────────────────────────────────────────────────

  function inputPortXY(node: FlowNode): { x: number; y: number } {
    return { x: node.x, y: node.y + nodeHeight(node.type) / 2 };
  }

  function outputPortXY(node: FlowNode, port: 'output' | 'true' | 'false' = 'output'): { x: number; y: number } {
    const h = nodeHeight(node.type);
    if (port === 'true')  return { x: node.x + NODE_W, y: node.y + h * 0.3 };
    if (port === 'false') return { x: node.x + NODE_W, y: node.y + h * 0.7 };
    return { x: node.x + NODE_W, y: node.y + h / 2 };
  }

  function isConditional(type: string): boolean {
    return type === 'condition' || type === 'ai_decision';
  }

  // ─── Edge path ────────────────────────────────────────────────────────────────

  function edgePath(edge: FlowEdge): string {
    const src = nodes.find(n => n.id === edge.sourceId);
    const tgt = nodes.find(n => n.id === edge.targetId);
    if (!src || !tgt) return '';
    const s = outputPortXY(src, edge.sourcePort);
    const t = inputPortXY(tgt);
    const cx = 80;
    return `M ${s.x} ${s.y} C ${s.x + cx} ${s.y}, ${t.x - cx} ${t.y}, ${t.x} ${t.y}`;
  }

  function tempEdgePath(): string {
    if (!connectFrom) return '';
    const src = nodes.find(n => n.id === connectFrom!.nodeId);
    if (!src) return '';
    const s = outputPortXY(src, connectFrom.port as any);
    const t = connectMouse;
    const cx = 60;
    return `M ${s.x} ${s.y} C ${s.x + cx} ${s.y}, ${t.x - cx} ${t.y}, ${t.x} ${t.y}`;
  }

  // ─── Load / Save ──────────────────────────────────────────────────────────────

  onMount(async () => {
    if (!flowId) return;
    await Promise.all([loadFlow(), loadRuns()]);
  });

  async function loadFlow() {
    const res  = await fetch(`${engineUrl}/api/flows/${flowId}`, { credentials: 'include' });
    const data = await res.json();
    flow = data.flow;
    if (typeof flow.steps   === 'string') flow.steps   = JSON.parse(flow.steps);
    if (typeof flow.trigger === 'string') flow.trigger = JSON.parse(flow.trigger);
    // Initialise edges
    if (!flow.edges) flow.edges = [];
    if (typeof flow.edges === 'string') flow.edges = JSON.parse(flow.edges);
    // Auto-layout legacy nodes without x/y
    flow.steps = (flow.steps || []).map((s: any, i: number) => ({
      ...s,
      x: s.x ?? 300,
      y: s.y ?? (i * 150 + 100),
    }));
    loading = false;
  }

  async function loadRuns() {
    const res  = await fetch(`${engineUrl}/api/flows/${flowId}/runs`, { credentials: 'include' });
    const data = await res.json();
    runs = data.runs || [];
  }

  async function save() {
    saving = true;
    try {
      await fetch(`${engineUrl}/api/flows/${flowId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: flow.name,
          description: flow.description,
          steps: flow.steps,
          edges: flow.edges,
          trigger: flow.trigger,
        }),
      });
      saved = true;
      setTimeout(() => (saved = false), 2000);
    } finally {
      saving = false;
    }
  }

  async function runFlow() {
    await save();
    await fetch(`${engineUrl}/api/flows/${flowId}/run`, { method: 'POST', credentials: 'include' });
    setTimeout(loadRuns, 500);
  }

  // ─── Node management ──────────────────────────────────────────────────────────

  function addNode(st: (typeof STEP_TYPES)[0]) {
    const newNode: FlowNode = {
      id:     crypto.randomUUID(),
      type:   st.type,
      label:  st.label,
      config: { ...st.defaultConfig },
      x:      nodePickerPos.x,
      y:      nodePickerPos.y,
    };
    flow.steps = [...(flow.steps || []), newNode];
    selectedNodeId = newNode.id;
    showNodePicker = false;
  }

  function removeNode(id: string) {
    flow.steps = (flow.steps || []).filter((n: FlowNode) => n.id !== id);
    flow.edges = (flow.edges || []).filter((e: FlowEdge) => e.sourceId !== id && e.targetId !== id);
    if (selectedNodeId === id) selectedNodeId = null;
  }

  function removeEdge(id: string) {
    flow.edges = (flow.edges || []).filter((e: FlowEdge) => e.id !== id);
  }

  // ─── Auto-layout ──────────────────────────────────────────────────────────────

  function autoLayout() {
    const allNodes: FlowNode[] = flow.steps || [];
    if (allNodes.length === 0) return;

    // Find trigger (always first, or node not targeted by any edge)
    const targeted = new Set((flow.edges || []).map((e: FlowEdge) => e.targetId));
    const roots    = allNodes.filter(n => !targeted.has(n.id));

    // BFS depth assignment
    const depth: Record<string, number> = {};
    const queue: string[] = roots.map(r => r.id);
    roots.forEach(r => (depth[r.id] = 0));
    while (queue.length) {
      const cur = queue.shift()!;
      const out = (flow.edges || []).filter((e: FlowEdge) => e.sourceId === cur);
      for (const e of out) {
        if (depth[e.targetId] === undefined) {
          depth[e.targetId] = (depth[cur] ?? 0) + 1;
          queue.push(e.targetId);
        }
      }
    }
    // Nodes not reachable default to depth 0
    allNodes.forEach(n => { if (depth[n.id] === undefined) depth[n.id] = 0; });

    // Group by depth
    const levels: Record<number, FlowNode[]> = {};
    allNodes.forEach(n => {
      const d = depth[n.id];
      if (!levels[d]) levels[d] = [];
      levels[d].push(n);
    });

    // Assign positions
    const XGAP = 300;
    const YGAP = 150;
    const updatedSteps = [...allNodes];
    for (const [d, group] of Object.entries(levels)) {
      const depthNum = Number(d);
      group.forEach((node, i) => {
        const idx = updatedSteps.findIndex(n => n.id === node.id);
        updatedSteps[idx] = { ...updatedSteps[idx], x: depthNum * XGAP + 50, y: i * YGAP + 100 };
      });
    }
    flow.steps = updatedSteps;
  }

  function fitView() {
    const allNodes: FlowNode[] = flow?.steps || [];
    if (allNodes.length === 0) { pan = { x: 0, y: 0 }; zoom = 1; return; }
    const xs = allNodes.map(n => n.x);
    const ys = allNodes.map(n => n.y);
    const minX = Math.min(...xs) - 40;
    const minY = Math.min(...ys) - 40;
    const maxX = Math.max(...xs) + NODE_W + 40;
    const maxY = Math.max(...ys) + NODE_H_COND + 40;
    const W = svgEl?.clientWidth  || 800;
    const H = svgEl?.clientHeight || 600;
    const z = Math.min(W / (maxX - minX), H / (maxY - minY), 1.5);
    zoom = z;
    pan  = { x: (W - (maxX + minX) * z) / 2, y: (H - (maxY + minY) * z) / 2 };
  }

  // ─── SVG element reference ────────────────────────────────────────────────────

  let svgEl: SVGSVGElement | undefined = $state();

  // ─── Coordinate helpers ───────────────────────────────────────────────────────

  function screenToCanvas(sx: number, sy: number): { x: number; y: number } {
    if (!svgEl) return { x: sx, y: sy };
    const rect = svgEl.getBoundingClientRect();
    return {
      x: (sx - rect.left - pan.x) / zoom,
      y: (sy - rect.top  - pan.y) / zoom,
    };
  }

  // ─── Interaction: drag nodes ──────────────────────────────────────────────────

  function onNodeMouseDown(e: MouseEvent, nodeId: string) {
    if (isConnecting) return;
    e.stopPropagation();
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    const cp = screenToCanvas(e.clientX, e.clientY);
    dragNodeId  = nodeId;
    dragOffset  = { x: cp.x - node.x, y: cp.y - node.y };
    isDragging  = true;
    selectedNodeId = nodeId;
  }

  function onSvgMouseMove(e: MouseEvent) {
    if (isDragging && dragNodeId) {
      const cp = screenToCanvas(e.clientX, e.clientY);
      const idx = flow.steps.findIndex((n: FlowNode) => n.id === dragNodeId);
      if (idx >= 0) {
        flow.steps[idx] = { ...flow.steps[idx], x: cp.x - dragOffset.x, y: cp.y - dragOffset.y };
      }
      return;
    }
    if (isPanning) {
      pan = {
        x: panOrigin.x + (e.clientX - panStart.x),
        y: panOrigin.y + (e.clientY - panStart.y),
      };
      return;
    }
    if (isConnecting) {
      const cp = screenToCanvas(e.clientX, e.clientY);
      connectMouse = cp;
    }
  }

  function onSvgMouseUp(e: MouseEvent) {
    if (isDragging) { isDragging = false; dragNodeId = null; }
    if (isPanning)  { isPanning = false; }
  }

  // ─── Interaction: pan ─────────────────────────────────────────────────────────

  function onSvgMouseDown(e: MouseEvent) {
    // Middle mouse or space held
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      e.preventDefault();
      isPanning = true;
      panStart  = { x: e.clientX, y: e.clientY };
      panOrigin = { x: pan.x, y: pan.y };
      return;
    }
    // Left click on background → deselect
    if (e.button === 0) {
      if (isConnecting) { isConnecting = false; connectFrom = null; }
      selectedNodeId = null;
    }
  }

  let spaceHeld = $state(false);

  function onKeyDown(e: KeyboardEvent) {
    if (e.code === 'Space' && e.target === document.body) { spaceHeld = true; e.preventDefault(); }
    if (e.code === 'Delete' || e.code === 'Backspace') {
      if (selectedNodeId && e.target === document.body) removeNode(selectedNodeId);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
  }
  function onKeyUp(e: KeyboardEvent) {
    if (e.code === 'Space') spaceHeld = false;
  }

  // ─── Interaction: zoom ────────────────────────────────────────────────────────

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZ   = Math.max(0.2, Math.min(3, zoom * factor));
    if (!svgEl) { zoom = newZ; return; }
    const rect  = svgEl.getBoundingClientRect();
    const ox    = e.clientX - rect.left;
    const oy    = e.clientY - rect.top;
    pan = {
      x: ox - (ox - pan.x) * (newZ / zoom),
      y: oy - (oy - pan.y) * (newZ / zoom),
    };
    zoom = newZ;
  }

  // ─── Interaction: double-click to add node ───────────────────────────────────

  function onSvgDblClick(e: MouseEvent) {
    if ((e.target as SVGElement).tagName !== 'svg' && (e.target as SVGElement).tagName !== 'rect') return;
    const cp = screenToCanvas(e.clientX, e.clientY);
    nodePickerPos    = cp;
    nodePickerScreen = { x: e.clientX, y: e.clientY };
    showNodePicker   = true;
  }

  // ─── Interaction: port click → connect ───────────────────────────────────────

  function onPortClick(e: MouseEvent, nodeId: string, port: string, isInput: boolean) {
    e.stopPropagation();
    if (!isConnecting) {
      if (!isInput) {
        // Start connecting from output port
        isConnecting = true;
        connectFrom  = { nodeId, port };
        const cp = screenToCanvas(e.clientX, e.clientY);
        connectMouse = cp;
      }
    } else {
      // Finish connecting to input port
      if (isInput && connectFrom && connectFrom.nodeId !== nodeId) {
        // Check for duplicate edge
        const exists = (flow.edges || []).some(
          (ed: FlowEdge) => ed.sourceId === connectFrom!.nodeId && ed.sourcePort === connectFrom!.port && ed.targetId === nodeId
        );
        if (!exists) {
          const newEdge: FlowEdge = {
            id:         crypto.randomUUID(),
            sourceId:   connectFrom.nodeId,
            sourcePort: connectFrom.port as FlowEdge['sourcePort'],
            targetId:   nodeId,
          };
          flow.edges = [...(flow.edges || []), newEdge];
        }
      }
      isConnecting = false;
      connectFrom  = null;
    }
  }

  // ─── Run history helpers ──────────────────────────────────────────────────────

  function statusClass(status: string): string {
    return status === 'completed' ? 'text-success' : status === 'failed' ? 'text-error' : 'text-warning';
  }
  function statusIcon(status: string): string {
    return status === 'completed' ? '✓' : status === 'failed' ? '✗' : '…';
  }

  // ─── Config helpers ───────────────────────────────────────────────────────────

  function updateNodeField(id: string, field: string, value: any) {
    const idx = flow.steps.findIndex((n: FlowNode) => n.id === id);
    if (idx < 0) return;
    flow.steps[idx] = { ...flow.steps[idx], [field]: value };
  }

  function updateNodeConfig(id: string, key: string, value: any) {
    const idx = flow.steps.findIndex((n: FlowNode) => n.id === id);
    if (idx < 0) return;
    flow.steps[idx] = { ...flow.steps[idx], config: { ...flow.steps[idx].config, [key]: value } };
  }

  function edgesForNode(nodeId: string): FlowEdge[] {
    return (flow?.edges || []).filter((e: FlowEdge) => e.sourceId === nodeId || e.targetId === nodeId);
  }
</script>

<svelte:window onkeydown={onKeyDown} onkeyup={onKeyUp} />

{#if loading}
  <div class="flex justify-center py-12">
    <span class="loading loading-spinner loading-lg"></span>
  </div>
{:else if !flow}
  <p class="text-error p-8">Flow not found</p>
{:else}
  <!-- Root layout -->
  <div class="flex flex-col h-[calc(100vh-4rem)]" style="user-select: none;">

    <!-- ── Toolbar ─────────────────────────────────────────────────────────── -->
    <div class="flex items-center gap-2 px-4 py-2 border-b border-base-300 bg-base-100 flex-shrink-0">
      <a href="#/flows" class="btn btn-ghost btn-sm gap-1">
        <ArrowLeft size={14} />
        Flows
      </a>
      <div class="divider divider-horizontal mx-0"></div>
      <input
        type="text"
        bind:value={flow.name}
        class="font-bold text-base bg-transparent border-none outline-none min-w-40 max-w-72"
      />
      <div class="flex-1"></div>

      <!-- Add node -->
      <button
        class="btn btn-outline btn-sm gap-1"
        onclick={() => {
          nodePickerPos    = { x: (svgEl?.clientWidth  || 800) / 2 / zoom - pan.x / zoom, y: (svgEl?.clientHeight || 600) / 2 / zoom - pan.y / zoom };
          nodePickerScreen = { x: 200, y: 80 };
          showNodePicker   = true;
        }}
      >
        <Plus size={14} />
        Add Node
      </button>

      <!-- Auto layout -->
      <button class="btn btn-ghost btn-sm" onclick={autoLayout} title="Auto Layout">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="6" height="6"/><rect x="15" y="3" width="6" height="6"/>
          <rect x="9" y="15" width="6" height="6"/>
          <line x1="6" y1="9" x2="6" y2="12"/><line x1="18" y1="9" x2="18" y2="12"/>
          <line x1="6" y1="12" x2="12" y2="18"/><line x1="18" y1="12" x2="12" y2="18"/>
        </svg>
        Layout
      </button>

      <!-- Zoom -->
      <div class="flex items-center gap-1">
        <button class="btn btn-ghost btn-xs" onclick={() => { zoom = Math.max(0.2, zoom - 0.1); }}><ZoomOut size={12} /></button>
        <span class="text-xs w-10 text-center">{Math.round(zoom * 100)}%</span>
        <button class="btn btn-ghost btn-xs" onclick={() => { zoom = Math.min(3, zoom + 0.1); }}><ZoomIn size={12} /></button>
        <button class="btn btn-ghost btn-xs" onclick={fitView} title="Fit"><Maximize2 size={12} /></button>
      </div>

      <div class="divider divider-horizontal mx-0"></div>

      <!-- Run -->
      <button class="btn btn-ghost btn-sm gap-1" onclick={runFlow}>
        <Play size={14} />
        Run
      </button>

      <!-- Save -->
      <button class="btn btn-primary btn-sm gap-1" onclick={save} disabled={saving}>
        {#if saving}
          <span class="loading loading-spinner loading-xs"></span>
        {:else if saved}
          <CheckCircle size={14} />
        {:else}
          <Save size={14} />
        {/if}
        Save
      </button>
    </div>

    <!-- ── Canvas + Right panel ─────────────────────────────────────────────── -->
    <div class="flex flex-1 overflow-hidden">

      <!-- SVG Canvas -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <svg
        bind:this={svgEl}
        class="flex-1 bg-base-200"
        style="cursor: {isPanning ? 'grabbing' : spaceHeld ? 'grab' : isConnecting ? 'crosshair' : 'default'};"
        onmousedown={onSvgMouseDown}
        onmousemove={onSvgMouseMove}
        onmouseup={onSvgMouseUp}
        onwheel={onWheel}
        ondblclick={onSvgDblClick}
        role="application"
        aria-label="Flow canvas"
      >
        <defs>
          <!-- Dot grid pattern -->
          <pattern id="dotgrid" width="24" height="24" patternUnits="userSpaceOnUse"
            patternTransform="translate({pan.x % 24} {pan.y % 24}) scale({zoom})">
            <circle cx="12" cy="12" r="1" fill="oklch(var(--bc)/0.15)" />
          </pattern>
          <!-- Arrowhead marker -->
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill="oklch(var(--bc)/0.5)" />
          </marker>
          <marker id="arrow-selected" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill="oklch(var(--p))" />
          </marker>
        </defs>

        <!-- Background -->
        <rect width="100%" height="100%" fill="url(#dotgrid)" />

        <!-- Pan+zoom group -->
        <g transform="translate({pan.x} {pan.y}) scale({zoom})">

          <!-- ── Edges ──────────────────────────────────────────────────────── -->
          {#each edges as edge (edge.id)}
            {@const path = edgePath(edge)}
            {#if path}
              {@const isRelatedToSelected = selectedNodeId && (edge.sourceId === selectedNodeId || edge.targetId === selectedNodeId)}
              <path
                d={path}
                fill="none"
                stroke={isRelatedToSelected ? 'oklch(var(--p))' : 'oklch(var(--bc)/0.4)'}
                stroke-width={isRelatedToSelected ? 2 : 1.5}
                marker-end={isRelatedToSelected ? 'url(#arrow-selected)' : 'url(#arrow)'}
                stroke-dasharray={isRelatedToSelected ? '' : ''}
              />
              <!-- Edge label for condition ports -->
              {#if edge.sourcePort === 'true' || edge.sourcePort === 'false'}
                {@const src = nodes.find(n => n.id === edge.sourceId)}
                {#if src}
                  {@const sp = outputPortXY(src, edge.sourcePort)}
                  <text
                    x={sp.x + 12}
                    y={sp.y - 4}
                    font-size="10"
                    fill={edge.sourcePort === 'true' ? '#10b981' : '#ef4444'}
                    font-weight="600"
                  >{edge.sourcePort}</text>
                {/if}
              {/if}
            {/if}
          {/each}

          <!-- Temp edge while connecting -->
          {#if isConnecting && connectFrom}
            <path
              d={tempEdgePath()}
              fill="none"
              stroke="oklch(var(--p))"
              stroke-width="2"
              stroke-dasharray="6 3"
              marker-end="url(#arrow-selected)"
            />
          {/if}

          <!-- ── Nodes ──────────────────────────────────────────────────────── -->
          {#each nodes as node (node.id)}
            {@const h = nodeHeight(node.type)}
            {@const color = nodeColor(node.type)}
            {@const isSel = selectedNodeId === node.id}
            {@const isCond = isConditional(node.type)}
            {@const isTrigger = node.type === 'trigger'}

            <!-- Node shadow -->
            <rect
              x={node.x - 2}
              y={node.y + 3}
              width={NODE_W + 4}
              height={h}
              rx="10"
              ry="10"
              fill="black"
              opacity="0.08"
            />

            <!-- Node body -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <rect
              x={node.x}
              y={node.y}
              width={NODE_W}
              height={h}
              rx="8"
              ry="8"
              fill="oklch(var(--b1))"
              stroke={isSel ? color : 'oklch(var(--bc)/0.15)'}
              stroke-width={isSel ? 2.5 : 1}
              onmousedown={(e) => onNodeMouseDown(e, node.id)}
              style="cursor: move;"
            />

            <!-- Left color accent bar -->
            <rect
              x={node.x}
              y={node.y}
              width="6"
              height={h}
              rx="8"
              ry="0"
              fill={color}
              onmousedown={(e) => onNodeMouseDown(e, node.id)}
              style="cursor: move;"
            />
            <rect
              x={node.x}
              y={node.y}
              width="12"
              height={h}
              fill={color}
              onmousedown={(e) => onNodeMouseDown(e, node.id)}
              style="cursor: move;"
            />

            <!-- Icon circle -->
            <circle
              cx={node.x + 28}
              cy={node.y + h / 2}
              r="14"
              fill={color}
              opacity="0.18"
              onmousedown={(e) => onNodeMouseDown(e, node.id)}
              style="cursor: move;"
            />
            <text
              x={node.x + 28}
              y={node.y + h / 2 + 4}
              text-anchor="middle"
              font-size="10"
              font-weight="700"
              fill={color}
              onmousedown={(e) => onNodeMouseDown(e, node.id)}
              style="cursor: move; pointer-events: none;"
            >{nodeIcon(node.type)}</text>

            <!-- Label -->
            <text
              x={node.x + 52}
              y={node.y + (isCond ? h / 2 - 6 : h / 2 + 1)}
              font-size="12"
              font-weight="600"
              fill="oklch(var(--bc))"
              style="pointer-events: none;"
            >{node.label || node.type}</text>

            <!-- Type subtitle -->
            {#if isCond}
              <text
                x={node.x + 52}
                y={node.y + h / 2 + 10}
                font-size="10"
                fill="oklch(var(--bc)/0.5)"
                style="pointer-events: none;"
              >{node.type}</text>
            {/if}

            <!-- Input port (left center) — not for trigger -->
            {#if !isTrigger}
              {@const ip = inputPortXY(node)}
              <circle
                cx={ip.x}
                cy={ip.y}
                r={PORT_R}
                fill="oklch(var(--b1))"
                stroke={isConnecting ? 'oklch(var(--p))' : 'oklch(var(--bc)/0.35)'}
                stroke-width="2"
                style="cursor: crosshair;"
                onclick={(e) => onPortClick(e, node.id, 'input', true)}
              />
              <circle cx={ip.x} cy={ip.y} r="3" fill="oklch(var(--bc)/0.4)" style="pointer-events: none;" />
            {/if}

            <!-- Output port(s) (right side) -->
            {#if isCond}
              <!-- true port -->
              {@const tp = outputPortXY(node, 'true')}
              <circle
                cx={tp.x}
                cy={tp.y}
                r={PORT_R}
                fill="#10b981"
                stroke="oklch(var(--b1))"
                stroke-width="2"
                style="cursor: crosshair;"
                onclick={(e) => onPortClick(e, node.id, 'true', false)}
              />
              <text x={tp.x + 10} y={tp.y + 4} font-size="9" fill="#10b981" font-weight="700" style="pointer-events:none;">T</text>
              <!-- false port -->
              {@const fp = outputPortXY(node, 'false')}
              <circle
                cx={fp.x}
                cy={fp.y}
                r={PORT_R}
                fill="#ef4444"
                stroke="oklch(var(--b1))"
                stroke-width="2"
                style="cursor: crosshair;"
                onclick={(e) => onPortClick(e, node.id, 'false', false)}
              />
              <text x={fp.x + 10} y={fp.y + 4} font-size="9" fill="#ef4444" font-weight="700" style="pointer-events:none;">F</text>
            {:else}
              {@const op = outputPortXY(node, 'output')}
              <circle
                cx={op.x}
                cy={op.y}
                r={PORT_R}
                fill={isSel ? color : 'oklch(var(--b1))'}
                stroke={isSel ? color : 'oklch(var(--bc)/0.35)'}
                stroke-width="2"
                style="cursor: crosshair;"
                onclick={(e) => onPortClick(e, node.id, 'output', false)}
              />
              <circle cx={op.x} cy={op.y} r="3" fill={isSel ? 'white' : 'oklch(var(--bc)/0.4)'} style="pointer-events: none;" />
            {/if}
          {/each}

        </g>
      </svg>

      <!-- ── Right Panel ────────────────────────────────────────────────────── -->
      <div class="w-80 flex flex-col bg-base-100 border-l border-base-300 flex-shrink-0">

        <!-- Node config -->
        <div class="flex-1 overflow-y-auto p-4">
          {#if selectedNode}
            {@const sn = selectedNode}

            <!-- Header -->
            <div class="flex items-center justify-between mb-4">
              <div class="flex items-center gap-2">
                <div class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white" style="background: {nodeColor(sn.type)};">
                  {nodeIcon(sn.type)}
                </div>
                <h3 class="font-semibold">{sn.label || sn.type}</h3>
              </div>
              <button class="btn btn-ghost btn-xs text-error" onclick={() => removeNode(sn.id)}>
                <Trash2 size={13} />
              </button>
            </div>

            <!-- Label -->
            <div class="form-control mb-3">
              <label class="label py-0.5"><span class="label-text text-xs font-medium">Label</span></label>
              <input
                type="text"
                class="input input-sm input-bordered"
                value={sn.label}
                oninput={(e) => updateNodeField(sn.id, 'label', (e.target as HTMLInputElement).value)}
              />
            </div>

            <div class="divider my-2 text-xs">Configuration</div>

            <!-- Per-type config forms -->
            {#if sn.type === 'send_email'}
              <div class="space-y-2">
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">To</span></label>
                  <input type="text" class="input input-sm input-bordered" value={sn.config.to ?? ''} oninput={(e) => updateNodeConfig(sn.id, 'to', (e.target as HTMLInputElement).value)} />
                </div>
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Subject</span></label>
                  <input type="text" class="input input-sm input-bordered" value={sn.config.subject ?? ''} oninput={(e) => updateNodeConfig(sn.id, 'subject', (e.target as HTMLInputElement).value)} />
                </div>
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Body</span></label>
                  <textarea class="textarea textarea-sm textarea-bordered text-xs" rows="4" value={sn.config.body ?? ''} oninput={(e) => updateNodeConfig(sn.id, 'body', (e.target as HTMLTextAreaElement).value)}></textarea>
                </div>
              </div>

            {:else if sn.type === 'webhook'}
              <div class="space-y-2">
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">URL</span></label>
                  <input type="url" class="input input-sm input-bordered" value={sn.config.url ?? ''} oninput={(e) => updateNodeConfig(sn.id, 'url', (e.target as HTMLInputElement).value)} />
                </div>
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Method</span></label>
                  <select class="select select-sm select-bordered" value={sn.config.method ?? 'POST'} onchange={(e) => updateNodeConfig(sn.id, 'method', (e.target as HTMLSelectElement).value)}>
                    <option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option>
                  </select>
                </div>
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Body (JSON)</span></label>
                  <textarea class="textarea textarea-sm textarea-bordered font-mono text-xs" rows="4" value={typeof sn.config.body === 'object' ? JSON.stringify(sn.config.body, null, 2) : (sn.config.body ?? '')} oninput={(e) => { const v = (e.target as HTMLTextAreaElement).value; try { updateNodeConfig(sn.id, 'body', JSON.parse(v)); } catch { updateNodeConfig(sn.id, 'body', v); } }}></textarea>
                </div>
              </div>

            {:else if sn.type === 'condition'}
              <div class="space-y-2">
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Field</span></label>
                  <input type="text" class="input input-sm input-bordered" placeholder="e.g. data.status" value={sn.config.field ?? ''} oninput={(e) => updateNodeConfig(sn.id, 'field', (e.target as HTMLInputElement).value)} />
                </div>
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Operator</span></label>
                  <select class="select select-sm select-bordered" value={sn.config.operator ?? 'eq'} onchange={(e) => updateNodeConfig(sn.id, 'operator', (e.target as HTMLSelectElement).value)}>
                    <option value="eq">equals (eq)</option>
                    <option value="neq">not equals (neq)</option>
                    <option value="gt">greater than (gt)</option>
                    <option value="lt">less than (lt)</option>
                    <option value="contains">contains</option>
                  </select>
                </div>
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Value</span></label>
                  <input type="text" class="input input-sm input-bordered" value={sn.config.value ?? ''} oninput={(e) => updateNodeConfig(sn.id, 'value', (e.target as HTMLInputElement).value)} />
                </div>
              </div>

            {:else if sn.type === 'create_record' || sn.type === 'update_record'}
              <div class="space-y-2">
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Collection</span></label>
                  <input type="text" class="input input-sm input-bordered" value={sn.config.collection ?? ''} oninput={(e) => updateNodeConfig(sn.id, 'collection', (e.target as HTMLInputElement).value)} />
                </div>
                {#if sn.type === 'update_record'}
                  <div class="form-control">
                    <label class="label py-0.5"><span class="label-text text-xs">Record ID</span></label>
                    <input type="text" class="input input-sm input-bordered" value={sn.config.id ?? '{{id}}'} oninput={(e) => updateNodeConfig(sn.id, 'id', (e.target as HTMLInputElement).value)} />
                  </div>
                {/if}
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Data (JSON)</span></label>
                  <textarea class="textarea textarea-sm textarea-bordered font-mono text-xs" rows="5" value={typeof sn.config.data === 'object' ? JSON.stringify(sn.config.data, null, 2) : (sn.config.data ?? '{}')} oninput={(e) => { const v = (e.target as HTMLTextAreaElement).value; try { updateNodeConfig(sn.id, 'data', JSON.parse(v)); } catch { updateNodeConfig(sn.id, 'data', v); } }}></textarea>
                </div>
              </div>

            {:else if sn.type === 'delay'}
              <div class="grid grid-cols-2 gap-2">
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Hours</span></label>
                  <input type="number" min="0" class="input input-sm input-bordered" value={sn.config.hours ?? 0} oninput={(e) => updateNodeConfig(sn.id, 'hours', Number((e.target as HTMLInputElement).value))} />
                </div>
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Minutes</span></label>
                  <input type="number" min="0" max="59" class="input input-sm input-bordered" value={sn.config.minutes ?? 0} oninput={(e) => updateNodeConfig(sn.id, 'minutes', Number((e.target as HTMLInputElement).value))} />
                </div>
              </div>

            {:else if sn.type === 'ai_completion' || sn.type === 'ai_decision'}
              <div class="space-y-2">
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">System Prompt</span></label>
                  <textarea class="textarea textarea-sm textarea-bordered text-xs" rows="3" value={sn.config.system ?? ''} oninput={(e) => updateNodeConfig(sn.id, 'system', (e.target as HTMLTextAreaElement).value)}></textarea>
                </div>
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Prompt</span></label>
                  <textarea class="textarea textarea-sm textarea-bordered text-xs" rows="4" value={sn.config.prompt ?? ''} oninput={(e) => updateNodeConfig(sn.id, 'prompt', (e.target as HTMLTextAreaElement).value)}></textarea>
                </div>
              </div>

            {:else if sn.type === 'trigger'}
              <div class="text-xs text-base-content/50 py-2">
                Trigger: <strong>{sn.config?.type ?? flow.trigger?.type}</strong>
                {#if flow.trigger?.collection}
                  <br/>Collection: <strong>{flow.trigger.collection}</strong>
                  <br/>Event: <strong>{flow.trigger.event}</strong>
                {/if}
              </div>
            {/if}

            <!-- Connected edges -->
            {@const nodeEdges = edgesForNode(sn.id)}
            {#if nodeEdges.length > 0}
              <div class="divider my-2 text-xs">Connections</div>
              <div class="space-y-1">
                {#each nodeEdges as edge}
                  {@const other = nodes.find(n => n.id === (edge.sourceId === sn.id ? edge.targetId : edge.sourceId))}
                  <div class="flex items-center justify-between text-xs bg-base-200 rounded px-2 py-1">
                    <div class="flex items-center gap-1.5">
                      <Link size={10} class="text-base-content/40" />
                      <span class="text-base-content/60">
                        {edge.sourceId === sn.id ? '→' : '←'}
                        {other?.label ?? other?.type ?? edge.targetId}
                      </span>
                      {#if edge.sourcePort !== 'output'}
                        <span class="badge badge-xs" style="background:{edge.sourcePort === 'true' ? '#10b981' : '#ef4444'}; color:white;">{edge.sourcePort}</span>
                      {/if}
                    </div>
                    <button class="btn btn-ghost btn-xs text-error p-0 h-auto min-h-0" onclick={() => removeEdge(edge.id)}>
                      <Trash2 size={10} />
                    </button>
                  </div>
                {/each}
              </div>
            {/if}

          {:else}
            <div class="text-center py-12 text-base-content/40">
              <div class="text-4xl mb-2">✦</div>
              <p class="text-sm">Click a node to configure it</p>
              <p class="text-xs mt-1 opacity-70">Double-click canvas to add a node</p>
            </div>
          {/if}
        </div>

        <!-- Run history -->
        <div class="border-t border-base-300 p-4 flex-shrink-0">
          <div class="flex items-center justify-between mb-2">
            <h3 class="font-semibold text-sm">Recent Runs</h3>
            <button class="btn btn-ghost btn-xs" onclick={loadRuns}>↻</button>
          </div>
          {#if runs.length === 0}
            <p class="text-xs text-base-content/40">No runs yet</p>
          {:else}
            <div class="space-y-1 max-h-40 overflow-y-auto">
              {#each runs.slice(0, 8) as run}
                <div class="flex items-center gap-2 text-xs">
                  <span class="{statusClass(run.status)} font-mono">{statusIcon(run.status)}</span>
                  <span class="text-base-content/60 flex-1">{new Date(run.created_at).toLocaleTimeString()}</span>
                  {#if run.error}
                    <span class="text-error truncate max-w-28" title={run.error}>{run.error}</span>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>

  <!-- ── Node Picker Dropdown ─────────────────────────────────────────────── -->
  {#if showNodePicker}
    <div
      class="fixed z-50 card bg-base-100 shadow-2xl border border-base-300 w-72"
      style="left: {Math.min(nodePickerScreen.x, window.innerWidth - 300)}px; top: {Math.min(nodePickerScreen.y + 8, window.innerHeight - 380)}px;"
    >
      <div class="card-body p-3">
        <div class="flex items-center justify-between mb-2">
          <h3 class="font-bold text-sm">Add Node</h3>
          <button class="btn btn-ghost btn-xs" onclick={() => (showNodePicker = false)}>✕</button>
        </div>
        <div class="space-y-1">
          {#each STEP_TYPES as st}
            <button
              class="btn btn-ghost justify-start gap-3 w-full h-auto py-2 hover:bg-base-200"
              onclick={() => addNode(st)}
            >
              <div class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0" style="background: {nodeColor(st.type)};">
                {st.icon}
              </div>
              <div class="text-left">
                <div class="font-medium text-sm">{st.label}</div>
                <div class="text-xs text-base-content/50">{st.description}</div>
              </div>
            </button>
          {/each}
        </div>
      </div>
    </div>
    <!-- Click-away backdrop -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="fixed inset-0 z-40"
      onmousedown={() => (showNodePicker = false)}
    ></div>
  {/if}
{/if}
