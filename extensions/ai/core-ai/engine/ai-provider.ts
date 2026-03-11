/**
 * Multi-provider AI client
 * Supports OpenAI-compatible APIs, Anthropic, and Ollama
 */

// Declare process for browser/edge environments
declare const process: { env: { [key: string]: string | undefined } };

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
  tools?: any[];
  tool_choice?: 'auto' | { type: 'function'; function: { name: string } };
}

export interface ChatResult {
  content: string;
  model: string;
  usage: { prompt_tokens: number; response_tokens: number };
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface AIProvider {
  name: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  embed?(text: string, model?: string): Promise<number[]>;
}

// ─── OpenAI / OpenAI-compatible ────────────────────────────────
export class OpenAIProvider implements AIProvider {
  name = 'openai';

  constructor(
    private apiKey: string,
    private baseUrl = 'https://api.openai.com/v1',
    private defaultModel = 'gpt-4o-mini',
  ) {}

  async chat(
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): Promise<ChatResult> {
    const model = opts.model || this.defaultModel;

    const requestBody: any = {
      model,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.max_tokens,
    };

    // Add tools if provided for native tool calling
    if (opts.tools && opts.tools.length > 0) {
      requestBody.tools = opts.tools;
      requestBody.tool_choice = opts.tool_choice ?? 'auto';
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI error: ${res.status} ${err}`);
    }

    const data: any = await res.json();
    const message = data.choices[0].message;

    return {
      content: message.content || '',
      model,
      usage: {
        prompt_tokens: data.usage.prompt_tokens,
        response_tokens: data.usage.completion_tokens,
      },
      tool_calls: message.tool_calls,
    };
  }

  async embed(
    text: string,
    model = 'text-embedding-3-small',
  ): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model, input: text }),
    });
    const data: any = await res.json();
    return data.data[0].embedding;
  }
}

// ─── Anthropic (Claude) ────────────────────────────────────────
export class AnthropicProvider implements AIProvider {
  name = 'anthropic';

  constructor(
    private apiKey: string,
    private defaultModel = 'claude-haiku-4-5-20251001',
  ) {}

  async chat(
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): Promise<ChatResult> {
    const model = opts.model || this.defaultModel;

    // Separate system message
    const systemMsg = messages.find((m) => m.role === 'system')?.content;

    // Build Anthropic messages — tool results need special handling
    const anthropicMessages: any[] = [];
    for (const m of messages.filter((m) => m.role !== 'system')) {
      if (m.role === 'tool') {
        // Tool results: append to last user message content array, or create new user message
        const lastMsg = anthropicMessages[anthropicMessages.length - 1];
        if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
          lastMsg.content.push({
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: m.content,
          });
        } else {
          anthropicMessages.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }],
          });
        }
      } else {
        anthropicMessages.push({ role: m.role, content: m.content });
      }
    }

    const body: any = {
      model,
      messages: anthropicMessages,
      max_tokens: opts.max_tokens ?? 2048,
      temperature: opts.temperature ?? 0.7,
    };

    if (systemMsg) body.system = systemMsg;

    // Map tools: OpenAI format → Anthropic format
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
      if (opts.tool_choice === 'auto' || opts.tool_choice === undefined) {
        body.tool_choice = { type: 'auto' };
      }
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
      throw new Error(`Anthropic error: ${res.status} ${err}`);
    }

    const data: any = await res.json();

    // Extract text blocks and tool_use blocks from response.content array
    const textBlocks = data.content?.filter((b: any) => b.type === 'text') ?? [];
    const toolUseBlocks = data.content?.filter((b: any) => b.type === 'tool_use') ?? [];

    const content = textBlocks.map((b: any) => b.text).join('');

    // Normalize tool_calls to internal format (same as OpenAI)
    const tool_calls = toolUseBlocks.map((b: any) => ({
      id: b.id,
      type: 'function' as const,
      function: {
        name: b.name,
        arguments: JSON.stringify(b.input),
      },
    }));

    return {
      content,
      model,
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

  constructor(
    private baseUrl = 'http://localhost:11434',
    private defaultModel = 'llama3.2',
  ) {}

  async chat(
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): Promise<ChatResult> {
    const model = opts.model || this.defaultModel;

    const body: any = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      options: {
        temperature: opts.temperature ?? 0.7,
        num_predict: opts.max_tokens ?? -1,
      },
    };

    // Ollama accepts tools in OpenAI native format
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      }));
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Ollama error: ${res.status} ${err}`);
    }

    const data: any = await res.json();

    // Normalize tool_calls Ollama → internal format
    const rawToolCalls = data.message?.tool_calls ?? [];
    const tool_calls = rawToolCalls.map((tc: any) => ({
      id: tc.id ?? crypto.randomUUID(),
      type: 'function' as const,
      function: {
        name: tc.function?.name ?? tc.name,
        arguments: typeof tc.function?.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? tc.arguments ?? {}),
      },
    }));

    return {
      content: data.message?.content ?? '',
      model,
      usage: {
        prompt_tokens: data.prompt_eval_count ?? 0,
        response_tokens: data.eval_count ?? 0,
      },
      tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
    };
  }

  async embed(text: string, model?: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model || this.defaultModel, input: text }),
    });
    const data: any = await res.json();
    return data.embeddings[0];
  }
}

// ─── Provider Manager ──────────────────────────────────────────
export class AIProviderManager {
  private providers = new Map<string, AIProvider>();
  private defaultProvider: string | null = null;

  register(provider: AIProvider, isDefault = false): void {
    this.providers.set(provider.name, provider);
    if (isDefault || this.providers.size === 1) {
      this.defaultProvider = provider.name;
    }
  }

  getDefault(): AIProvider | null {
    return this.defaultProvider
      ? (this.providers.get(this.defaultProvider) ?? null)
      : null;
  }

  get(name: string): AIProvider | null {
    return this.providers.get(name) ?? null;
  }

  list(): string[] {
    return [...this.providers.keys()];
  }
}

export const aiProviderManager = new AIProviderManager();

/**
 * Initialize providers from DB config
 */
export async function initAIProviders(db: any): Promise<void> {
  const providers = await db
    .selectFrom('zv_ai_providers')
    .selectAll()
    .where('is_active', '=', true)
    .execute()
    .catch(() => []);

  for (const p of providers) {
    let provider: AIProvider | null = null;

    if (p.name === 'openai' && p.api_key) {
      provider = new OpenAIProvider(
        p.api_key,
        p.base_url || undefined,
        p.default_model || undefined,
      );
    } else if (p.name === 'anthropic' && p.api_key) {
      provider = new AnthropicProvider(p.api_key, p.default_model || undefined);
    } else if (p.name === 'ollama') {
      provider = new OllamaProvider(
        p.base_url || undefined,
        p.default_model || undefined,
      );
    }

    if (provider) {
      aiProviderManager.register(provider, p.is_default);
    }
  }

  // Also check env vars as fallback
  if (!aiProviderManager.getDefault()) {
    if (process.env.OPENAI_API_KEY) {
      aiProviderManager.register(
        new OpenAIProvider(process.env.OPENAI_API_KEY),
        true,
      );
    } else if (process.env.ANTHROPIC_API_KEY) {
      aiProviderManager.register(
        new AnthropicProvider(process.env.ANTHROPIC_API_KEY),
        true,
      );
    }
  }
}
