/**
 * Zveltio AI Engine
 *
 * Adapted for new monorepo architecture:
 * - `db` injected via constructor (no module-level singleton)
 * - Uses extension-local aiProviderManager from ../ai-provider.js
 * - DDLManager calls replaced with direct DB queries on zv_collections
 * - DDL mutations go through zv_ddl_jobs queue table
 * - Admin check via casbin_rule table
 */

import { sql } from 'kysely';
import { aiProviderManager } from '../ai-provider.js';
import { zveltioAITools } from './tools.js';
import type {
  ZveltioAIRequest,
  ZveltioAIResponse,
  ZveltioAIAction,
  ZveltioAIContext,
  ZveltioAIToolCall,
} from './types.js';
import { checkPermission } from '../../../../../packages/engine/src/lib/permissions.js';
import { sendNotification } from '../../../../../packages/engine/src/lib/notifications.js';

// Minimal nanoid implementation for edge environments
function nanoid(size = 21): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  const randomValues = new Uint8Array(size);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < size; i++) {
    id += chars[randomValues[i] % chars.length];
  }
  return id;
}

export class ZveltioAIEngine {
  constructor(private db: any) {}

  // ── Public API ─────────────────────────────────────────────────

  async processRequest(request: ZveltioAIRequest): Promise<ZveltioAIResponse> {
    const startTime = Date.now();

    try {
      const context = await this.buildContext(request);
      const history = request.conversationId
        ? await this.getConversationHistory(request.conversationId)
        : [];

      const provider = aiProviderManager.getDefault();

      if (!provider) {
        return {
          response:
            '⚠️ No AI provider configured. Please configure one in **AI Settings**.\n\n' +
            'Options:\n' +
            '- **Ollama (FREE)** — self-hosted, runs locally\n' +
            '- **OpenAI** — GPT-4o-mini / GPT-4o (requires API key)\n' +
            '- **Anthropic** — Claude (requires API key)',
          conversationId:
            request.conversationId || this.generateConversationId(),
          metadata: { latency: Date.now() - startTime },
        };
      }

      const systemPrompt = this.buildSystemPrompt(context);

      // Build conversation messages array
      let conversationMessages: Array<{
        role: 'system' | 'user' | 'assistant' | 'tool';
        content: any;
        tool_call_id?: string;
      }> = [
        { role: 'system', content: systemPrompt },
        ...history.map((h: any) => ({
          role: h.role as 'user' | 'assistant',
          content: h.content,
        })),
        { role: 'user', content: request.message },
      ];

      const aiResponse = await provider.chat(
        conversationMessages.map((m) => ({
          role: m.role as 'system' | 'user' | 'assistant' | 'tool',
          content: m.content,
          tool_call_id: m.tool_call_id,
        })),
        {
          temperature: 0.7,
          max_tokens: 4096,
          tools: zveltioAITools,
          tool_choice: 'auto',
        },
      );

      const actions: ZveltioAIAction[] = [];

      // ── Agentic ReAct Loop ─────────────────────────────────────────
      const MAX_ITERATIONS = request.context?.maxIterations ?? 7;
      let iteration = 0;
      let currentResponse = aiResponse;
      let finalResponse = aiResponse.content;
      let totalTokens = aiResponse.usage.prompt_tokens + aiResponse.usage.response_tokens;

      // Add first assistant response to conversation
      if (currentResponse.tool_calls && currentResponse.tool_calls.length > 0) {
        conversationMessages.push({
          role: 'assistant',
          content: currentResponse.content || '',
        } as any);
      }

      while (iteration < MAX_ITERATIONS) {
        const toolCalls = currentResponse.tool_calls;

        // Stop condition: AI responded with text only, no tool calls
        if (!toolCalls || toolCalls.length === 0) {
          finalResponse = currentResponse.content;
          break;
        }

        iteration++;

        // Execute all tool calls in this iteration
        const toolResults: Array<{ tool_call_id: string; name: string; result: any; success: boolean }> = [];

        for (const toolCall of toolCalls) {
          const args = typeof toolCall.function.arguments === 'string'
            ? JSON.parse(toolCall.function.arguments)
            : toolCall.function.arguments;

          try {
            const result = await this.executeToolCall(
              { id: toolCall.id, type: 'function', function: { name: toolCall.function.name, arguments: args } },
              request,
            );
            toolResults.push({ tool_call_id: toolCall.id, name: toolCall.function.name, result, success: true });
            actions.push({ type: toolCall.function.name, result, success: true });
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            toolResults.push({ tool_call_id: toolCall.id, name: toolCall.function.name, result: { error: msg }, success: false });
            actions.push({ type: toolCall.function.name, result: null, success: false, error: msg });
          }
        }

        // Build tool result messages in the correct provider-specific format
        const toolResultMessages = this.buildToolResultMessages(provider.name, toolCalls, toolResults);
        conversationMessages.push(...toolResultMessages as any);

        // Next loop call — with tools active to allow multi-step reasoning
        const nextResponse = await provider.chat(
          conversationMessages.map((m) => ({
            role: m.role as 'system' | 'user' | 'assistant' | 'tool',
            content: m.content,
            tool_call_id: m.tool_call_id,
          })),
          {
            temperature: 0.7,
            max_tokens: 4096,
            tools: zveltioAITools,
            tool_choice: 'auto',
          },
        );

        totalTokens += nextResponse.usage.prompt_tokens + nextResponse.usage.response_tokens;

        // If AI wants more tool calls, add assistant response to conversation
        if (nextResponse.tool_calls && nextResponse.tool_calls.length > 0) {
          conversationMessages.push({
            role: 'assistant',
            content: nextResponse.content || '',
          } as any);
        }

        currentResponse = nextResponse;
        finalResponse = nextResponse.content;
      }

      // Safety: if we hit maxIterations without a text response, force a final answer
      if (iteration >= MAX_ITERATIONS && !finalResponse) {
        const forceResponse = await provider.chat(
          conversationMessages.map((m) => ({
            role: m.role as 'system' | 'user' | 'assistant' | 'tool',
            content: m.content,
            tool_call_id: m.tool_call_id,
          })),
          {
            temperature: 0.7,
            max_tokens: 2048,
            // No tools — force text response
          },
        );
        finalResponse = forceResponse.content;
        totalTokens += forceResponse.usage.prompt_tokens + forceResponse.usage.response_tokens;
      }

      // Save conversation (skip for background tasks)
      const conversationId =
        request.conversationId || this.generateConversationId();
      if (request.conversationId !== null) {
        await this.saveConversation(
          conversationId,
          request.userId,
          request.message,
          finalResponse,
        );
      }

      return {
        response: finalResponse,
        actions: actions.length > 0 ? actions : undefined,
        conversationId,
        metadata: {
          tokensUsed: totalTokens,
          iterations: iteration,
          provider: provider.name,
          model: aiResponse.model,
          latency: Date.now() - startTime,
        },
      };
    } catch (error) {
      console.error('ZveltioAIEngine error:', error);
      throw error;
    }
  }

  /**
   * Executes an AI task in the background, without direct user input.
   *
   * Called by flowScheduler when trigger_type = 'ai_task'.
   */
  async processBackgroundTask(
    userId: string,
    instruction: string,
    options: {
      notifyOnResult?: boolean;
      notifyOnlyIfData?: boolean;
      notificationTitle?: string;
      maxIterations?: number;
      organizationId?: string;
    } = {},
  ): Promise<{
    executed: boolean;
    response: string;
    notificationsSent: number;
    tokensUsed: number;
    iterations: number;
    error?: string;
  }> {
    const startTime = Date.now();

    try {
      const result = await this.processRequest({
        userId,
        organizationId: options.organizationId,
        message: `[BACKGROUND TASK — no user interaction] ${instruction}`,
        conversationId: null as any,
        context: {
          isBackground: true,
          maxIterations: options.maxIterations ?? 5,
        },
      });

      let notificationsSent = 0;

      const shouldNotify = options.notifyOnResult || (
        options.notifyOnlyIfData &&
        result.actions &&
        result.actions.length > 0 &&
        result.actions.some(a => a.success && (a.result as any)?.count > 0)
      );

      if (shouldNotify && result.response) {
        const notifTitle = options.notificationTitle ?? 'AI Background Report';
        const notifMessage = result.response.length > 500
          ? result.response.substring(0, 497) + '...'
          : result.response;

        await sendNotification(this.db, {
          user_id: userId,
          title: notifTitle,
          message: notifMessage,
          type: 'info',
          source: 'ai-background',
          metadata: {
            instruction: instruction.substring(0, 200),
            latency_ms: Date.now() - startTime,
            iterations: result.metadata?.iterations ?? 0,
          },
        });

        notificationsSent = 1;
      }

      return {
        executed: true,
        response: result.response,
        notificationsSent,
        tokensUsed: result.metadata?.tokensUsed ?? 0,
        iterations: result.metadata?.iterations ?? 0,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[ZveltioAI Background] Task failed for user ${userId}:`, errorMessage);

      if (options.notifyOnResult) {
        await sendNotification(this.db, {
          user_id: userId,
          title: 'AI Background Task Failed',
          message: `Task "${instruction.substring(0, 100)}" failed: ${errorMessage}`,
          type: 'error',
          source: 'ai-background',
        }).catch(() => {});
      }

      return {
        executed: false,
        response: '',
        notificationsSent: 0,
        tokensUsed: 0,
        iterations: 0,
        error: errorMessage,
      };
    }
  }

  // ── Context ────────────────────────────────────────────────────

  private async buildContext(
    request: ZveltioAIRequest,
  ): Promise<ZveltioAIContext> {
    // Collection count only — AI uses list_collections for details
    let collectionCount = 0;
    try {
      const result = await this.db
        .selectFrom('zv_collections')
        .select(this.db.fn.count('name').as('cnt'))
        .executeTakeFirst() as any;
      collectionCount = parseInt(result?.cnt ?? '0');
    } catch { /* non-fatal */ }

    // User memory — top 10 by importance
    let userMemory: Array<{ context_key: string; content: string; importance: number }> = [];
    try {
      const rawMemory = await (this.db as any)
        .selectFrom('zv_ai_memory')
        .select(['context_key', 'content', 'importance'])
        .where('user_id', '=', request.userId)
        .orderBy('importance', 'desc')
        .orderBy('updated_at', 'desc')
        .limit(5)
        .execute();

      userMemory = rawMemory.map((r: any) => ({
        context_key: r.context_key,
        content: r.content.length > 300 ? r.content.substring(0, 300) + '…' : r.content,
        importance: r.importance,
      }));
    } catch { /* table may not exist yet */ }

    let recentActivity: any[] = [];
    try {
      recentActivity = await this.db
        .selectFrom('zv_audit_logs')
        .select(['action', 'collection', 'created_at'])
        .where('user_id', '=', request.userId)
        .orderBy('created_at', 'desc')
        .limit(10)
        .execute();
    } catch {
      /* audit log may not exist */
    }

    return {
      userId: request.userId,
      organizationId: request.organizationId,
      collections: [],           // intentionally empty — AI uses list_collections
      collectionCount,
      permissions: [],
      recentActivity,
      userMemory,
    };
  }

  // ── System prompt ──────────────────────────────────────────────

  private buildSystemPrompt(context: ZveltioAIContext): string {
    const memorySection = context.userMemory && context.userMemory.length > 0
      ? `\n## Your Memory About This User\nThe following facts were saved from previous conversations:\n${
          context.userMemory
            .map(m => `- **${m.context_key}**: ${m.content}`)
            .join('\n')
        }\nApply these preferences and rules automatically without asking the user to repeat them.\n`
      : '';

    return `You are Zveltio AI — an autonomous, intelligent assistant embedded in Zveltio, a Business OS platform.

## Your Role
You help users work with their data, automate tasks, generate reports, and manage their platform.
You operate as a proactive agent: you gather information, reason step by step, and execute actions.
${memorySection}
## Data Access
The platform has ${context.collectionCount ?? 'several'} collections (database tables).
- Use **list_collections** to discover available tables before any data operation.
- Use **get_collection_schema** to understand a table's structure before querying or modifying it.
- NEVER assume collection names or field names — always verify first with the tools above.

## Available Tools
1. **list_collections** — Discover all available tables (use this first)
2. **get_collection_schema** — Get fields/structure of a specific table
3. **query_data** — Read records with filters and sorting
4. **count_records** — Count records matching filters
5. **create_record** — Insert a new record
6. **update_record** — Modify an existing record
7. **delete_record** — Remove a record (confirm with user first)
8. **create_collection** — Create a new table (admin only)
9. **add_field** — Add a field to existing table (admin only)
10. **execute_sql** — Run a SELECT SQL query (admin only)
11. **generate_report** — Export data as PDF/Excel/CSV
12. **create_visualization** — Create chart or dashboard
13. **remember_fact** — Save important facts/preferences to long-term memory
14. **recall_facts** — Retrieve previously saved facts

## Behavioral Rules
- **Always use tools** when the user asks about data — never say "I can't access" without trying
- **Chain tools logically**: list_collections → get_schema → query → respond
- **Respect permissions**: if a tool returns permission_denied, explain the limitation clearly
- **Be concise**: show key results, not raw JSON dumps
- **Confirm before destructive actions**: ask before delete_record or DROP operations
- **Remember context**: use recall_facts at the start of conversations about preferences
- **Format responses** with Markdown: tables for data, code blocks for SQL/JSON`;
  }

  // ── Tool result message builder ────────────────────────────────

  /**
   * Builds tool_result messages in the correct format per provider.
   *
   * OpenAI / Ollama: role='tool' with tool_call_id (standard OpenAI format)
   * Anthropic: role='user' with content array of tool_result blocks
   *   (Anthropic does NOT accept role='tool'; tool results are sent as user
   *    messages with tool_result content blocks, each referencing a tool_use_id)
   */
  private buildToolResultMessages(
    providerName: string,
    _toolCalls: Array<{ id: string; function: { name: string } }>,
    toolResults: Array<{ tool_call_id: string; name: string; result: any; success: boolean }>,
  ): Array<{ role: 'user' | 'tool' | 'assistant'; content: any; tool_call_id?: string }> {
    if (providerName === 'anthropic') {
      // Anthropic: single user message with array of tool_result blocks
      return [{
        role: 'user',
        content: toolResults.map(tr => ({
          type: 'tool_result',
          tool_use_id: tr.tool_call_id,
          content: JSON.stringify(tr.result),
          is_error: !tr.success,
        })),
      }];
    }

    // OpenAI / Ollama: one role='tool' message per tool call
    return toolResults.map(tr => ({
      role: 'tool' as const,
      content: JSON.stringify(tr.result),
      tool_call_id: tr.tool_call_id,
    }));
  }

  // ── Tool dispatcher ────────────────────────────────────────────

  private async executeToolCall(
    toolCall: ZveltioAIToolCall,
    request: ZveltioAIRequest,
  ): Promise<any> {
    const { name, arguments: args } = toolCall.function;
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;

    // ── Tool access classification ─────────────────────────────
    const ADMIN_ONLY_TOOLS = [
      'execute_sql',
      'text_to_sql',
      'create_collection',
      'add_field',
      'get_system_stats',
    ];

    const DATA_TOOLS_PERMISSIONS: Record<string, string> = {
      query_data:    'read',
      count_records: 'read',
      create_record: 'create',
      update_record: 'update',
      delete_record: 'delete',
    };

    // ── Admin check for system tools ───────────────────────────
    if (ADMIN_ONLY_TOOLS.includes(name)) {
      const isAdmin = await checkPermission(request.userId, 'admin', '*');
      if (!isAdmin) {
        return {
          error: `User does not have permission to perform administrative operations. ` +
                 `The tool '${name}' requires admin access.`,
          permission_denied: true,
        };
      }
    }

    // ── Granular permission check for data tools ───────────────
    if (name in DATA_TOOLS_PERMISSIONS) {
      const action = DATA_TOOLS_PERMISSIONS[name];
      const collection = parsed?.collection;

      if (!collection) {
        return { error: `Tool '${name}' requires a 'collection' parameter.` };
      }

      const hasPermission = await checkPermission(request.userId, action, collection);
      if (!hasPermission) {
        return {
          error: `User does not have permission to ${action} data in collection '${collection}'. ` +
                 `Please ask an administrator to grant you the necessary access.`,
          permission_denied: true,
          required_permission: { action, resource: collection },
        };
      }
    }

    // ── Dispatch ───────────────────────────────────────────────
    switch (name) {
      case 'query_data':           return this.toolQueryData(parsed, request);
      case 'create_collection':    return this.toolCreateCollection(parsed);
      case 'add_field':            return this.toolAddField(parsed);
      case 'generate_report':      return this.toolGenerateReport(parsed, request);
      case 'create_visualization': return this.toolCreateVisualization(parsed);
      case 'execute_sql':          return this.toolExecuteSQL(parsed);
      case 'list_collections':     return this.toolListCollections();
      case 'get_collection_schema': return this.toolGetCollectionSchema(parsed);
      case 'create_record':        return this.toolCreateRecord(parsed, request);
      case 'update_record':        return this.toolUpdateRecord(parsed, request);
      case 'delete_record':        return this.toolDeleteRecord(parsed);
      case 'count_records':        return this.toolCountRecords(parsed);
      case 'get_system_stats':     return this.toolGetSystemStats();
      case 'remember_fact':        return this.toolRememberFact(parsed, request);
      case 'recall_facts':         return this.toolRecallFacts(parsed, request);
      case 'text_to_sql':          return this.toolTextToSQL(parsed, request);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // ── Tool implementations ───────────────────────────────────────

  private async toolQueryData(args: any, _request: ZveltioAIRequest) {
    const {
      collection,
      filters = {},
      limit = 10,
      orderBy,
      orderDirection = 'desc',
    } = args;

    const tableName = `zv_${collection}`;

    try {
      let query = this.db.selectFrom(tableName as any).selectAll();

      for (const [key, value] of Object.entries(filters)) {
        if (typeof value === 'string' && value.startsWith('>')) {
          query = query.where(key as any, '>', (value as string).substring(1));
        } else if (typeof value === 'string' && value.startsWith('<')) {
          query = query.where(key as any, '<', (value as string).substring(1));
        } else {
          query = query.where(key as any, '=', value);
        }
      }

      if (orderBy) {
        query = query.orderBy(orderBy as any, orderDirection);
      } else {
        query = query.orderBy('created_at' as any, 'desc');
      }

      const safeLimit = Math.min(Math.max(1, limit), 100);
      const rows = await query.limit(safeLimit).execute();

      return {
        collection,
        count: rows.length,
        data: rows,
        message: `Found ${rows.length} records in ${collection}`,
      };
    } catch (error) {
      throw new Error(
        `Failed to query ${collection}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
    }
  }

  private async toolCreateCollection(args: any) {
    const { name, display_name, fields } = args;

    await this.db
      .insertInto('zv_ddl_jobs' as any)
      .values({
        operation: 'create_collection',
        payload: JSON.stringify({
          name,
          displayName:
            display_name || name.charAt(0).toUpperCase() + name.slice(1),
          fields: fields.map((f: any) => ({
            name: f.name,
            type: f.type || 'text',
            required: f.required || false,
            unique: f.unique || false,
            defaultValue: f.default_value,
            options: f.options,
          })),
        }),
        status: 'pending',
      })
      .execute();

    return {
      success: true,
      collection: name,
      fields: fields.length,
      message: `Collection '${display_name || name}' is being created with ${fields.length} fields`,
    };
  }

  private async toolAddField(args: any) {
    const { collection, field } = args;

    await this.db
      .insertInto('zv_ddl_jobs' as any)
      .values({
        operation: 'add_field',
        payload: JSON.stringify({ collection, field }),
        status: 'pending',
      })
      .execute();

    return {
      success: true,
      collection,
      field: field.name,
      message: `Field '${field.name}' is being added to '${collection}'`,
    };
  }

  private async toolGenerateReport(args: any, request: ZveltioAIRequest) {
    const { collection, format = 'csv', filters } = args;
    const data = await this.toolQueryData(
      { collection, filters, limit: 10000 },
      request,
    );
    const reportId = nanoid(8);
    const downloadUrl = `/api/export/${collection}?format=${format}&report=${reportId}`;

    return {
      success: true,
      format,
      recordCount: data.count,
      downloadUrl,
      message: `Report ready with ${data.count} records. Download: ${downloadUrl}`,
    };
  }

  private async toolCreateVisualization(args: any) {
    const { type, collection, metric, title } = args;
    return {
      success: true,
      type,
      collection,
      metric,
      message: `Visualization '${title || type}' created for ${collection}`,
      viewUrl: `/admin/insights/${collection}`,
    };
  }

  private async toolExecuteSQL(args: any) {
    const { query: sqlQuery } = args;

    const normalized = sqlQuery.trim().toUpperCase();
    if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
      return { success: false, error: 'AI can only execute SELECT queries.' };
    }

    const dangerous = [
      'DROP', 'DELETE', 'UPDATE', 'INSERT', 'ALTER',
      'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE',
    ];
    for (const kw of dangerous) {
      if (normalized.includes(kw)) {
        return { success: false, error: `Query contains disallowed keyword: ${kw}` };
      }
    }

    const result = await sql.raw(sqlQuery).execute(this.db);
    const rows = (result as any).rows || [];
    return {
      success: true,
      rowCount: rows.length,
      data: rows,
      message: `${rows.length} rows returned.`,
    };
  }

  private async toolListCollections() {
    const collections = await this.db
      .selectFrom('zv_collections')
      .select(['name', 'display_name', 'schema'])
      .orderBy('display_name', 'asc')
      .execute()
      .catch(() => []);

    const mapped = collections.map((c: any) => {
      let fieldCount = 0;
      try {
        const schema =
          typeof c.schema === 'string' ? JSON.parse(c.schema) : c.schema;
        fieldCount = schema?.fields?.length ?? 0;
      } catch {
        /* ignore */
      }
      return {
        name: c.name,
        display_name: c.display_name || c.name,
        fields_count: fieldCount,
      };
    });

    return {
      success: true,
      collections: mapped,
      message: `Found ${mapped.length} collections`,
    };
  }

  private async toolGetCollectionSchema(args: any) {
    const { collection } = args;
    const colDef = await this.db
      .selectFrom('zv_collections')
      .selectAll()
      .where('name', '=', collection)
      .executeTakeFirst()
      .catch(() => null);

    if (!colDef) throw new Error(`Collection '${collection}' not found`);

    let fields: any[] = [];
    try {
      const schema =
        typeof colDef.schema === 'string'
          ? JSON.parse(colDef.schema)
          : colDef.schema;
      fields = schema?.fields ?? [];
    } catch {
      /* ignore */
    }

    return {
      success: true,
      collection: colDef.name,
      display_name: colDef.display_name || colDef.name,
      fields,
      message: `Schema for ${collection}: ${fields.length} fields`,
    };
  }

  private async toolCreateRecord(args: any, _request: ZveltioAIRequest) {
    const { collection, data } = args;
    const tableName = `zv_${collection}`;

    const recordData = {
      ...data,
      id: data.id || nanoid(),
      created_at: new Date(),
      updated_at: new Date(),
    };

    try {
      await this.db
        .insertInto(tableName as any)
        .values(recordData)
        .execute();
      return {
        success: true,
        record: recordData,
        message: `Record created in ${collection}`,
      };
    } catch (error) {
      throw new Error(
        `Failed to create record: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
    }
  }

  private async toolUpdateRecord(args: any, _request: ZveltioAIRequest) {
    const { collection, id, data } = args;
    const tableName = `zv_${collection}`;

    try {
      await this.db
        .updateTable(tableName as any)
        .set({ ...data, updated_at: new Date() })
        .where('id' as any, '=', id)
        .execute();
      return {
        success: true,
        id,
        message: `Record ${id} updated in ${collection}`,
      };
    } catch (error) {
      throw new Error(
        `Failed to update record: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
    }
  }

  private async toolDeleteRecord(args: any) {
    const { collection, id } = args;
    const tableName = `zv_${collection}`;

    try {
      await this.db
        .deleteFrom(tableName as any)
        .where('id' as any, '=', id)
        .execute();
      return {
        success: true,
        id,
        message: `Record ${id} deleted from ${collection}`,
      };
    } catch (error) {
      throw new Error(
        `Failed to delete record: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
    }
  }

  private async toolCountRecords(args: any) {
    const { collection, filters = {} } = args;
    const tableName = `zv_${collection}`;

    try {
      let query = this.db
        .selectFrom(tableName as any)
        .select(this.db.fn.count('id').as('count'));
      for (const [key, value] of Object.entries(filters)) {
        query = query.where(key as any, '=', value);
      }
      const result = await query.executeTakeFirst();
      const count = Number(result?.count ?? 0);
      return {
        success: true,
        collection,
        count,
        message: `${count} records in ${collection}`,
      };
    } catch (error) {
      throw new Error(
        `Failed to count records: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
    }
  }

  private async toolGetSystemStats() {
    const [collections, users, recentActivity] = await Promise.all([
      this.db
        .selectFrom('zv_collections')
        .select(this.db.fn.count('name').as('count'))
        .executeTakeFirst()
        .catch(() => ({ count: 0 })),
      this.db
        .selectFrom('zv_users')
        .select(this.db.fn.count('id').as('count'))
        .executeTakeFirst()
        .catch(() => ({ count: 0 })),
      this.db
        .selectFrom('zv_audit_logs')
        .select(this.db.fn.count('id').as('count'))
        .executeTakeFirst()
        .catch(() => ({ count: 0 })),
    ]);

    return {
      success: true,
      stats: {
        collections: Number(collections?.count ?? 0),
        users: Number(users?.count ?? 0),
        recentActivity: Number(recentActivity?.count ?? 0),
      },
      message: `Platform stats: ${collections?.count ?? 0} collections, ${users?.count ?? 0} users`,
    };
  }

  private async toolRememberFact(args: any, request: ZveltioAIRequest): Promise<any> {
    const { context_key, content, importance = 5 } = args;

    // Generate embedding if provider supports embed()
    let embedding: number[] | null = null;
    try {
      const provider = aiProviderManager.getDefault();
      if (provider && 'embed' in provider && typeof (provider as any).embed === 'function') {
        embedding = await (provider as any).embed(content, 'text-embedding-3-small');
      }
    } catch {
      // Embedding is optional — fallback to text search
    }

    await (this.db as any)
      .insertInto('zv_ai_memory')
      .values({
        user_id: request.userId,
        context_key,
        content,
        importance,
        source: 'user',
        ...(embedding ? { embedding: JSON.stringify(embedding) } : {}),
      })
      .onConflict((oc: any) =>
        oc.columns(['user_id', 'context_key']).doUpdateSet({
          content,
          importance,
          updated_at: new Date(),
          ...(embedding ? { embedding: JSON.stringify(embedding) } : {}),
        })
      )
      .execute()
      .catch((err: any) => {
        console.warn('[AI Memory] Table not ready:', err.message);
        throw new Error('Memory service not available. Run migrations first.');
      });

    return {
      success: true,
      context_key,
      message: `I've saved this to memory: "${content.substring(0, 80)}${content.length > 80 ? '...' : ''}"`,
    };
  }

  private async toolRecallFacts(args: any, request: ZveltioAIRequest): Promise<any> {
    const { query, limit = 5 } = args;

    try {
      let rows: any[] = [];

      // Try vector search if embeddings are available
      try {
        const provider = aiProviderManager.getDefault();
        if (provider && 'embed' in provider && typeof (provider as any).embed === 'function') {
          const queryEmbedding = await (provider as any).embed(query, 'text-embedding-3-small');

          rows = await (this.db as any)
            .selectFrom('zv_ai_memory')
            .selectAll()
            .where('user_id', '=', request.userId)
            .where('embedding', 'is not', null)
            .orderBy(
              (this.db as any).raw(`embedding <=> '${JSON.stringify(queryEmbedding)}'::vector`)
            )
            .limit(limit)
            .execute();
        }
      } catch {
        // Fallback to text search
      }

      // Fallback: PostgreSQL full-text search
      if (rows.length === 0) {
        rows = await (this.db as any)
          .selectFrom('zv_ai_memory')
          .selectAll()
          .where('user_id', '=', request.userId)
          .where(
            (this.db as any).raw(
              `to_tsvector('english', content) @@ plainto_tsquery('english', ?)`,
              [query]
            )
          )
          .orderBy('importance', 'desc')
          .orderBy('updated_at', 'desc')
          .limit(limit)
          .execute()
          .catch(() => []);
      }

      // Final fallback: return most important recent memories
      if (rows.length === 0) {
        rows = await (this.db as any)
          .selectFrom('zv_ai_memory')
          .selectAll()
          .where('user_id', '=', request.userId)
          .orderBy('importance', 'desc')
          .orderBy('updated_at', 'desc')
          .limit(limit)
          .execute()
          .catch(() => []);
      }

      if (rows.length === 0) {
        return { success: true, facts: [], message: 'No relevant memories found.' };
      }

      const facts = rows.map((r: any) => ({
        key: r.context_key,
        content: r.content,
        importance: r.importance,
        saved_at: r.updated_at,
      }));

      return { success: true, facts, count: facts.length };
    } catch (err: any) {
      return { success: false, error: 'Memory service not available.', details: err.message };
    }
  }

  private async toolTextToSQL(args: any, request: ZveltioAIRequest): Promise<any> {
    const { question, collections_hint = [] } = args;

    // Pasul 1: Colectează schema colecțiilor relevante
    let schemaContext = '';
    try {
      const collections = collections_hint.length > 0
        ? await (this.db as any)
            .selectFrom('zv_collections')
            .selectAll()
            .where('name', 'in', collections_hint)
            .execute()
        : await (this.db as any)
            .selectFrom('zv_collections')
            .selectAll()
            .limit(10)
            .execute();

      schemaContext = collections.map((c: any) => {
        const schema = typeof c.schema === 'string' ? JSON.parse(c.schema) : c.schema;
        const fields = (schema?.fields ?? []).map((f: any) => `${f.name} ${f.type}`).join(', ');
        return `Table zv_${c.name}: (${fields})`;
      }).join('\n');
    } catch { /* non-fatal */ }

    // Pasul 2: Generează SQL via AI
    const provider = aiProviderManager.getDefault();
    if (!provider) return { error: 'No AI provider configured' };

    const sqlGenResponse = await provider.chat([
      {
        role: 'system',
        content: `You are a SQL expert for PostgreSQL. Generate ONLY a valid SELECT query.
Return ONLY the SQL query, no explanation, no markdown, no semicolon at end.
ONLY SELECT queries are allowed. Never use DROP, DELETE, UPDATE, INSERT, ALTER.

Available tables:
${schemaContext}

Rules:
- Table names are prefixed with zv_ (e.g., collection "orders" → table "zv_orders")
- Always use table aliases for clarity
- Limit results to 100 rows maximum unless aggregating`,
      },
      { role: 'user', content: question },
    ], { temperature: 0.1, max_tokens: 500 });

    const generatedSQL = sqlGenResponse.content.trim();

    // Pasul 3: Validare strictă
    const normalized = generatedSQL.toUpperCase();
    if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
      return { error: 'Generated query is not a SELECT statement', generated: generatedSQL };
    }

    const forbidden = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'ALTER', 'TRUNCATE', 'GRANT'];
    for (const kw of forbidden) {
      if (normalized.includes(kw)) {
        return { error: `Generated query contains forbidden keyword: ${kw}` };
      }
    }

    // Pasul 4: Execuție cu sql.raw
    try {
      const result = await sql.raw(generatedSQL).execute(this.db);
      const rows = (result as any).rows ?? [];

      return {
        success: true,
        question,
        sql: generatedSQL,
        row_count: rows.length,
        data: rows.slice(0, 100),
        message: `Query returned ${rows.length} rows`,
      };
    } catch (err: any) {
      return {
        success: false,
        question,
        sql: generatedSQL,
        error: `SQL execution failed: ${err.message}`,
      };
    }
  }

  // ── Helpers ────────────────────────────────────────────────────

  private generateConversationId(): string {
    return nanoid();
  }

  private async getConversationHistory(conversationId: string): Promise<any[]> {
    try {
      const rows = await this.db
        .selectFrom('zv_ai_conversations')
        .selectAll()
        .where('id', '=', conversationId)
        .executeTakeFirst();

      if (!rows) return [];

      const messages = await this.db
        .selectFrom('zv_ai_messages')
        .selectAll()
        .where('conversation_id', '=', conversationId)
        .orderBy('created_at', 'asc')
        .execute();

      return messages;
    } catch {
      return [];
    }
  }

  private async saveConversation(
    conversationId: string,
    userId: string,
    userMessage: string,
    assistantMessage: string,
  ): Promise<void> {
    try {
      await this.db
        .insertInto('zv_ai_conversations' as any)
        .values({
          id: conversationId,
          user_id: userId,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .onConflict((oc: any) =>
          oc.column('id').doUpdateSet({ updated_at: new Date() }),
        )
        .execute();

      await this.db
        .insertInto('zv_ai_messages' as any)
        .values({
          conversation_id: conversationId,
          role: 'user',
          content: userMessage,
          created_at: new Date(),
        })
        .execute();

      await this.db
        .insertInto('zv_ai_messages' as any)
        .values({
          conversation_id: conversationId,
          role: 'assistant',
          content: assistantMessage,
          created_at: new Date(),
        })
        .execute();
    } catch (error) {
      console.error('Failed to save conversation:', error);
    }
  }
}
