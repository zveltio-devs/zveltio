import { createInterface } from 'readline';

/**
 * `zveltio mcp` — the engine as an MCP tool surface over stdio (ADR 0027, E0).
 *
 * An agent is just a user: every tool is one HTTP call to the data API or to an
 * extension action, made with the member API key in ZVELTIO_API_KEY, so the
 * engine's rules decide each call exactly as they would for the key's owner.
 * Nothing here grants, filters or refuses on its own beyond input shape. There
 * is no schema, DDL or SQL tool, by decision; a step-up action is refused by the
 * engine, which gives a key no step-up window.
 *
 * The protocol is JSON-RPC 2.0, one message per line. Only stdout carries it;
 * anything for a person goes to stderr.
 */

/**
 * The protocol revisions this server speaks; the newest is offered when the
 * client asks for another. Not 2025-03-26: it allows JSON-RPC batches, which
 * this server does not take.
 */
const PROTOCOL_VERSIONS = ['2025-06-18', '2024-11-05'];
/** Per engine call; a hung engine must not hold the stdio loop forever. */
const CALL_TIMEOUT_MS = 120_000;

type Json = Record<string, unknown>;
type Call = (method: string, path: string, body?: unknown) => Promise<Response>;

// Names go into a URL path: anything outside these shapes is refused before a
// request is built, so `../admin` never reaches the engine as a path.
const IDENT = /^[a-z_][a-z0-9_]*$/i;
const EXTENSION = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;
const ACTION = /^[a-z][a-zA-Z0-9]*$/;

const collection = {
  type: 'string',
  description: 'Collection name, from list_collections',
};
const id = { type: 'string', description: 'Record id' };
const data = {
  type: 'object',
  description: 'Field values',
  additionalProperties: true,
};

const TOOLS = [
  {
    name: 'list_collections',
    description:
      'The collections you may read, with the fields you may see (name, type, required, readonly). Call this first.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_records',
    description:
      'Records of a collection, a page at a time. filter is an object such as {"price":{"gt":50},"status":{"eq":"open"}}; operators: eq neq lt lte gt gte contains not_contains starts_with ends_with in not_in is_null not_null.',
    inputSchema: {
      type: 'object',
      properties: {
        collection,
        filter: { type: 'object', additionalProperties: true },
        search: { type: 'string', description: 'Full-text search' },
        sort: { type: 'string', description: 'Field to sort by' },
        order: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        page: { type: 'integer', minimum: 1 },
        expand: {
          type: 'string',
          description: 'Comma-separated relation fields to expand',
        },
      },
      required: ['collection'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_record',
    description: 'One record by id.',
    inputSchema: {
      type: 'object',
      properties: { collection, id },
      required: ['collection', 'id'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_record',
    description: 'Create a record.',
    inputSchema: {
      type: 'object',
      properties: { collection, data },
      required: ['collection', 'data'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'update_record',
    description: 'Change the given fields of a record.',
    inputSchema: {
      type: 'object',
      properties: { collection, id, data },
      required: ['collection', 'id', 'data'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
  },
  {
    name: 'delete_record',
    description: 'Delete a record.',
    inputSchema: {
      type: 'object',
      properties: { collection, id },
      required: ['collection', 'id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'run_action',
    description:
      "Run an extension action (POST /ext/<extension>/actions/<action>). The engine checks the input against the action's schema and answers what is wrong with it.",
    inputSchema: {
      type: 'object',
      properties: {
        extension: {
          type: 'string',
          description: 'Extension name, e.g. "crm" or "finance/invoicing"',
        },
        action: { type: 'string', description: 'Action name' },
        input: { type: 'object', additionalProperties: true },
      },
      required: ['extension', 'action'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
];

class BadInput extends Error {}
class UnknownTool extends Error {}

function str(args: Json, key: string, shape?: RegExp): string {
  const v = args[key];
  if (typeof v !== 'string' || v === '') throw new BadInput(`"${key}" must be a non-empty string`);
  if (shape && !shape.test(v)) throw new BadInput(`"${key}" is not a valid name: ${v}`);
  // `encodeURIComponent` keeps dot segments, and fetch resolves them.
  if (v === '.' || v === '..') throw new BadInput(`"${key}" is not a valid value: ${v}`);
  return v;
}

function obj(args: Json, key: string, optional = false): Json | undefined {
  const v = args[key];
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new BadInput(`"${key}" must be an object`);
  return v as Json;
}

function listPath(args: Json): string {
  const q = new URLSearchParams();
  const filter = obj(args, 'filter', true);
  if (filter) q.set('filter', JSON.stringify(filter));
  for (const k of ['search', 'sort', 'order', 'expand', 'limit', 'page']) {
    const v = args[k];
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const qs = q.toString();
  return `/api/data/${str(args, 'collection', IDENT)}${qs ? `?${qs}` : ''}`;
}

const record = (args: Json) =>
  `/api/data/${str(args, 'collection', IDENT)}/${encodeURIComponent(str(args, 'id'))}`;

async function runTool(name: string, args: Json, call: Call): Promise<Response> {
  switch (name) {
    case 'list_collections':
      return call('GET', '/api/data');
    case 'list_records':
      return call('GET', listPath(args));
    case 'get_record':
      return call('GET', record(args));
    case 'create_record':
      return call('POST', `/api/data/${str(args, 'collection', IDENT)}`, obj(args, 'data'));
    case 'update_record':
      return call('PATCH', record(args), obj(args, 'data'));
    case 'delete_record':
      return call('DELETE', record(args));
    case 'run_action':
      return call(
        'POST',
        `/ext/${str(args, 'extension', EXTENSION)}/actions/${str(args, 'action', ACTION)}`,
        obj(args, 'input', true) ?? {},
      );
    default:
      throw new UnknownTool(`Unknown tool: ${name}`);
  }
}

const text = (t: string, isError = false) => ({
  content: [{ type: 'text', text: t }],
  isError,
});

/**
 * One JSON-RPC message in, its answer out (null for a notification). A refusal by
 * the engine is a tool result with `isError`, so the agent reads the engine's
 * reason; only a malformed request is a protocol error.
 */
export async function handleMessage(msg: Json, call: Call): Promise<Json | null> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code: number, message: string) => ({
    jsonrpc: '2.0',
    id: msg.id ?? null,
    error: { code, message },
  });
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg))
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string')
    return fail(-32600, 'Invalid request');
  if (msg.id === undefined) return null; // notifications/initialized, cancelled, …
  const params = (msg.params ?? {}) as Json;
  switch (msg.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return reply({
        protocolVersion:
          typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked)
            ? asked
            : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'zveltio', version: '1' },
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const args = (params.arguments ?? {}) as Json;
      try {
        const res = await runTool(String(params.name), args, call);
        const body = await res.text();
        return reply(text(res.ok ? body : `HTTP ${res.status}: ${body}`, !res.ok));
      } catch (err) {
        if (err instanceof UnknownTool) return fail(-32602, err.message);
        if (err instanceof BadInput) return reply(text(err.message, true));
        return reply(text(`Engine unreachable: ${(err as Error).message}`, true));
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export async function mcpCommand(opts: { url?: string }) {
  const engineUrl = (opts.url || process.env.ZVELTIO_URL || 'http://localhost:3000').replace(
    /\/+$/,
    '',
  );
  const key = process.env.ZVELTIO_API_KEY;
  if (!key) {
    console.error('Set ZVELTIO_API_KEY to a member API key; the agent acts as its owner.');
    process.exit(1);
  }
  const call: Call = (method, path, body) =>
    fetch(engineUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });

  const write = (m: Json) => process.stdout.write(`${JSON.stringify(m)}\n`);
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      write({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      continue;
    }
    // ponytail: one request at a time, so a cancel or ping waits behind a slow
    // action; dispatch concurrently if clients need to interrupt.
    const out = await handleMessage(msg, call).catch((err) => ({
      jsonrpc: '2.0',
      id: msg?.id ?? null,
      error: { code: -32603, message: `Internal error: ${(err as Error).message}` },
    }));
    if (out) write(out);
  }
}
