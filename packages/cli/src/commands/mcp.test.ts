import { describe, expect, test } from 'bun:test';
import { handleMessage } from './mcp.js';

type Sent = { method: string; path: string; body?: unknown };

function fake(status = 200, answer = '{"ok":true}') {
  const sent: Sent[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    sent.push({ method, path, body });
    return new Response(answer, { status });
  };
  return { sent, call };
}

const callTool = (name: string, args: unknown, call: ReturnType<typeof fake>['call']) =>
  handleMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    call,
  ) as Promise<{ result: { content: { text: string }[]; isError: boolean } }>;

describe('zveltio mcp', () => {
  test('initialize echoes a known protocol version, offers the newest otherwise', async () => {
    const { call } = fake();
    const known = (await handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
      },
      call,
    )) as { result: { protocolVersion: string } };
    expect(known.result.protocolVersion).toBe('2024-11-05');
    const other = (await handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '1999-01-01' },
      },
      call,
    )) as { result: { protocolVersion: string } };
    expect(other.result.protocolVersion).toBe('2025-06-18');
  });

  test('a notification gets no answer; an unknown method is -32601', async () => {
    const { call } = fake();
    expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, call)).toBe(
      null,
    );
    const r = (await handleMessage({ jsonrpc: '2.0', id: 2, method: 'nope' }, call)) as {
      error: { code: number };
    };
    expect(r.error.code).toBe(-32601);
  });

  test('no tool reaches schema, DDL or SQL', async () => {
    const { call } = fake();
    const r = (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, call)) as {
      result: { tools: { name: string }[] };
    };
    const names = r.result.tools.map((t) => t.name);
    expect(names).toEqual([
      'list_collections',
      'list_records',
      'get_record',
      'create_record',
      'update_record',
      'delete_record',
      'run_action',
    ]);
  });

  test('each action the engine lists is a typed tool; calling it runs the action', async () => {
    const input = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
    const listed = JSON.stringify({
      actions: [
        { extension: 'finance/invoicing', name: 'issue', input },
        { extension: 'crm', name: 'ping', input: {} },
        // Would share a name with finance/invoicing: neither gets it.
        { extension: 'finance_invoicing', name: 'issue', input },
        // Not an object input, not a usable name, not a path: left to run_action.
        { extension: 'crm', name: 'count', input: { type: 'number' } },
        { extension: '../admin', name: 'x', input: {} },
        { extension: 'crm', name: 'Bad', input: {} },
      ],
    });
    const sent: Sent[] = [];
    const call = async (method: string, path: string, body?: unknown) => {
      sent.push({ method, path, body });
      return new Response(path === '/api/actions' ? listed : '{"result":1}');
    };
    const r = (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, call)) as {
      result: { tools: { name: string; inputSchema: unknown }[] };
    };
    const typed = r.result.tools.slice(7);
    expect(typed).toEqual([
      expect.objectContaining({ name: 'crm__ping', inputSchema: { type: 'object' } }),
    ]);
    const fi = JSON.stringify({
      actions: [{ extension: 'finance/invoicing', name: 'issue', input }],
    });
    const one = async (method: string, path: string, body?: unknown) => {
      sent.push({ method, path, body });
      return new Response(path === '/api/actions' ? fi : '{"result":1}');
    };
    const l = (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, one)) as {
      result: { tools: { name: string; inputSchema: unknown }[] };
    };
    expect(l.result.tools[7]).toEqual(
      expect.objectContaining({ name: 'finance_invoicing__issue', inputSchema: input }),
    );
    sent.length = 0;
    const res = await callTool('finance_invoicing__issue', { id: 'i1' }, one);
    expect(res.result.isError).toBe(false);
    expect(sent.at(-1)).toEqual({
      method: 'POST',
      path: '/ext/finance/invoicing/actions/issue',
      body: { id: 'i1' },
    });
  });

  test('an engine without GET /api/actions keeps the fixed tools', async () => {
    for (const call of [
      fake(404, '{"error":"Not found"}').call,
      async () => {
        throw new Error('ECONNREFUSED');
      },
    ]) {
      const r = (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, call)) as {
        result: { tools: unknown[] };
      };
      expect(r.result.tools).toHaveLength(7);
    }
  });

  test('each tool is one data-API or action call', async () => {
    const f = fake();
    await callTool('list_collections', {}, f.call);
    await callTool(
      'list_records',
      { collection: 'deals', filter: { amount: { gt: 5 } }, limit: 10 },
      f.call,
    );
    await callTool('get_record', { collection: 'deals', id: 'a/b' }, f.call);
    await callTool('create_record', { collection: 'deals', data: { x: 1 } }, f.call);
    await callTool('update_record', { collection: 'deals', id: '7', data: { x: 2 } }, f.call);
    await callTool('delete_record', { collection: 'deals', id: '7' }, f.call);
    await callTool('run_action', { extension: 'finance/invoicing', action: 'issue' }, f.call);
    expect(f.sent).toEqual([
      { method: 'GET', path: '/api/data', body: undefined },
      {
        method: 'GET',
        path: `/api/data/deals?filter=${encodeURIComponent('{"amount":{"gt":5}}')}&limit=10`,
        body: undefined,
      },
      { method: 'GET', path: '/api/data/deals/a%2Fb', body: undefined },
      { method: 'POST', path: '/api/data/deals', body: { x: 1 } },
      { method: 'PATCH', path: '/api/data/deals/7', body: { x: 2 } },
      { method: 'DELETE', path: '/api/data/deals/7', body: undefined },
      {
        method: 'POST',
        path: '/ext/finance/invoicing/actions/issue',
        body: {},
      },
    ]);
  });

  test('a name shaped like a path is refused before any request', async () => {
    const f = fake();
    for (const [tool, args] of [
      ['list_records', { collection: '../admin' }],
      ['create_record', { collection: 'deals', data: [1] }],
      ['run_action', { extension: '../../api/admin', action: 'x' }],
      ['run_action', { extension: 'crm', action: '../x' }],
      ['get_record', { collection: 'deals', id: '..' }],
    ] as const) {
      const r = await callTool(tool, args, f.call);
      expect(r.result.isError).toBe(true);
    }
    expect(f.sent).toEqual([]);
  });

  test('an unknown tool is -32602; a non-object message is -32600', async () => {
    const { call, sent } = fake();
    const r = (await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'drop_table' } },
      call,
    )) as { error: { code: number } };
    expect(r.error.code).toBe(-32602);
    for (const m of [null, [], 5]) {
      const bad = (await handleMessage(m as never, call)) as { error: { code: number } };
      expect(bad.error.code).toBe(-32600);
    }
    expect(sent).toEqual([]);
  });

  test("the engine's refusal reaches the agent as a tool error with its reason", async () => {
    const f = fake(403, '{"error":"Forbidden","code":"permission_required"}');
    const r = await callTool('get_record', { collection: 'payroll', id: '1' }, f.call);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain('HTTP 403');
    expect(r.result.content[0].text).toContain('permission_required');
  });
});
