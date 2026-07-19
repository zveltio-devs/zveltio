#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const STUDIO = join(import.meta.dir, '..');
const EXT = join(STUDIO, '..', '..', '..', 'zveltio-extensions');
const EN = join(STUDIO, 'messages/en.json');
const RO = join(STUDIO, 'messages/ro.json');

const en = JSON.parse(readFileSync(EN, 'utf8')) as Record<string, string>;
const ro = JSON.parse(readFileSync(RO, 'utf8')) as Record<string, string>;

const KEYS: Record<string, { en: string; ro: string }> = {
  // Edge Functions
  'developer.edge-functions.panel.title': { en: 'Edge Functions', ro: 'Funcții Edge' },
  'developer.edge-functions.empty.functions': { en: 'No functions', ro: 'Nicio funcție' },
  'developer.edge-functions.status.inactive': { en: 'Inactive', ro: 'Inactiv' },
  'developer.edge-functions.btn.save': { en: 'Save', ro: 'Salvează' },
  'developer.edge-functions.btn.run': { en: 'Run', ro: 'Rulează' },
  'developer.edge-functions.test.title': { en: 'Test Invoke', ro: 'Test invocare' },
  'developer.edge-functions.test.response': { en: 'Response', ro: 'Răspuns' },
  'developer.edge-functions.test.console': { en: 'Console', ro: 'Consolă' },
  'developer.edge-functions.empty.selectOrCreate': {
    en: 'Select a function or create one',
    ro: 'Selectează o funcție sau creează una',
  },
  'developer.edge-functions.btn.newFunction': { en: 'New Function', ro: 'Funcție nouă' },
  'developer.edge-functions.btn.create': { en: 'Create', ro: 'Creează' },
  'developer.edge-functions.form.displayNamePlaceholder': { en: 'My Function', ro: 'Funcția mea' },
  'developer.edge-functions.form.mountedAt': {
    en: 'Mounted at /api/fn/',
    ro: 'Montat la /api/fn/',
  },
  'developer.edge-functions.error.save': { en: 'Error saving', ro: 'Eroare la salvare' },
  'developer.edge-functions.error.invoke': { en: 'Invoke failed', ro: 'Invocarea a eșuat' },
  // AI — clean keys (replace ugly ai.ui.*)
  'ai.studio.title': { en: 'AI Studio', ro: 'Studio AI' },
  'ai.studio.subtitle': {
    en: 'Chat with your data, generate schemas, run SQL queries, and search semantically.',
    ro: 'Conversează cu datele, generează scheme, rulează interogări SQL și caută semantic.',
  },
  'ai.studio.noProvider': {
    en: 'No AI provider configured.',
    ro: 'Niciun furnizor AI configurat.',
  },
  'ai.studio.addProvider': { en: 'Add one here →', ro: 'Adaugă unul aici →' },
  'ai.chat.newChat': { en: 'New Chat', ro: 'Chat nou' },
  'ai.chat.emptyChats': { en: 'No chats yet', ro: 'Niciun chat încă' },
  'ai.chat.startConversation': {
    en: 'Send a message to start the conversation',
    ro: 'Trimite un mesaj pentru a începe conversația',
  },
  'ai.chat.messagePlaceholder': {
    en: 'Type a message… (Enter to send, Shift+Enter for newline)',
    ro: 'Scrie un mesaj… (Enter trimite, Shift+Enter linie nouă)',
  },
  'ai.templates.empty': { en: 'No templates', ro: 'Niciun șablon' },
  'ai.templates.run': { en: 'Run', ro: 'Rulează' },
  'ai.search.hint': {
    en: 'Search semantically in collections with AI Search enabled.',
    ro: 'Caută semantic în colecțiile cu AI Search activat.',
  },
  'ai.search.queryLabel': { en: 'Semantic query', ro: 'Interogare semantică' },
  'ai.search.btn': { en: 'Search', ro: 'Caută' },
  'ai.search.emptyHint': {
    en: 'Enter a collection and query in the sidebar to search records semantically.',
    ro: 'Introdu o colecție și un query în sidebar pentru căutare semantică.',
  },
  'ai.search.resultsCount': { en: '{count} results for', ro: '{count} rezultate pentru' },
  'ai.search.inCollection': { en: 'in', ro: 'în' },
  'ai.providers.title': { en: 'AI Providers', ro: 'Furnizori AI' },
  'ai.providers.default': { en: 'default', ro: 'implicit' },
  'ai.providers.add': { en: 'Add Provider', ro: 'Adaugă furnizor' },
  'ai.providers.setDefault': { en: 'Set as default', ro: 'Setează ca implicit' },
  'ai.providers.saving': { en: 'Saving…', ro: 'Se salvează…' },
  'ai.provider.openai': { en: 'OpenAI', ro: 'OpenAI' },
  'ai.provider.anthropic': { en: 'Anthropic', ro: 'Anthropic' },
  'ai.provider.ollama': { en: 'Ollama (local)', ro: 'Ollama (local)' },
  'ai.provider.custom': { en: 'Custom', ro: 'Personalizat' },
  'ai.provider.label': { en: 'Label', ro: 'Etichetă' },
  'ai.provider.apiKey': { en: 'API Key', ro: 'Cheie API' },
  'ai.provider.baseUrl': { en: 'Base URL', ro: 'URL bază' },
  'ai.provider.defaultModel': { en: 'Default model', ro: 'Model implicit' },
  'ai.query.hint': {
    en: 'Ask in natural language — get SQL + results.',
    ro: 'Întreabă în limbaj natural — primești SQL + rezultate.',
  },
  'ai.query.run': { en: 'Run Query', ro: 'Rulează interogarea' },
  'ai.query.title': { en: 'AI Query Builder', ro: 'Constructor interogări AI' },
  'ai.query.emptyHint': {
    en: 'Type a question in plain language — AI generates and runs the SQL read-only query.',
    ro: 'Scrie o întrebare în limbaj natural — AI generează și rulează interogarea SQL read-only.',
  },
  'ai.query.generatedSql': { en: 'Generated SQL', ro: 'SQL generat' },
  'ai.query.rowsReturned': { en: 'row(s) returned', ro: 'rând(uri) returnate' },
  'ai.query.noRows': { en: 'No rows returned', ro: 'Niciun rând returnat' },
  'ai.schema.hint': {
    en: 'Describe your data model — AI generates the schema.',
    ro: 'Descrie modelul de date — AI generează schema.',
  },
  'ai.schema.generate': { en: 'Generate Schema', ro: 'Generează schema' },
  'ai.schema.title': { en: 'Schema Generator', ro: 'Generator schemă' },
  'ai.schema.emptyHint': {
    en: 'Describe your data model in plain language — AI generates the collection schema ready to apply.',
    ro: 'Descrie modelul în limbaj natural — AI generează schema colecției gata de aplicat.',
  },
  'ai.schema.generated': { en: 'Generated', ro: 'Generat' },
  'ai.schema.rawJson': { en: 'Raw JSON', ro: 'JSON brut' },
  'ai.schema.createCollection': { en: 'Create Collection', ro: 'Creează colecție' },
  'ai.prompt.collectionsCounts': {
    en: 'Show me all collections with their record counts',
    ro: 'Arată toate colecțiile cu numărul de înregistrări',
  },
  'ai.prompt.ecommerceSchema': {
    en: 'Generate a schema for an e-commerce product catalog',
    ro: 'Generează o schemă pentru catalog produse e-commerce',
  },
  'ai.prompt.pendingRecords': {
    en: 'Find records where status is pending from the last 7 days',
    ro: 'Găsește înregistrări cu status pending din ultimele 7 zile',
  },
  'ai.prompt.activeCollections': {
    en: 'What are the most active collections this week?',
    ro: 'Care sunt cele mai active colecții săptămâna aceasta?',
  },
};

for (const [k, v] of Object.entries(KEYS)) {
  en[k] = v.en;
  ro[k] = v.ro;
}

// Alias old ugly keys to new (for any missed references)
const ALIASES: Record<string, string> = {
  'ai.ui.ai_studio': 'ai.studio.title',
  'ai.ui.query_semantic': 'ai.search.queryLabel',
  'ai.ui.type_a_message_enter_to_send_shift_enter_for_new': 'ai.chat.messagePlaceholder',
  'ai.ui.introdu_o_colec_ie_i_un_query_n_sidebar_pentru_a': 'ai.search.emptyHint',
  'ai.ui.ai_query_builder': 'ai.query.title',
  'ai.ui.type_a_question_in_plain_language_ai_generates_a': 'ai.query.emptyHint',
  'ai.ui.schema_generator': 'ai.schema.title',
  'ai.ui.describe_your_data_model_in_plain_language_ai_ge': 'ai.schema.emptyHint',
  'ai.ui.openai': 'ai.provider.openai',
  'ai.ui.anthropic': 'ai.provider.anthropic',
  'ai.ui.ollama_local': 'ai.provider.ollama',
  'ai.ui.custom': 'ai.provider.custom',
  'ai.ui.label': 'ai.provider.label',
  'ai.ui.api_key': 'ai.provider.apiKey',
  'ai.ui.base_url': 'ai.provider.baseUrl',
  'ai.ui.default_model': 'ai.provider.defaultModel',
  'ai.ui.raw_json': 'ai.schema.rawJson',
  'ai.ui.colec_ie': 'ai.search.collection',
  'ai.ui.ex_articles': 'ai.search.placeholder',
  'ai.ui.ex_articole_despre_machine_learning': 'ai.search.queryPlaceholder',
  'ai.ui.ex_show_me_the_10_most_recent_users_who_signed_u': 'ai.query.placeholder',
  'ai.ui.ex_a_blog_with_posts_title_content_status_author': 'ai.schema.placeholder',
};
for (const [oldK, newK] of Object.entries(ALIASES)) {
  if (en[newK]) {
    en[oldK] = en[newK];
    ro[oldK] = ro[newK];
  }
}

function patch(rel: string, reps: [string, string][]) {
  const p = join(EXT, rel);
  if (!existsSync(p)) return;
  let c = readFileSync(p, 'utf8');
  const o = c;
  for (const [a, b] of reps) c = c.replaceAll(a, b);
  if (c !== o) {
    writeFileSync(p, c);
    console.log('patched', rel);
  }
}

// Rename m[] keys in AI page to clean names
const AI_KEY_RENAMES: [string, string][] = [
  ["m['ai.ui.ai_studio']", "m['ai.studio.title']"],
  ["m['ai.ui.query_semantic']", "m['ai.search.queryLabel']"],
  [
    "m['ai.ui.type_a_message_enter_to_send_shift_enter_for_new']",
    "m['ai.chat.messagePlaceholder']",
  ],
  ["m['ai.ui.introdu_o_colec_ie_i_un_query_n_sidebar_pentru_a']", "m['ai.search.emptyHint']"],
  ["m['ai.ui.ai_query_builder']", "m['ai.query.title']"],
  ["m['ai.ui.type_a_question_in_plain_language_ai_generates_a']", "m['ai.query.emptyHint']"],
  ["m['ai.ui.schema_generator']", "m['ai.schema.title']"],
  ["m['ai.ui.describe_your_data_model_in_plain_language_ai_ge']", "m['ai.schema.emptyHint']"],
  ["m['ai.ui.openai']", "m['ai.provider.openai']"],
  ["m['ai.ui.anthropic']", "m['ai.provider.anthropic']"],
  ["m['ai.ui.ollama_local']", "m['ai.provider.ollama']"],
  ["m['ai.ui.custom']", "m['ai.provider.custom']"],
  ["m['ai.ui.label']", "m['ai.provider.label']"],
  ["m['ai.ui.api_key']", "m['ai.provider.apiKey']"],
  ["m['ai.ui.base_url']", "m['ai.provider.baseUrl']"],
  ["m['ai.ui.default_model']", "m['ai.provider.defaultModel']"],
  ["m['ai.ui.raw_json']", "m['ai.schema.rawJson']"],
];

const EF = "m['developer.edge-functions";
patch('developer/edge-functions/studio/pages/+page.svelte', [
  [
    '<span class="font-semibold text-sm">Edge Functions</span>',
    `<span class="font-semibold text-sm">{${EF}.panel.title']()}</span>`,
  ],
  [
    '<Code size={28} class="mx-auto mb-2 opacity-30" /> No functions',
    `<Code size={28} class="mx-auto mb-2 opacity-30" /> {${EF}.empty.functions']()}`,
  ],
  ["'Inactive'", `{${EF}.status.inactive']()}`],
  ['{/if} Save', `{/if}{${EF}.btn.save']()}`],
  ['{/if} Run', `{/if}{${EF}.btn.run']()}`],
  [
    '<div class="p-3 border-b border-base-300 font-medium text-sm">Test Invoke</div>',
    `<div class="p-3 border-b border-base-300 font-medium text-sm">{${EF}.test.title']()}</div>`,
  ],
  [
    '<span class="text-xs font-medium">Response</span>',
    `<span class="text-xs font-medium">{${EF}.test.response']()}</span>`,
  ],
  [
    '<p class="text-xs font-medium mb-0.5">Console</p>',
    `<p class="text-xs font-medium mb-0.5">{${EF}.test.console']()}</p>`,
  ],
  [
    '<p class="text-sm">Select a function or create one</p>',
    `<p class="text-sm">{${EF}.empty.selectOrCreate']()}</p>`,
  ],
  [
    '<Plus size={14} /> New Function</button>',
    `<Plus size={14} /> {${EF}.btn.newFunction']()}</button>`,
  ],
  ['{/if} Create', `{/if}{${EF}.btn.create']()}`],
  ['placeholder="My Function"', `placeholder={${EF}.form.displayNamePlaceholder']()}`],
  ["Mounted at /api/fn/{form.name || '…'}", `{${EF}.form.mountedAt']()}{form.name || '…'}`],
  ["toast.error(e?.message ?? 'Error saving')", `toast.error(e?.message ?? ${EF}.error.save']())`],
  [
    "toast.error(e?.message ?? 'Invoke failed')",
    `toast.error(e?.message ?? ${EF}.error.invoke']())`,
  ],
]);

patch('ai/studio/pages/+page.svelte', [
  ...AI_KEY_RENAMES,
  [
    '<Plus size={14} /> New Chat</button>',
    "<Plus size={14} /> {m['ai.action.newChat']()}</button>",
  ],
  ["{chat.title || 'New Chat'}", "{chat.title || m['ai.chat.newChat']()}"],
  ['No chats yet', "{m['ai.chat.emptyChats']()}"],
  ['<Sparkles size={10} /> Run', "<Sparkles size={10} /> {m['ai.templates.run']()}"],
  ['No templates', "{m['ai.templates.empty']()}"],
  ['Caută semantic în colecțiile cu AI Search activat.', "{m['ai.search.hint']()}"],
  ['{/if} Caută', "{/if}{m['ai.search.btn']()}"],
  [
    '<p class="text-xs font-semibold text-base-content/60 uppercase mb-2">AI Providers</p>',
    '<p class="text-xs font-semibold text-base-content/60 uppercase mb-2">{m[\'ai.providers.title\']()}</p>',
  ],
  [
    '<span class="badge badge-xs badge-primary">default</span>',
    '<span class="badge badge-xs badge-primary">{m[\'ai.providers.default\']()}</span>',
  ],
  ['<Plus size={14} /> Add Provider', "<Plus size={14} /> {m['ai.providers.add']()}"],
  ['Set as default', "{m['ai.providers.setDefault']()}"],
  [
    "{savingProvider ? 'Saving…' : m['common.save']()",
    "{savingProvider ? m['ai.providers.saving']() : m['common.save']()}",
  ],
  ['Ask in natural language — get SQL + results.', "{m['ai.query.hint']()}"],
  ['{/if} Run Query', "{/if}{m['ai.action.runQuery']()}"],
  ['Describe your data model — AI generates the schema.', "{m['ai.schema.hint']()}"],
  ['{/if} Generate Schema', "{/if}{m['ai.action.generateSchema']()}"],
  [
    'Chat with your data, generate schemas, run SQL queries, and search semantically.',
    "{m['ai.studio.subtitle']()}",
  ],
  ['No AI provider configured.', "{m['ai.studio.noProvider']()}"],
  [
    '<button class="underline" onclick={() => activeTab = \'settings\'}>Add one here →</button>',
    "<button class=\"underline\" onclick={() => activeTab = 'settings'}>{m['ai.studio.addProvider']()}</button>",
  ],
  ["'Show me all collections with their record counts'", "m['ai.prompt.collectionsCounts']()"],
  ["'Generate a schema for an e-commerce product catalog'", "m['ai.prompt.ecommerceSchema']()"],
  [
    "'Find records where status is pending from the last 7 days'",
    "m['ai.prompt.pendingRecords']()",
  ],
  ["'What are the most active collections this week?'", "m['ai.prompt.activeCollections']()"],
  [
    '<Plus size={14} /> New Chat</button>',
    "<Plus size={14} /> {m['ai.action.newChat']()}</button>",
  ],
  ['<p>Send a message to start the conversation</p>', "<p>{m['ai.chat.startConversation']()}</p>"],
  [
    '<p class="text-sm text-base-content/60">{searchResults.length} rezultate pentru <strong>"{searchQuery}"</strong> în <code class="text-primary">{searchCollection}</code></p>',
    '<p class="text-sm text-base-content/60">{m[\'ai.search.resultsCount\']().replace(\'{count}\', String(searchResults.length))} <strong>"{searchQuery}"</strong> {m[\'ai.search.inCollection\']()} <code class="text-primary">{searchCollection}</code></p>',
  ],
  [
    '<p class="text-xs font-semibold text-base-content/50 uppercase mb-2">Generated SQL</p>',
    '<p class="text-xs font-semibold text-base-content/50 uppercase mb-2">{m[\'ai.query.generatedSql\']()}</p>',
  ],
  [
    '{queryResult.data.length} row(s) returned',
    "{queryResult.data.length} {m['ai.query.rowsReturned']()}",
  ],
  ['No rows returned', "{m['ai.query.noRows']()}"],
  [
    '<h2 class="font-bold text-lg">Generated: <code class="text-primary">{schemaResult.name}</code></h2>',
    '<h2 class="font-bold text-lg">{m[\'ai.schema.generated\']()}: <code class="text-primary">{schemaResult.name}</code></h2>',
  ],
  [
    '<Plus size={14} /> Create Collection</button>',
    "<Plus size={14} /> {m['ai.action.createCollection']()}</button>",
  ],
]);

writeFileSync(EN, JSON.stringify(en, null, 2) + '\n');
writeFileSync(RO, JSON.stringify(ro, null, 2) + '\n');
console.log('i18n-batch-ai-edge done');
