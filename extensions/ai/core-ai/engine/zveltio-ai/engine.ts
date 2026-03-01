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

import { nanoid } from 'nanoid';
import { sql } from 'kysely';
import { aiProviderManager } from '../ai-provider.js';
import { zveltioAITools } from './tools.js';
import type {
  ZveltioAIRequest,
  ZveltioAIResponse,
  ZveltioAIAction,
  ZveltioAIContext,
  ZveltioAIToolCall,
  ZveltioAIMessage,
} from './types.js';

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
          conversationId: request.conversationId || this.generateConversationId(),
          metadata: { latency: Date.now() - startTime },
        };
      }

      const systemPrompt = this.buildSystemPrompt(context);

      const messages: ZveltioAIMessage[] = [
        { role: 'system', content: systemPrompt },
        ...history.map((h: any) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
        { role: 'user', content: request.message },
      ];

      const aiResponse = await provider.chat(
        messages.map((m) => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content })),
        { temperature: 0.7, max_tokens: 4096 },
      );

      // Parse inline tool calls from response text
      const toolCalls = this.extractToolCalls(aiResponse.content);
      const actions: ZveltioAIAction[] = [];
      let finalResponse = aiResponse.content;

      if (toolCalls && toolCalls.length > 0) {
        for (const toolCall of toolCalls) {
          try {
            const result = await this.executeToolCall(toolCall, request);
            actions.push({ type: toolCall.function.name, result, success: true });
            finalResponse += `\n\n✅ **Action completed: ${toolCall.function.name}**`;
            if (result.message) finalResponse += `\n${result.message}`;
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            actions.push({ type: toolCall.function.name, result: null, success: false, error: msg });
            finalResponse += `\n\n❌ **Action failed: ${toolCall.function.name}** — ${msg}`;
          }
        }
      }

      const conversationId = request.conversationId || this.generateConversationId();
      await this.saveConversation(conversationId, request.userId, request.message, finalResponse);

      return {
        response: finalResponse,
        actions: actions.length > 0 ? actions : undefined,
        conversationId,
        metadata: {
          tokensUsed: aiResponse.usage.prompt_tokens + aiResponse.usage.response_tokens,
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

  // ── Context ────────────────────────────────────────────────────

  private async buildContext(request: ZveltioAIRequest): Promise<ZveltioAIContext> {
    let collections: Array<{ name: string; display_name: string; fields: any[] }> = [];
    try {
      const rows = await this.db
        .selectFrom('zv_collections')
        .select(['name', 'display_name', 'schema'])
        .orderBy('display_name', 'asc')
        .execute();
      collections = rows.map((c: any) => ({
        name: c.name,
        display_name: c.display_name || c.name,
        fields: (() => {
          try { return typeof c.schema === 'string' ? JSON.parse(c.schema) : (c.schema?.fields ?? []); }
          catch { return []; }
        })(),
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
    } catch { /* audit log may not exist */ }

    return {
      userId: request.userId,
      organizationId: request.organizationId,
      collections,
      permissions: [],
      recentActivity,
    };
  }

  // ── System prompt ──────────────────────────────────────────────

  private buildSystemPrompt(context: ZveltioAIContext): string {
    const collectionsList = context.collections.length > 0
      ? context.collections
          .map((c) => `- ${c.display_name} (${c.name}): ${c.fields.length} fields`)
          .join('\n')
      : 'No collections yet. You can help create them.';

    return `You are Zveltio AI, an intelligent assistant for Zveltio — a Backend-as-a-Service platform.

Your role is to help users work with their data, create collections, generate reports, and manage their application.

## User Context
- User ID: ${context.userId}

## Available Collections
${collectionsList}

## Available Tools (invoke by including in your response)

1. **query_data** — query records: \`!query_data(collection="name", filters={}, limit=10)\`
2. **list_collections** — list all tables: \`!list_collections()\`
3. **get_collection_schema** — get schema: \`!get_collection_schema(collection="name")\`
4. **create_collection** — create table: \`!create_collection(name="table", fields=[...])\`
5. **create_record** — insert record: \`!create_record(collection="name", data={...})\`
6. **update_record** — update record: \`!update_record(collection="name", id="...", data={...})\`
7. **delete_record** — delete record: \`!delete_record(collection="name", id="...")\`
8. **count_records** — count records: \`!count_records(collection="name")\`
9. **generate_report** — export data: \`!generate_report(collection="name", format="csv")\`
10. **get_system_stats** — platform stats: \`!get_system_stats()\`

## Guidelines
- USE tools when user asks about data — don't just describe, do it
- Be concise and friendly; use Markdown formatting
- Confirm when actions complete; ask for clarification when needed`;
  }

  // ── Tool call parsing ──────────────────────────────────────────

  private extractToolCalls(content: string): ZveltioAIToolCall[] | null {
    const toolCalls: ZveltioAIToolCall[] = [];
    const toolPattern = /!(\w+)\(([^)]*)\)/g;
    let match;

    while ((match = toolPattern.exec(content)) !== null) {
      const toolName = match[1];
      const argsString = match[2];

      const tool = zveltioAITools.find((t) => t.function.name === toolName);
      if (!tool) continue;

      const args: Record<string, any> = {};
      if (argsString.trim()) {
        const argPattern = /(\w+)=("[^"]*"|'[^']*'|\{[^}]*\}|\[[^\]]*\]|[^,]+)/g;
        let argMatch;
        while ((argMatch = argPattern.exec(argsString)) !== null) {
          const key = argMatch[1];
          let value: any = argMatch[2].trim();
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          try {
            if (value.startsWith('{') || value.startsWith('[')) value = JSON.parse(value);
          } catch { /* keep as string */ }
          args[key] = value;
        }
      }

      toolCalls.push({
        id: nanoid(),
        type: 'function',
        function: { name: toolName, arguments: args },
      });
    }

    return toolCalls.length > 0 ? toolCalls : null;
  }

  // ── Tool dispatcher ────────────────────────────────────────────

  private async executeToolCall(toolCall: ZveltioAIToolCall, request: ZveltioAIRequest): Promise<any> {
    const { name, arguments: args } = toolCall.function;
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;

    switch (name) {
      case 'query_data':          return this.toolQueryData(parsed, request);
      case 'create_collection':   return this.toolCreateCollection(parsed);
      case 'add_field':           return this.toolAddField(parsed);
      case 'generate_report':     return this.toolGenerateReport(parsed, request);
      case 'create_visualization':return this.toolCreateVisualization(parsed);
      case 'execute_sql':         return this.toolExecuteSQL(parsed, request);
      case 'list_collections':    return this.toolListCollections();
      case 'get_collection_schema':return this.toolGetCollectionSchema(parsed);
      case 'create_record':       return this.toolCreateRecord(parsed, request);
      case 'update_record':       return this.toolUpdateRecord(parsed, request);
      case 'delete_record':       return this.toolDeleteRecord(parsed);
      case 'count_records':       return this.toolCountRecords(parsed);
      case 'get_system_stats':    return this.toolGetSystemStats();
      default: throw new Error(`Unknown tool: ${name}`);
    }
  }

  // ── Tool implementations ───────────────────────────────────────

  private async toolQueryData(args: any, _request: ZveltioAIRequest) {
    const { collection, filters = {}, limit = 10, orderBy, orderDirection = 'desc' } = args;

    // Resolve table name from collection registry
    const colDef = await this.db
      .selectFrom('zv_collections')
      .select(['name'])
      .where('name', '=', collection)
      .executeTakeFirst()
      .catch(() => null);

    const tableName = colDef ? `zv_${collection}` : `zv_${collection}`;

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

      return { collection, count: rows.length, data: rows, message: `Found ${rows.length} records in ${collection}` };
    } catch (error) {
      throw new Error(`Failed to query ${collection}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async toolCreateCollection(args: any) {
    const { name, display_name, fields } = args;

    // Queue the DDL operation
    await this.db.insertInto('zv_ddl_jobs' as any).values({
      operation: 'create_collection',
      payload: JSON.stringify({
        name,
        displayName: display_name || name.charAt(0).toUpperCase() + name.slice(1),
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
    }).execute();

    return {
      success: true,
      collection: name,
      fields: fields.length,
      message: `Collection '${display_name || name}' is being created with ${fields.length} fields`,
    };
  }

  private async toolAddField(args: any) {
    const { collection, field } = args;

    await this.db.insertInto('zv_ddl_jobs' as any).values({
      operation: 'add_field',
      payload: JSON.stringify({ collection, field }),
      status: 'pending',
    }).execute();

    return {
      success: true,
      collection,
      field: field.name,
      message: `Field '${field.name}' is being added to '${collection}'`,
    };
  }

  private async toolGenerateReport(args: any, request: ZveltioAIRequest) {
    const { collection, format = 'csv', filters } = args;
    const data = await this.toolQueryData({ collection, filters, limit: 10000 }, request);
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

  private async toolExecuteSQL(args: any, request: ZveltioAIRequest) {
    const { query: sqlQuery } = args;

    const normalized = sqlQuery.trim().toUpperCase();
    if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
      return { success: false, error: 'AI can only execute SELECT queries.' };
    }

    const dangerous = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE'];
    for (const kw of dangerous) {
      if (normalized.includes(kw)) {
        return { success: false, error: `Query contains disallowed keyword: ${kw}` };
      }
    }

    const isAdmin = await this.checkIfAdmin(request.userId);
    if (!isAdmin) throw new Error('SQL execution requires admin privileges');

    const result = await sql.raw(sqlQuery).execute(this.db);
    const rows = (result as any).rows || [];
    return { success: true, rowCount: rows.length, data: rows, message: `${rows.length} rows returned.` };
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
        const schema = typeof c.schema === 'string' ? JSON.parse(c.schema) : c.schema;
        fieldCount = schema?.fields?.length ?? 0;
      } catch { /* ignore */ }
      return { name: c.name, display_name: c.display_name || c.name, fields_count: fieldCount };
    });

    return { success: true, collections: mapped, message: `Found ${mapped.length} collections` };
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
      const schema = typeof colDef.schema === 'string' ? JSON.parse(colDef.schema) : colDef.schema;
      fields = schema?.fields ?? [];
    } catch { /* ignore */ }

    return {
      success: true,
      collection: colDef.name,
      display_name: colDef.display_name || colDef.name,
      fields,
      message: `Schema for ${collection}: ${fields.length} fields`,
    };
  }

  private async toolCreateRecord(args: any, request: ZveltioAIRequest) {
    const { collection, data } = args;
    const tableName = `zv_${collection}`;

    const recordData = {
      ...data,
      id: data.id || nanoid(),
      created_at: new Date(),
      updated_at: new Date(),
    };

    try {
      await this.db.insertInto(tableName as any).values(recordData).execute();
      return { success: true, record: recordData, message: `Record created in ${collection}` };
    } catch (error) {
      throw new Error(`Failed to create record: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async toolUpdateRecord(args: any, request: ZveltioAIRequest) {
    const { collection, id, data } = args;
    const tableName = `zv_${collection}`;

    try {
      await this.db.updateTable(tableName as any)
        .set({ ...data, updated_at: new Date() })
        .where('id' as any, '=', id)
        .execute();
      return { success: true, id, message: `Record ${id} updated in ${collection}` };
    } catch (error) {
      throw new Error(`Failed to update record: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async toolDeleteRecord(args: any) {
    const { collection, id } = args;
    const tableName = `zv_${collection}`;

    try {
      await this.db.deleteFrom(tableName as any).where('id' as any, '=', id).execute();
      return { success: true, id, message: `Record ${id} deleted from ${collection}` };
    } catch (error) {
      throw new Error(`Failed to delete record: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async toolCountRecords(args: any) {
    const { collection, filters = {} } = args;
    const tableName = `zv_${collection}`;

    try {
      let query = this.db.selectFrom(tableName as any).select(this.db.fn.count('id').as('count'));
      for (const [key, value] of Object.entries(filters)) {
        query = query.where(key as any, '=', value);
      }
      const result = await query.executeTakeFirst();
      const count = Number(result?.count ?? 0);
      return { success: true, collection, count, message: `${count} records in ${collection}` };
    } catch (error) {
      throw new Error(`Failed to count records: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async toolGetSystemStats() {
    const [collections, users, recentActivity] = await Promise.all([
      this.db.selectFrom('zv_collections').select(this.db.fn.count('name').as('count')).executeTakeFirst().catch(() => ({ count: 0 })),
      this.db.selectFrom('user').select(this.db.fn.count('id').as('count')).executeTakeFirst().catch(() => ({ count: 0 })),
      this.db.selectFrom('zv_audit_logs').selectAll().orderBy('created_at', 'desc').limit(5).execute().catch(() => []),
    ]);

    return {
      success: true,
      stats: {
        total_collections: Number(collections.count),
        total_users: Number(users.count),
        recent_activity: recentActivity.length,
      },
      message: `Platform has ${collections.count} collections and ${users.count} users`,
    };
  }

  // ── Conversation persistence ───────────────────────────────────

  private async getConversationHistory(conversationId: string) {
    try {
      return await this.db
        .selectFrom('zv_ai_chat_history')
        .select(['role', 'content'])
        .where('conversation_id', '=', conversationId)
        .orderBy('created_at', 'asc')
        .limit(20)
        .execute();
    } catch {
      return [];
    }
  }

  private async saveConversation(
    conversationId: string,
    userId: string,
    userMessage: string,
    aiResponse: string,
  ) {
    try {
      await this.db.insertInto('zv_ai_chat_history').values([
        { conversation_id: conversationId, user_id: userId, role: 'user', content: userMessage },
        { conversation_id: conversationId, user_id: userId, role: 'assistant', content: aiResponse },
      ]).execute();
    } catch { /* non-critical */ }
  }

  // ── Helpers ────────────────────────────────────────────────────

  private async checkIfAdmin(userId: string): Promise<boolean> {
    try {
      const rule = await this.db
        .selectFrom('casbin_rule')
        .selectAll()
        .where('ptype', '=', 'p')
        .where('v0', '=', userId)
        .where('v1', '=', '*')
        .where('v2', '=', '*')
        .executeTakeFirst();
      return !!rule;
    } catch {
      return false;
    }
  }

  private generateConversationId(): string {
    return `zai_conv_${nanoid()}`;
  }
}
