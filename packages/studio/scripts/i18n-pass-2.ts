#!/usr/bin/env bun
/** Second pass: common UI fragments, th headers, btn text, remaining toasts/confirms */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const STUDIO = join(import.meta.dir, '..');
const EXT_ROOT = join(STUDIO, '../../../zveltio-extensions');
const EN_PATH = join(STUDIO, 'messages/en.json');
const RO_PATH = join(STUDIO, 'messages/ro.json');

const en = JSON.parse(readFileSync(EN_PATH, 'utf8')) as Record<string, string>;
const ro = JSON.parse(readFileSync(RO_PATH, 'utf8')) as Record<string, string>;

const TH: Record<string, string> = {
  Field: 'common.col.field',
  Label: 'common.col.label',
  Required: 'common.col.required',
  Unique: 'common.col.unique',
  Title: 'common.col.title',
  Subject: 'common.col.subject',
  Priority: 'common.col.priority',
  'Due Date': 'common.col.dueDate',
  Phone: 'common.col.phone',
  Role: 'common.col.role',
  Provider: 'common.col.provider',
  Model: 'common.col.model',
  Collection: 'common.col.collection',
  Index: 'common.col.index',
  Version: 'common.col.version',
  Slug: 'common.col.slug',
  Locale: 'common.col.locale',
  Key: 'common.col.key',
  Value: 'common.col.value',
  Enabled: 'common.col.enabled',
  Method: 'common.col.method',
  Path: 'common.col.path',
  Duration: 'common.col.duration',
  Project: 'common.col.project',
  Ticket: 'common.col.ticket',
  Channel: 'common.col.channel',
  Template: 'common.col.template',
  Recipient: 'common.col.recipient',
  From: 'common.col.from',
  To: 'common.col.to',
};

const TH_EN: Record<string, string> = {
  'common.col.field': 'Field',
  'common.col.label': 'Label',
  'common.col.required': 'Required',
  'common.col.unique': 'Unique',
  'common.col.title': 'Title',
  'common.col.subject': 'Subject',
  'common.col.priority': 'Priority',
  'common.col.phone': 'Phone',
  'common.col.role': 'Role',
  'common.col.provider': 'Provider',
  'common.col.model': 'Model',
  'common.col.collection': 'Collection',
  'common.col.index': 'Index',
  'common.col.version': 'Version',
  'common.col.slug': 'Slug',
  'common.col.locale': 'Locale',
  'common.col.key': 'Key',
  'common.col.value': 'Value',
  'common.col.enabled': 'Enabled',
  'common.col.method': 'Method',
  'common.col.path': 'Path',
  'common.col.duration': 'Duration',
  'common.col.project': 'Project',
  'common.col.ticket': 'Ticket',
  'common.col.channel': 'Channel',
  'common.col.template': 'Template',
  'common.col.recipient': 'Recipient',
};

const TH_RO: Record<string, string> = {
  'common.col.field': 'Câmp',
  'common.col.label': 'Etichetă',
  'common.col.required': 'Obligatoriu',
  'common.col.unique': 'Unic',
  'common.col.title': 'Titlu',
  'common.col.subject': 'Subiect',
  'common.col.priority': 'Prioritate',
  'common.col.phone': 'Telefon',
  'common.col.role': 'Rol',
  'common.col.provider': 'Furnizor',
  'common.col.model': 'Model',
  'common.col.collection': 'Colecție',
  'common.col.index': 'Index',
  'common.col.version': 'Versiune',
  'common.col.slug': 'Slug',
  'common.col.locale': 'Limbă',
  'common.col.key': 'Cheie',
  'common.col.value': 'Valoare',
  'common.col.enabled': 'Activ',
  'common.col.method': 'Metodă',
  'common.col.path': 'Cale',
  'common.col.duration': 'Durată',
  'common.col.project': 'Proiect',
  'common.col.ticket': 'Tichet',
  'common.col.channel': 'Canal',
  'common.col.template': 'Șablon',
  'common.col.recipient': 'Destinatar',
};

const BTN: Record<string, string> = {
  'New Chat': 'ai.action.newChat',
  'Create Collection': 'ai.action.createCollection',
  'Run Search': 'ai.action.runSearch',
  'Run Query': 'ai.action.runQuery',
  'Generate Schema': 'ai.action.generateSchema',
  'Apply Schema': 'ai.action.applySchema',
  'Add Provider': 'ai.action.addProvider',
  'Send Message': 'ai.action.sendMessage',
  'Compose': 'communications.mail.compose',
  'Send': 'common.send',
  'Sync': 'common.sync',
  'Test Connection': 'common.testConnection',
  'Generate': 'common.generate',
  'Download': 'common.download',
  'Upload': 'common.upload',
  'Revoke': 'common.revoke',
  'Publish': 'common.publish',
  'Discard': 'common.discard',
  'Approve': 'common.approve',
  'Reject': 'common.reject',
  'Post': 'common.post',
  'Open': 'common.open',
  'Close session': 'operations.pos.closeSession',
  'Open session': 'operations.pos.openSession',
};

const BTN_EN: Record<string, string> = {
  'ai.action.newChat': 'New chat',
  'ai.action.createCollection': 'Create collection',
  'ai.action.runSearch': 'Run search',
  'ai.action.runQuery': 'Run query',
  'ai.action.generateSchema': 'Generate schema',
  'ai.action.applySchema': 'Apply schema',
  'ai.action.addProvider': 'Add provider',
  'ai.action.sendMessage': 'Send message',
  'communications.mail.compose': 'Compose',
  'common.send': 'Send',
  'common.sync': 'Sync',
  'common.testConnection': 'Test connection',
  'common.generate': 'Generate',
  'common.download': 'Download',
  'common.upload': 'Upload',
  'common.revoke': 'Revoke',
  'common.publish': 'Publish',
  'common.discard': 'Discard',
  'common.approve': 'Approve',
  'common.reject': 'Reject',
  'common.post': 'Post',
  'common.open': 'Open',
  'operations.pos.closeSession': 'Close session',
  'operations.pos.openSession': 'Open session',
};

const BTN_RO: Record<string, string> = {
  'ai.action.newChat': 'Chat nou',
  'ai.action.createCollection': 'Creează colecția',
  'ai.action.runSearch': 'Rulează căutarea',
  'ai.action.runQuery': 'Rulează interogarea',
  'ai.action.generateSchema': 'Generează schema',
  'ai.action.applySchema': 'Aplică schema',
  'ai.action.addProvider': 'Adaugă furnizor',
  'ai.action.sendMessage': 'Trimite mesaj',
  'communications.mail.compose': 'Compune',
  'common.send': 'Trimite',
  'common.sync': 'Sincronizează',
  'common.testConnection': 'Testează conexiunea',
  'common.generate': 'Generează',
  'common.download': 'Descarcă',
  'common.upload': 'Încarcă',
  'common.revoke': 'Revocă',
  'common.publish': 'Publică',
  'common.discard': 'Renunță',
  'common.approve': 'Aprobă',
  'common.reject': 'Respinge',
  'common.post': 'Înregistrează',
  'common.open': 'Deschide',
  'operations.pos.closeSession': 'Închide sesiunea',
  'operations.pos.openSession': 'Deschide sesiunea',
};

Object.assign(en, TH_EN, BTN_EN);
for (const [k, v] of Object.entries({ ...TH_EN, ...BTN_EN })) {
  if (!ro[k]) ro[k] = (TH_RO as Record<string, string>)[k] ?? (BTN_RO as Record<string, string>)[k] ?? v;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === '+page.svelte') out.push(p);
  }
  return out;
}

let n = 0;
for (const p of walk(EXT_ROOT)) {
  let c = readFileSync(p, 'utf8');
  const o = c;
  for (const [text, key] of Object.entries(TH)) {
    c = c.replaceAll(`<th>${text}</th>`, `<th>{m['${key}']()}</th>`);
    c = c.replaceAll(`<th class="text-right">${text}</th>`, `<th class="text-right">{m['${key}']()}</th>`);
  }
  for (const [text, key] of Object.entries(BTN)) {
    const mCall = `m['${key}']()`;
    if (c.includes(mCall)) continue;
    c = c.replaceAll(`>${text}<`, `>{${mCall}}<`);
  }
  if (c !== o) {
    writeFileSync(p, c);
    n++;
  }
}

writeFileSync(EN_PATH, JSON.stringify(en, null, 2) + '\n');
writeFileSync(RO_PATH, JSON.stringify(ro, null, 2) + '\n');
console.log(`[i18n-pass-2] ${n} pages updated`);
