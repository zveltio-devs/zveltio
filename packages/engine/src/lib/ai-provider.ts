/**
 * Engine-level AI provider manager.
 * Supports OpenAI-compatible APIs, Anthropic (Claude), and Ollama (local).
 *
 * Providers are configured in the DB table `zv_ai_providers`
 * (or via OPENAI_API_KEY / ANTHROPIC_API_KEY env vars as fallback).
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, any>;
    };
  }>;
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
}

export interface ChatResult {
  content: string;
  model: string;
  provider: string;
  usage: { prompt_tokens: number; response_tokens: number };
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface EmbedResult {
  embedding: number[];
  model: string;
}

export interface AIProvider {
  name: string;
  label: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  embed?(text: string, model?: string): Promise<EmbedResult>;
}

// ─── OpenAI / OpenAI-compatible ────────────────────────────────

export class OpenAIProvider implements AIProvider {
  name: string;
  label: string;

  constructor(
    private apiKey: string,
    private baseUrl = 'https://api.openai.com/v1',
    private defaultModel = 'gpt-4o-mini',
    name = 'openai',
    label = 'OpenAI',
  ) {
    this.name = name;
    this.label = label;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const model = opts.model || this.defaultModel;
    const body: any = {
      model,
      messages,
      temperature: opts.temperature ?? 0.7,
      ...(opts.max_tokens ? { max_tokens: opts.max_tokens } : {}),
    };

    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools;
      body.tool_choice = opts.tool_choice ?? 'auto';
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI error ${res.status}: ${err}`);
    }

    const data: any = await res.json();
    return {
      content: data.choices[0].message.content || '',
      model,
      provider: this.name,
      usage: {
        prompt_tokens: data.usage?.prompt_tokens ?? 0,
        response_tokens: data.usage?.completion_tokens ?? 0,
      },
      tool_calls: data.choices[0].message.tool_calls,
    };
  }

  async embed(text: string, model = 'text-embedding-3-small'): Promise<EmbedResult> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model, input: text }),
    });

    if (!res.ok) throw new Error(`OpenAI embeddings error: ${res.status}`);

    const data: any = await res.json();
    return { embedding: data.data[0].embedding, model };
  }
}

// ─── Anthropic (Claude) ────────────────────────────────────────

export class AnthropicProvider implements AIProvider {
  name = 'anthropic';
  label = 'Anthropic (Claude)';

  constructor(
    private apiKey: string,
    private defaultModel = 'claude-haiku-4-5-20251001',
  ) {}

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const model = opts.model || this.defaultModel;
    const systemMsg = messages.find((m) => m.role === 'system')?.content;
    const userMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const body: any = {
      model,
      messages: userMessages,
      max_tokens: opts.max_tokens ?? 2048,
      temperature: opts.temperature ?? 0.7,
    };
    if (systemMsg) body.system = systemMsg;

    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic error ${res.status}: ${err}`);
    }

    const data: any = await res.json();
    const textBlocks = data.content.filter((b: any) => b.type === 'text');
    const content = textBlocks.map((b: any) => b.text).join('');
    const toolUseBlocks = data.content.filter((b: any) => b.type === 'tool_use');
    const tool_calls = toolUseBlocks.map((b: any) => ({
      id: b.id,
      type: 'function' as const,
      function: { name: b.name, arguments: JSON.stringify(b.input) },
    }));

    return {
      content,
      model,
      provider: this.name,
      usage: {
        prompt_tokens: data.usage?.input_tokens ?? 0,
        response_tokens: data.usage?.output_tokens ?? 0,
      },
      tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
    };
  }
}

// ─── Ollama (local) ────────────────────────────────────────────

export class OllamaProvider implements AIProvider {
  name = 'ollama';
  label = 'Ollama (local)';

  constructor(
    private baseUrl = 'http://localhost:11434',
    private defaultModel = 'llama3.2',
  ) {}

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const model = opts.model || this.defaultModel;
    const body: any = {
      model,
      messages,
      stream: false,
      options: {
        temperature: opts.temperature ?? 0.7,
        num_predict: opts.max_tokens ?? -1,
      },
    };

    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools;
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Ollama error: ${res.status}`);

    const data: any = await res.json();
    const tool_calls = data.message.tool_calls?.map((tc: any) => ({
      id: tc.id || crypto.randomUUID(),
      type: 'function' as const,
      function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments) },
    }));

    return {
      content: data.message.content,
      model,
      provider: this.name,
      usage: {
        prompt_tokens: data.prompt_eval_count ?? 0,
        response_tokens: data.eval_count ?? 0,
      },
      tool_calls: tool_calls?.length > 0 ? tool_calls : undefined,
    };
  }

  async embed(text: string, model?: string): Promise<EmbedResult> {
    const useModel = model || this.defaultModel;
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: useModel, input: text }),
    });
    const data: any = await res.json();
    return { embedding: data.embeddings[0], model: useModel };
  }
}

// ─── Provider Manager ──────────────────────────────────────────

export class AIProviderManager {
  private providers = new Map<string, AIProvider>();
  private _defaultName: string | null = null;

  register(provider: AIProvider, isDefault = false): void {
    this.providers.set(provider.name, provider);
    if (isDefault || this.providers.size === 1) {
      this._defaultName = provider.name;
    }
  }

  getDefault(): AIProvider | null {
    return this._defaultName ? (this.providers.get(this._defaultName) ?? null) : null;
  }

  get(name: string): AIProvider | null {
    return this.providers.get(name) ?? null;
  }

  list(): Array<{ name: string; label: string; isDefault: boolean }> {
    return [...this.providers.values()].map((p) => ({
      name: p.name,
      label: p.label,
      isDefault: p.name === this._defaultName,
    }));
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  setDefault(name: string): void {
    if (this.providers.has(name)) this._defaultName = name;
  }
}

export const aiProviderManager = new AIProviderManager();

/**
 * Initialize AI providers from DB config + env vars.
 * Called once on engine startup.
 */
export async function initAIProviders(db: any): Promise<void> {
  // Load from DB
  const rows = await db
    .selectFrom('zv_ai_providers' as any)
    .selectAll()
    .where('is_active' as any, '=', true)
    .execute()
    .catch(() => []);

  for (const row of rows as any[]) {
    let provider: AIProvider | null = null;

    switch (row.name) {
      case 'openai':
        if (row.api_key) {
          provider = new OpenAIProvider(row.api_key, row.base_url || undefined, row.default_model || undefined);
        }
        break;
      case 'anthropic':
        if (row.api_key) {
          provider = new AnthropicProvider(row.api_key, row.default_model || undefined);
        }
        break;
      case 'ollama':
        provider = new OllamaProvider(row.base_url || undefined, row.default_model || undefined);
        break;
      default:
        // OpenAI-compatible custom provider
        if (row.api_key && row.base_url) {
          provider = new OpenAIProvider(row.api_key, row.base_url, row.default_model || 'gpt-4o-mini', row.name, row.label || row.name);
        }
    }

    if (provider) {
      aiProviderManager.register(provider, row.is_default);
    }
  }

  // Env var fallbacks (if no DB providers configured)
  if (!aiProviderManager.getDefault()) {
    if (process.env.OPENAI_API_KEY) {
      aiProviderManager.register(
        new OpenAIProvider(process.env.OPENAI_API_KEY, undefined, process.env.OPENAI_MODEL || 'gpt-4o-mini'),
        true,
      );
    } else if (process.env.ANTHROPIC_API_KEY) {
      aiProviderManager.register(
        new AnthropicProvider(process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_MODEL),
        true,
      );
    } else if (process.env.OLLAMA_URL) {
      aiProviderManager.register(
        new OllamaProvider(process.env.OLLAMA_URL, process.env.OLLAMA_MODEL),
        true,
      );
    }
  }
}

/** Matches {{variableName}} placeholders in template strings. */
const TEMPLATE_VAR_RE = /\{\{(\w+)\}\}/g;

/**
 * Simple Handlebars-like template renderer: {{variable}} → value
 */
export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(TEMPLATE_VAR_RE, (_, key) => variables[key] ?? `{{${key}}}`);
}
