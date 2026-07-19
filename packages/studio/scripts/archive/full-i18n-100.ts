#!/usr/bin/env bun
/**
 * Push extension UI toward 100% Paraglide coverage:
 * - Global string → key map (shared + per-domain)
 * - Table headers, labels, placeholders, toasts, confirms
 * - Auto-keys for remaining label-text / h2/h3 / empty rows (per extension)
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';

const STUDIO = join(import.meta.dir, '..');
const EXT_ROOT = join(STUDIO, '../../../zveltio-extensions');
const EN_PATH = join(STUDIO, 'messages/en.json');
const RO_PATH = join(STUDIO, 'messages/ro.json');

const en = JSON.parse(readFileSync(EN_PATH, 'utf8')) as Record<string, string>;
const ro = JSON.parse(readFileSync(RO_PATH, 'utf8')) as Record<string, string>;

/** Global replacements: exact English → message key */
const GLOBAL: Record<string, string> = {
  Save: 'common.save',
  Cancel: 'common.cancel',
  Delete: 'common.delete',
  Edit: 'common.edit',
  Refresh: 'common.refresh',
  Create: 'common.create',
  Submit: 'common.submit',
  Close: 'common.close',
  Actions: 'common.actions',
  Status: 'common.col.status',
  Name: 'common.col.name',
  Type: 'common.col.type',
  Date: 'common.col.date',
  Email: 'common.col.email',
  Description: 'common.col.description',
  Amount: 'common.col.amount',
  Total: 'common.col.total',
  Notes: 'common.col.notes',
  Active: 'common.col.active',
  Code: 'common.col.code',
  'All statuses': 'common.filter.allStatuses',
  All: 'common.filter.all',
  Pending: 'common.status.pending',
  Approved: 'common.status.approved',
  Rejected: 'common.status.rejected',
  Draft: 'common.status.draft',
  'Quote created.': 'finance.quotes.toast.created',
  'Delete this quote?': 'finance.quotes.deleteConfirm',
  'Delete rule?': 'developer.validation.confirmDelete',
  'Cancel this approval request?': 'workflow.approvals.confirmCancel',
  'Delete this time entry?': 'hr.timeTracking.confirmDelete',
  'Delete this geofence?': 'geospatial.postgis.confirmDelete',
  'Delete profile?': 'developer.byod.confirmDelete',
  'Revoke token?': 'developer.apiDocs.confirmRevoke',
  'Delete this page?': 'content.pageBuilder.confirmDelete',
  'Discard draft?': 'content.drafts.confirmDiscard',
  'Delete this document?': 'content.documents.confirmDelete',
  'Delete this checklist?': 'workflow.checklists.confirmDelete',
  'Delete this function?': 'developer.edgeFunctions.confirmDelete',
  'Delete connection?': 'integrations.apiConnector.confirmDelete',
  'Delete view?': 'developer.views.confirmDelete',
  'Delete this product?': 'ecommerce.store.confirmDeleteProduct',
  'Delete this asset?': 'operations.assets.confirmDelete',
  'Delete this transaction?': 'crm.transactions.confirmDelete',
  'Delete this organization?': 'crm.organizations.confirmDelete',
  'Delete this contact?': 'crm.contacts.confirmDelete',
  'Uploaded.': 'storage.cloud.toast.uploaded',
  'Cancelled.': 'workflow.approvals.toast.cancelled',
  'Ticket resolved.': 'projects.helpdesk.toast.resolved',
  'Session opened.': 'operations.pos.toast.sessionOpened',
  'Session closed.': 'operations.pos.toast.sessionClosed',
  'Timer started.': 'hr.timeTracking.toast.started',
  'Timer stopped.': 'hr.timeTracking.toast.stopped',
  'Form deleted.': 'forms.toast.deleted',
  'Order updated.': 'ecommerce.store.toast.orderUpdated',
  'Token generated.': 'developer.apiDocs.toast.tokenGenerated',
  'Revoked.': 'developer.apiDocs.toast.revoked',
  'Page saved.': 'content.pageBuilder.toast.saved',
  'Draft published.': 'content.drafts.toast.published',
  'Discarded.': 'content.drafts.toast.discarded',
  'Document generated.': 'content.documents.toast.generated',
  'Link copied.': 'ext.linkCopied',
  'Request fulfilled.': 'compliance.gdpr.toast.fulfilled',
  'Request rejected.': 'compliance.gdpr.toast.rejected',
  'Checklist saved.': 'workflow.checklists.toast.saved',
  'Connection created.': 'integrations.apiConnector.toast.created',
  'Period created.': 'hr.payroll.toast.periodCreated',
  'Entries generated.': 'hr.payroll.toast.entriesGenerated',
  'View created.': 'developer.views.toast.created',
  'Asset created.': 'operations.assets.toast.created',
  'SAML configuration saved.': 'auth.saml.toast.saved',
  'LDAP configuration saved.': 'auth.ldap.toast.saved',
  'Copied to clipboard.': 'ext.copied',
  'Connection successful!': 'auth.ldap.toast.connectionOk',
  'Index configured.': 'search.toast.indexConfigured',
  'Phone number is required': 'sms.error.phoneRequired',
  'Body or template is required': 'sms.error.bodyRequired',
  'Variables must be valid JSON': 'sms.error.variablesJson',
  'Name and body are required': 'sms.error.nameBodyRequired',
  'Collection and index name are required': 'search.error.indexRequired',
  'Failed to update form: ': 'forms.error.updatePrefix',
  'Failed: ': 'ext.errorPrefix',
  'Sync failed: ': 'search.error.syncPrefix',
  'Error: ': 'ext.errorPrefix',
  'Search failed': 'ai.error.searchFailed',
  'Trimite SAF-T la ANAF?': 'compliance.ro.saft.confirmSend',
  'Sterge exportul?': 'compliance.ro.saft.confirmDeleteExport',
  'Sterge contul?': 'compliance.ro.saft.confirmDeleteAccount',
  'Sterge inregistrarea?': 'compliance.ro.saft.confirmDeleteEntry',
  'Trimite declaratia la ANAF e-Transport?': 'compliance.ro.etransport.confirmSend',
  'Anuleaza declaratia?': 'compliance.ro.etransport.confirmCancel',
  'Sterge declaratia?': 'compliance.ro.etransport.confirmDelete',
  'Trimite factura la ANAF e-Factura?': 'compliance.ro.efactura.confirmSend',
  'Sterge factura?': 'compliance.ro.efactura.confirmDelete',
  'Marchează documentul ca semnat?': 'compliance.ro.documents.confirmSign',
  'Șterge documentul?': 'compliance.ro.documents.confirmDelete',
  'Export creat.': 'compliance.ro.saft.toast.exportCreated',
  'SAF-T XML generat!': 'compliance.ro.saft.toast.xmlGenerated',
  'Genereaza XML mai intai': 'compliance.ro.saft.error.generateXmlFirst',
  'Trimis la ANAF!': 'compliance.ro.saft.toast.sentAnaf',
  'Cont adaugat.': 'compliance.ro.saft.toast.accountAdded',
  'Inregistrare adaugata.': 'compliance.ro.saft.toast.entryAdded',
  'Declaratie creata.': 'compliance.ro.etransport.toast.created',
  'Document creat.': 'compliance.ro.documents.toast.created',
  'Factura creata.': 'compliance.ro.efactura.toast.created',
  'XML generat! Foloseste Download pentru fisier.': 'compliance.ro.efactura.toast.xmlGenerated',
  'Comanda creata.': 'compliance.ro.procurement.toast.orderCreated',
  'Furnizor inregistrat.': 'compliance.ro.procurement.toast.vendorRegistered',
  'Eliberați lotul din carantină?': 'operations.traceability.confirmReleaseLot',
  'Anulați expedierea?': 'operations.traceability.confirmCancelDispatch',
  Chat: 'ai.tab.chat',
  'Semantic Search': 'ai.tab.search',
  'NL → SQL': 'ai.tab.query',
  'Schema Gen': 'ai.tab.schema',
  Templates: 'ai.tab.templates',
  Settings: 'ai.tab.settings',
  To: 'common.col.to',
  Cc: 'common.col.cc',
  Bcc: 'common.col.bcc',
  Message: 'common.col.message',
  Host: 'common.col.host',
  Port: 'common.col.port',
  Username: 'common.col.username',
  Password: 'common.col.password',
  'Account Name': 'communications.mail.label.accountName',
  'Email Address': 'common.col.email',
  'Display Name': 'communications.mail.label.displayName',
  'Signature HTML': 'communications.mail.label.signatureHtml',
  'Set as default': 'communications.mail.label.setDefault',
  'Set as default account': 'communications.mail.label.setDefaultAccount',
  'Filter Name': 'communications.mail.label.filterName',
  'Use SSL/TLS': 'communications.mail.label.useSsl',
  Mail: 'communications.mail.tab.mail',
  Drafts: 'communications.mail.tab.drafts',
  Contacts: 'communications.mail.tab.contacts',
  Signatures: 'communications.mail.tab.signatures',
  Filters: 'communications.mail.tab.filters',
  'Delete this file?': 'storage.cloud.confirmDeleteFile',
};

const GLOBAL_EN: Record<string, string> = {
  'finance.quotes.toast.created': 'Quote created.',
  'finance.quotes.deleteConfirm': 'Delete this quote?',
  'developer.validation.confirmDelete': 'Delete rule?',
  'workflow.approvals.confirmCancel': 'Cancel this approval request?',
  'hr.timeTracking.confirmDelete': 'Delete this time entry?',
  'geospatial.postgis.confirmDelete': 'Delete this geofence?',
  'developer.byod.confirmDelete': 'Delete profile?',
  'developer.apiDocs.confirmRevoke': 'Revoke token?',
  'content.pageBuilder.confirmDelete': 'Delete this page?',
  'content.drafts.confirmDiscard': 'Discard draft?',
  'content.documents.confirmDelete': 'Delete this document?',
  'workflow.checklists.confirmDelete': 'Delete this checklist?',
  'developer.edgeFunctions.confirmDelete': 'Delete this function?',
  'integrations.apiConnector.confirmDelete': 'Delete connection?',
  'developer.views.confirmDelete': 'Delete view?',
  'ecommerce.store.confirmDeleteProduct': 'Delete this product?',
  'operations.assets.confirmDelete': 'Delete this asset?',
  'crm.transactions.confirmDelete': 'Delete this transaction?',
  'crm.organizations.confirmDelete': 'Delete this organization?',
  'crm.contacts.confirmDelete': 'Delete this contact?',
  'storage.cloud.toast.uploaded': 'Uploaded.',
  'workflow.approvals.toast.cancelled': 'Cancelled.',
  'projects.helpdesk.toast.resolved': 'Ticket resolved.',
  'operations.pos.toast.sessionOpened': 'Session opened.',
  'operations.pos.toast.sessionClosed': 'Session closed.',
  'hr.timeTracking.toast.started': 'Timer started.',
  'hr.timeTracking.toast.stopped': 'Timer stopped.',
  'forms.toast.deleted': 'Form deleted.',
  'ecommerce.store.toast.orderUpdated': 'Order updated.',
  'developer.apiDocs.toast.tokenGenerated': 'Token generated.',
  'developer.apiDocs.toast.revoked': 'Revoked.',
  'content.pageBuilder.toast.saved': 'Page saved.',
  'content.drafts.toast.published': 'Draft published.',
  'content.drafts.toast.discarded': 'Discarded.',
  'content.documents.toast.generated': 'Document generated.',
  'ext.linkCopied': 'Link copied.',
  'compliance.gdpr.toast.fulfilled': 'Request fulfilled.',
  'compliance.gdpr.toast.rejected': 'Request rejected.',
  'workflow.checklists.toast.saved': 'Checklist saved.',
  'integrations.apiConnector.toast.created': 'Connection created.',
  'hr.payroll.toast.periodCreated': 'Period created.',
  'hr.payroll.toast.entriesGenerated': 'Entries generated.',
  'developer.views.toast.created': 'View created.',
  'operations.assets.toast.created': 'Asset created.',
  'auth.saml.toast.saved': 'SAML configuration saved.',
  'auth.ldap.toast.saved': 'LDAP configuration saved.',
  'ext.copied': 'Copied to clipboard.',
  'auth.ldap.toast.connectionOk': 'Connection successful!',
  'search.toast.indexConfigured': 'Index configured.',
  'sms.error.phoneRequired': 'Phone number is required',
  'sms.error.bodyRequired': 'Body or template is required',
  'sms.error.variablesJson': 'Variables must be valid JSON',
  'sms.error.nameBodyRequired': 'Name and body are required',
  'search.error.indexRequired': 'Collection and index name are required',
  'forms.error.updatePrefix': 'Failed to update form: ',
  'ext.errorPrefix': 'Failed: ',
  'search.error.syncPrefix': 'Sync failed: ',
  'ai.error.searchFailed': 'Search failed',
  'compliance.ro.saft.confirmSend': 'Send SAF-T to ANAF?',
  'compliance.ro.saft.confirmDeleteExport': 'Delete export?',
  'compliance.ro.saft.confirmDeleteAccount': 'Delete account?',
  'compliance.ro.saft.confirmDeleteEntry': 'Delete entry?',
  'compliance.ro.etransport.confirmSend': 'Send declaration to ANAF e-Transport?',
  'compliance.ro.etransport.confirmCancel': 'Cancel declaration?',
  'compliance.ro.etransport.confirmDelete': 'Delete declaration?',
  'compliance.ro.efactura.confirmSend': 'Send invoice to ANAF e-Factura?',
  'compliance.ro.efactura.confirmDelete': 'Delete invoice?',
  'compliance.ro.documents.confirmSign': 'Mark document as signed?',
  'compliance.ro.documents.confirmDelete': 'Delete document?',
  'compliance.ro.saft.toast.exportCreated': 'Export created.',
  'compliance.ro.saft.toast.xmlGenerated': 'SAF-T XML generated!',
  'compliance.ro.saft.error.generateXmlFirst': 'Generate XML first',
  'compliance.ro.saft.toast.sentAnaf': 'Sent to ANAF!',
  'compliance.ro.saft.toast.accountAdded': 'Account added.',
  'compliance.ro.saft.toast.entryAdded': 'Entry added.',
  'compliance.ro.etransport.toast.created': 'Declaration created.',
  'compliance.ro.documents.toast.created': 'Document created.',
  'compliance.ro.efactura.toast.created': 'Invoice created.',
  'compliance.ro.efactura.toast.xmlGenerated': 'XML generated! Use Download for the file.',
  'compliance.ro.procurement.toast.orderCreated': 'Order created.',
  'compliance.ro.procurement.toast.vendorRegistered': 'Vendor registered.',
  'operations.traceability.confirmReleaseLot': 'Release lot from quarantine?',
  'operations.traceability.confirmCancelDispatch': 'Cancel dispatch?',
  'ai.tab.chat': 'Chat',
  'ai.tab.search': 'Semantic Search',
  'ai.tab.query': 'NL → SQL',
  'ai.tab.schema': 'Schema Gen',
  'ai.tab.templates': 'Templates',
  'ai.tab.settings': 'Settings',
  'common.col.cc': 'Cc',
  'common.col.bcc': 'Bcc',
  'common.col.message': 'Message',
  'common.col.host': 'Host',
  'common.col.port': 'Port',
  'common.col.username': 'Username',
  'common.col.password': 'Password',
  'communications.mail.label.accountName': 'Account name',
  'communications.mail.label.displayName': 'Display name',
  'communications.mail.label.signatureHtml': 'Signature HTML',
  'communications.mail.label.setDefault': 'Set as default',
  'communications.mail.label.setDefaultAccount': 'Set as default account',
  'communications.mail.label.filterName': 'Filter name',
  'communications.mail.label.useSsl': 'Use SSL/TLS',
  'communications.mail.tab.mail': 'Mail',
  'communications.mail.tab.drafts': 'Drafts',
  'communications.mail.tab.contacts': 'Contacts',
  'communications.mail.tab.signatures': 'Signatures',
  'communications.mail.tab.filters': 'Filters',
  'storage.cloud.confirmDeleteFile': 'Delete this file?',
};

const GLOBAL_RO: Record<string, string> = {
  'finance.quotes.toast.created': 'Ofertă creată.',
  'finance.quotes.deleteConfirm': 'Ștergi această ofertă?',
  'developer.validation.confirmDelete': 'Ștergi regula?',
  'workflow.approvals.confirmCancel': 'Anulezi cererea de aprobare?',
  'hr.timeTracking.confirmDelete': 'Ștergi această înregistrare de timp?',
  'geospatial.postgis.confirmDelete': 'Ștergi acest geofence?',
  'developer.byod.confirmDelete': 'Ștergi profilul?',
  'developer.apiDocs.confirmRevoke': 'Revoci tokenul?',
  'content.pageBuilder.confirmDelete': 'Ștergi această pagină?',
  'content.drafts.confirmDiscard': 'Renunți la ciornă?',
  'content.documents.confirmDelete': 'Ștergi acest document?',
  'workflow.checklists.confirmDelete': 'Ștergi această listă?',
  'developer.edgeFunctions.confirmDelete': 'Ștergi această funcție?',
  'integrations.apiConnector.confirmDelete': 'Ștergi conexiunea?',
  'developer.views.confirmDelete': 'Ștergi vizualizarea?',
  'ecommerce.store.confirmDeleteProduct': 'Ștergi acest produs?',
  'operations.assets.confirmDelete': 'Ștergi acest activ?',
  'crm.transactions.confirmDelete': 'Ștergi această tranzacție?',
  'crm.organizations.confirmDelete': 'Ștergi această organizație?',
  'crm.contacts.confirmDelete': 'Ștergi acest contact?',
  'storage.cloud.toast.uploaded': 'Încărcat.',
  'workflow.approvals.toast.cancelled': 'Anulat.',
  'projects.helpdesk.toast.resolved': 'Tichet rezolvat.',
  'operations.pos.toast.sessionOpened': 'Sesiune deschisă.',
  'operations.pos.toast.sessionClosed': 'Sesiune închisă.',
  'hr.timeTracking.toast.started': 'Cronometru pornit.',
  'hr.timeTracking.toast.stopped': 'Cronometru oprit.',
  'forms.toast.deleted': 'Formular șters.',
  'ecommerce.store.toast.orderUpdated': 'Comandă actualizată.',
  'developer.apiDocs.toast.tokenGenerated': 'Token generat.',
  'developer.apiDocs.toast.revoked': 'Revocat.',
  'content.pageBuilder.toast.saved': 'Pagină salvată.',
  'content.drafts.toast.published': 'Ciornă publicată.',
  'content.drafts.toast.discarded': 'Renunțat.',
  'content.documents.toast.generated': 'Document generat.',
  'ext.linkCopied': 'Link copiat.',
  'compliance.gdpr.toast.fulfilled': 'Cerere îndeplinită.',
  'compliance.gdpr.toast.rejected': 'Cerere respinsă.',
  'workflow.checklists.toast.saved': 'Listă salvată.',
  'integrations.apiConnector.toast.created': 'Conexiune creată.',
  'hr.payroll.toast.periodCreated': 'Perioadă creată.',
  'hr.payroll.toast.entriesGenerated': 'Înregistrări generate.',
  'developer.views.toast.created': 'Vizualizare creată.',
  'operations.assets.toast.created': 'Activ creat.',
  'auth.saml.toast.saved': 'Configurare SAML salvată.',
  'auth.ldap.toast.saved': 'Configurare LDAP salvată.',
  'ext.copied': 'Copiat în clipboard.',
  'auth.ldap.toast.connectionOk': 'Conexiune reușită!',
  'search.toast.indexConfigured': 'Index configurat.',
  'sms.error.phoneRequired': 'Numărul de telefon este obligatoriu',
  'sms.error.bodyRequired': 'Conținutul sau șablonul este obligatoriu',
  'sms.error.variablesJson': 'Variabilele trebuie să fie JSON valid',
  'sms.error.nameBodyRequired': 'Numele și conținutul sunt obligatorii',
  'search.error.indexRequired': 'Colecția și numele indexului sunt obligatorii',
  'forms.error.updatePrefix': 'Actualizarea formularului a eșuat: ',
  'ext.errorPrefix': 'Eșec: ',
  'search.error.syncPrefix': 'Sincronizarea a eșuat: ',
  'ai.error.searchFailed': 'Căutarea a eșuat',
  'compliance.ro.saft.confirmSend': 'Trimite SAF-T la ANAF?',
  'compliance.ro.saft.confirmDeleteExport': 'Ștergi exportul?',
  'compliance.ro.saft.confirmDeleteAccount': 'Ștergi contul?',
  'compliance.ro.saft.confirmDeleteEntry': 'Ștergi înregistrarea?',
  'compliance.ro.etransport.confirmSend': 'Trimite declarația la ANAF e-Transport?',
  'compliance.ro.etransport.confirmCancel': 'Anulezi declarația?',
  'compliance.ro.etransport.confirmDelete': 'Ștergi declarația?',
  'compliance.ro.efactura.confirmSend': 'Trimite factura la ANAF e-Factura?',
  'compliance.ro.efactura.confirmDelete': 'Ștergi factura?',
  'compliance.ro.documents.confirmSign': 'Marchezi documentul ca semnat?',
  'compliance.ro.documents.confirmDelete': 'Ștergi documentul?',
  'compliance.ro.saft.toast.exportCreated': 'Export creat.',
  'compliance.ro.saft.toast.xmlGenerated': 'XML SAF-T generat!',
  'compliance.ro.saft.error.generateXmlFirst': 'Generează XML mai întâi',
  'compliance.ro.saft.toast.sentAnaf': 'Trimis la ANAF!',
  'compliance.ro.saft.toast.accountAdded': 'Cont adăugat.',
  'compliance.ro.saft.toast.entryAdded': 'Înregistrare adăugată.',
  'compliance.ro.etransport.toast.created': 'Declarație creată.',
  'compliance.ro.documents.toast.created': 'Document creat.',
  'compliance.ro.efactura.toast.created': 'Factură creată.',
  'compliance.ro.efactura.toast.xmlGenerated': 'XML generat! Folosește Descărcare pentru fișier.',
  'compliance.ro.procurement.toast.orderCreated': 'Comandă creată.',
  'compliance.ro.procurement.toast.vendorRegistered': 'Furnizor înregistrat.',
  'operations.traceability.confirmReleaseLot': 'Eliberezi lotul din carantină?',
  'operations.traceability.confirmCancelDispatch': 'Anulezi expedierea?',
  'ai.tab.chat': 'Chat',
  'ai.tab.search': 'Căutare semantică',
  'ai.tab.query': 'NL → SQL',
  'ai.tab.schema': 'Generare schemă',
  'ai.tab.templates': 'Șabloane',
  'ai.tab.settings': 'Setări',
  'common.col.cc': 'Cc',
  'common.col.bcc': 'Bcc',
  'common.col.message': 'Mesaj',
  'common.col.host': 'Host',
  'common.col.port': 'Port',
  'common.col.username': 'Utilizator',
  'common.col.password': 'Parolă',
  'communications.mail.label.accountName': 'Nume cont',
  'communications.mail.label.displayName': 'Nume afișat',
  'communications.mail.label.signatureHtml': 'Semnătură HTML',
  'communications.mail.label.setDefault': 'Setează implicit',
  'communications.mail.label.setDefaultAccount': 'Cont implicit',
  'communications.mail.label.filterName': 'Nume filtru',
  'communications.mail.label.useSsl': 'Folosește SSL/TLS',
  'communications.mail.tab.mail': 'Mail',
  'communications.mail.tab.drafts': 'Ciorne',
  'communications.mail.tab.contacts': 'Contacte',
  'communications.mail.tab.signatures': 'Semnături',
  'communications.mail.tab.filters': 'Filtre',
  'storage.cloud.confirmDeleteFile': 'Ștergi acest fișier?',
};

Object.assign(en, GLOBAL_EN);
for (const [k, v] of Object.entries(GLOBAL_EN)) {
  if (!ro[k]) ro[k] = GLOBAL_RO[k] ?? v;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[*…]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48);
}

function extKeyFromPath(filePath: string): string {
  const rel = relative(EXT_ROOT, filePath).replace(/\\/g, '/');
  const m = rel.match(/^(.+?)\/studio\/pages\//);
  return m ? m[1].replace(/\//g, '.') : 'ext';
}

function walkPages(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkPages(p, out);
    else if (e.name === '+page.svelte') out.push(p);
  }
  return out;
}

function ensureMImport(c: string): string {
  if (c.includes("from '$lib/i18n")) return c;
  if (!c.includes("m['") && !c.includes('m[')) return c;
  return c.replace(
    /<script lang="ts">\n/,
    '<script lang="ts">\n  import { m } from \'$lib/i18n.svelte.js\';\n',
  );
}

function applyGlobal(c: string): string {
  let out = c;
  for (const [text, key] of Object.entries(GLOBAL)) {
    const mCall = `m['${key}']()`;
    if (out.includes(mCall)) continue;
    out = out.replaceAll(`>${text}<`, `>{${mCall}}<`);
    out = out.replaceAll(`'${text}'`, mCall);
    out = out.replaceAll(`"${text}"`, mCall);
    out = out.replaceAll(`confirm('${text}')`, `confirm(${mCall})`);
    out = out.replaceAll(`toast.success('${text}')`, `toast.success(${mCall})`);
    out = out.replaceAll(`toast.error('${text}')`, `toast.error(${mCall})`);
  }
  return out;
}

/** Auto-key label-text and simple headings not yet using m */
function autoKeyLabels(c: string, extKey: string): { content: string; added: number } {
  let added = 0;
  const patterns: RegExp[] = [
    /<span class="label-text(?: text-(?:xs|sm))?">([^<{][^<]{2,80})<\/span>/g,
    /<label class="label"><span class="label-text">([^<{][^<]{2,80})<\/span>/g,
    /<h2 class="[^"]*">([^<{][^<]{2,80})<\/h2>/g,
    /<h3 class="[^"]*">([^<{][^<]{2,80})<\/h3>/g,
    /<p class="text-lg font-semibold">([^<{][^<]{2,80})<\/p>/g,
    /<p class="text-sm text-center max-w-sm">([^<{][^<]{4,120})<\/p>/g,
    /<option value="[^"]*">([^<{][^<]{2,60})<\/option>/g,
    /<option>([^<{][^<]{2,60})<\/option>/g,
    /placeholder="([^"{][^"]{2,80})"/g,
    /<button[^>]*class="[^"]*btn[^"]*"[^>]*>([^<{][^<]{2,50})<\/button>/g,
    /<summary class="[^"]*">([^<{][^<]{2,60})<\/summary>/g,
    /<td colspan="\d+" class="[^"]*">([^<{][^<]{4,100})<\/td>/g,
  ];

  let out = c;
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(c))) {
      const text = m[1].trim();
      if (!text || text.includes('{') || /^[\d\s]+$/.test(text)) continue;
      if (/^(btn-|loading |✓|—|\?)$/.test(text)) continue;
      if (/^[A-Z_]{2,}$/.test(text.replace(/\s/g, ''))) continue; // SKU, API codes
      if (GLOBAL[text]) continue;
      if (en[text]) continue;
      const existingKey = Object.entries(en).find(([, v]) => v === text)?.[0];
      if (existingKey) {
        const mCall = `m['${existingKey}']()`;
        const full = m[0];
        if (!out.includes(full.replace(text, `{${mCall}}`))) {
          out = out.replace(full, full.replace(text, `{${mCall}}`));
        }
        continue;
      }
      const key = `${extKey}.ui.${slug(text)}`;
      if (en[key]) continue;
      en[key] = text;
      ro[key] = translateRo(text);
      added++;
      const mCall = `m['${key}']()`;
      const replacement = m[0].includes('placeholder="')
        ? m[0].replace(`placeholder="${text}"`, `placeholder={${mCall}}`)
        : m[0].replace(text, `{${mCall}}`);
      out = out.replaceAll(m[0], replacement);
    }
    c = out;
  }
  return { content: out, added };
}

function translateRo(text: string): string {
  const exact: Record<string, string> = {
    'New Chat': 'Chat nou',
    Send: 'Trimite',
    Add: 'Adaugă',
    Remove: 'Elimină',
    Upload: 'Încarcă',
    Download: 'Descarcă',
    'Search…': 'Caută…',
    'No data yet.': 'Nicio dată încă.',
    'Loading…': 'Se încarcă…',
  };
  if (exact[text]) return exact[text];
  let t = text;
  const words: [RegExp, string][] = [
    [/^New /, ''],
    [/Delete /, 'Șterge '],
    [/Create /, 'Creează '],
    [/Add /, 'Adaugă '],
    [/Save/, 'Salvează'],
    [/Cancel/, 'Anulează'],
    [/Search/, 'Caută'],
    [/Settings/, 'Setări'],
    [/Template/, 'Șablon'],
    [/Provider/, 'Furnizor'],
    [/Configuration/, 'Configurare'],
    [/required/, 'obligatoriu'],
    [/failed/, 'eșuat'],
    [/created/, 'creat'],
    [/updated/, 'actualizat'],
    [/deleted/, 'șters'],
  ];
  for (const [re, rep] of words) t = t.replace(re, rep);
  if (t === text && /^[A-Za-z]/.test(text)) {
    // Title-case heuristic for short labels
    if (text.length < 40 && !text.includes('.')) return text; // keep brand/technical
  }
  return t !== text ? t : text;
}

function patchAiTabs(c: string): string {
  if (!c.includes('AI_TABS') || c.includes('labelKey')) return c;
  return c
    .replace(
      /const AI_TABS[^=]+=\s*\[[\s\S]*?\];/,
      `const AI_TABS: Array<{ id: typeof activeTab; labelKey: string; icon: any }> = [
    { id: 'chat', labelKey: 'ai.tab.chat', icon: MessageSquare },
    { id: 'search', labelKey: 'ai.tab.search', icon: Search },
    { id: 'query', labelKey: 'ai.tab.query', icon: Code2 },
    { id: 'schema', labelKey: 'ai.tab.schema', icon: Wand2 },
    { id: 'templates', labelKey: 'ai.tab.templates', icon: BookTemplate },
    { id: 'settings', labelKey: 'ai.tab.settings', icon: Settings2 },
  ];`,
    )
    .replaceAll('{tab.label}', '{m[tab.labelKey]()}')
    .replaceAll('>{tab.label}<', '>{m[tab.labelKey]()}<');
}

function patchToastPatterns(c: string): string {
  return c
    .replace(/toast\.success\('([^']+)'\)/g, (_, msg) => {
      const key = GLOBAL[msg] ?? Object.entries(GLOBAL_EN).find(([, v]) => v === msg)?.[0];
      if (key) return `toast.success(m['${key}']())`;
      if (/created/i.test(msg)) return "toast.success(m['ext.created']())";
      if (/saved/i.test(msg)) return "toast.success(m['ext.saved']())";
      if (/deleted/i.test(msg)) return "toast.success(m['ext.deleted']())";
      return `toast.success('${msg}')`;
    })
    .replace(/toast\.error\('([^']+)'\s*\+\s*/g, (_, prefix) => {
      const key = GLOBAL[prefix] ?? 'ext.errorPrefix';
      return `toast.error(m['${key}']() + `;
    })
    .replace(/toast\.error\('Error: '\s*\+\s*/g, "toast.error(m['ext.errorPrefix']() + ");
}

let files = 0;
let autoAdded = 0;

for (const pagePath of walkPages(join(EXT_ROOT))) {
  let c = readFileSync(pagePath, 'utf8');
  const orig = c;
  const extKey = extKeyFromPath(pagePath);

  c = ensureMImport(c);
  c = applyGlobal(c);
  c = patchToastPatterns(c);
  c = patchAiTabs(c);
  const { content, added } = autoKeyLabels(c, extKey);
  c = content;
  autoAdded += added;

  if (c !== orig) {
    writeFileSync(pagePath, c);
    files++;
  }
}

writeFileSync(EN_PATH, JSON.stringify(en, null, 2) + '\n');
writeFileSync(RO_PATH, JSON.stringify(ro, null, 2) + '\n');
console.log(`[full-i18n-100] ${files} files patched, ${autoAdded} auto keys added`);
