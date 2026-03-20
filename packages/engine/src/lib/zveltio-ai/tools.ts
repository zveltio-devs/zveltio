/**
 * Zveltio AI Engine — Tool Definitions
 */

import type { ZveltioAITool } from './types.js';

export const zveltioAITools: ZveltioAITool[] = [
  {
    type: 'function',
    function: {
      name: 'query_data',
      description: 'Query database records. Use when user asks about their data or wants to see records.',
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: 'Collection name (e.g., "orders", "users")' },
          filters: { type: 'object', description: 'Filters to apply. Example: {"status": "active"}' },
          limit: { type: 'number', description: 'Max records to return (default 10, max 100)', default: 10 },
          orderBy: { type: 'string', description: 'Field to sort by' },
          orderDirection: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
        },
        required: ['collection'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_collection',
      description: 'Create a new table/collection in the database.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Collection name (lowercase, underscores)' },
          display_name: { type: 'string', description: 'Human-readable name' },
          fields: {
            type: 'array',
            description: 'Field definitions',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                display_name: { type: 'string' },
                type: {
                  type: 'string',
                  enum: ['string', 'text', 'number', 'boolean', 'date', 'datetime', 'enum', 'reference', 'json'],
                },
                required: { type: 'boolean', default: false },
                unique: { type: 'boolean', default: false },
                default_value: { type: 'string' },
                options: { type: 'array', items: { type: 'string' } },
                reference: { type: 'string' },
              },
            },
          },
        },
        required: ['name', 'fields'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_field',
      description: 'Add a new field to an existing collection.',
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: 'Collection to modify' },
          field: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              required: { type: 'boolean' },
            },
          },
        },
        required: ['collection', 'field'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_report',
      description: 'Generate and export a report from data. Returns a download URL.',
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string' },
          format: { type: 'string', enum: ['pdf', 'excel', 'csv'], default: 'pdf' },
          filters: { type: 'object' },
        },
        required: ['collection'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_visualization',
      description: 'Create a chart or dashboard visualization.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['line_chart', 'bar_chart', 'pie_chart', 'table', 'dashboard'] },
          collection: { type: 'string' },
          metric: { type: 'string' },
          groupBy: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['type', 'collection', 'metric'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_sql',
      description: 'Execute a read-only SQL SELECT query. ADMIN ONLY.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'SQL SELECT query to execute' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_collections',
      description: 'List all available collections/tables in the database.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_collection_schema',
      description: 'Get the schema/structure of a specific collection including all fields.',
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: 'Collection name' },
        },
        required: ['collection'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_record',
      description: 'Create a new record in a collection.',
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string' },
          data: { type: 'object', description: 'Record data to insert' },
        },
        required: ['collection', 'data'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_record',
      description: 'Update an existing record in a collection.',
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string' },
          id: { type: 'string' },
          data: { type: 'object' },
        },
        required: ['collection', 'id', 'data'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_record',
      description: 'Delete a record from a collection.',
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string' },
          id: { type: 'string' },
        },
        required: ['collection', 'id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'count_records',
      description: 'Count records in a collection matching optional filters.',
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string' },
          filters: { type: 'object' },
        },
        required: ['collection'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_system_stats',
      description: 'Get platform statistics: total collections, records, users, recent activity.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description: 'Save an important fact, preference, or business rule to long-term memory. ' +
                   'Use when the user shares information they want you to remember for future conversations ' +
                   '(e.g., "always show prices in EUR", "our fiscal year starts in April", "preferred report format is PDF").',
      parameters: {
        type: 'object',
        properties: {
          context_key: {
            type: 'string',
            description: 'Short identifier for this memory (snake_case, e.g., "preferred_currency", "fiscal_year_start")',
          },
          content: {
            type: 'string',
            description: 'The fact or rule to remember, written clearly and completely',
          },
          importance: {
            type: 'number',
            description: 'Importance level 1-10 (10 = critical business rule, 5 = preference, 1 = casual note)',
            default: 5,
          },
        },
        required: ['context_key', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'text_to_sql',
      description:
        'Convert a natural language question into a validated SQL SELECT query ' +
        'and execute it. Use when the user asks complex analytical questions that ' +
        'require custom SQL beyond simple filters (e.g., aggregations, JOINs, window functions).',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The natural language question to convert to SQL',
          },
          collections_hint: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: collection names likely relevant to the question',
          },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_facts',
      description: 'Retrieve facts previously saved to long-term memory. ' +
                   'Use before answering questions about preferences or business rules, ' +
                   'or when the user says "remember when I told you..." or "as I mentioned before...".',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to search for in memory (natural language description)',
          },
          limit: {
            type: 'number',
            description: 'Max facts to return (default 5)',
            default: 5,
          },
        },
        required: ['query'],
      },
    },
  },
];

export function getToolByName(name: string): ZveltioAITool | undefined {
  return zveltioAITools.find((t) => t.function.name === name);
}

export function getToolNames(): string[] {
  return zveltioAITools.map((t) => t.function.name);
}
