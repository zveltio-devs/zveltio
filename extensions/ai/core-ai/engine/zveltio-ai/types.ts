/**
 * Zveltio AI Engine — Type Definitions
 */

export interface ZveltioAIRequest {
  message: string;
  userId: string;
  organizationId?: string;
  conversationId?: string;
  context?: Record<string, any>;
}

export interface ZveltioAIResponse {
  response: string;
  actions?: ZveltioAIAction[];
  conversationId: string;
  metadata?: {
    tokensUsed?: number;
    iterations?: number;
    provider?: string;
    model?: string;
    latency?: number;
  };
}

export interface ZveltioAIAction {
  type: string;
  result: any;
  success: boolean;
  error?: string;
}

export interface ZveltioAIContext {
  userId: string;
  organizationId?: string;
  collections: Array<{ name: string; display_name: string; fields: any[] }>;
  collectionCount?: number;
  permissions: any[];
  recentActivity: any[];
  userMemory?: Array<{ context_key: string; content: string; importance: number }>;
}

export interface ZveltioAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

export interface ZveltioAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, any> | string;
  };
}

export interface ZveltioAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ZveltioAIConversation {
  id: string;
  userId: string;
  messages: ZveltioAIMessage[];
  createdAt: Date;
  updatedAt: Date;
}
