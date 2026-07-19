#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const STUDIO = join(import.meta.dir, '..');
const EXT = join(STUDIO, '../../../zveltio-extensions');
const EN_PATH = join(STUDIO, 'messages/en.json');
const RO_PATH = join(STUDIO, 'messages/ro.json');

const en = JSON.parse(readFileSync(EN_PATH, 'utf8')) as Record<string, string>;
const ro = JSON.parse(readFileSync(RO_PATH, 'utf8')) as Record<string, string>;

const KEYS: Record<string, { en: string; ro: string }> = {
  // Mail errors
  'communications.mail.error.load': { en: 'Failed to load', ro: 'Încărcarea a eșuat' },
  'communications.mail.error.folders': {
    en: 'Failed to load folders',
    ro: 'Încărcarea folderelor a eșuat',
  },
  'communications.mail.error.messages': {
    en: 'Failed to load messages',
    ro: 'Încărcarea mesajelor a eșuat',
  },
  'communications.mail.error.message': {
    en: 'Failed to load message',
    ro: 'Încărcarea mesajului a eșuat',
  },
  'communications.mail.error.sync': { en: 'Sync failed', ro: 'Sincronizarea a eșuat' },
  'communications.mail.error.send': { en: 'Failed to send', ro: 'Trimiterea a eșuat' },
  'communications.mail.error.failed': { en: 'Failed', ro: 'Eșec' },
  'communications.mail.error.addAccount': {
    en: 'Failed to add account',
    ro: 'Adăugarea contului a eșuat',
  },
  'communications.mail.ui.markRead': { en: 'Mark read', ro: 'Marchează citit' },
  'communications.mail.ui.markUnread': { en: 'Mark unread', ro: 'Marchează necitit' },
  'communications.mail.ui.star': { en: 'Star', ro: 'Stea' },
  'communications.mail.ui.spam': { en: 'Spam', ro: 'Spam' },
  'communications.mail.ui.noMessages': { en: 'No messages', ro: 'Niciun mesaj' },
  'communications.mail.ui.fromLabel': { en: 'From:', ro: 'De la:' },
  'communications.mail.ui.toLabel': { en: 'To:', ro: 'Către:' },
  'communications.mail.ui.highPriority': { en: 'High priority', ro: 'Prioritate ridicată' },
  'communications.mail.ui.summarize': { en: 'Summarize', ro: 'Rezumat' },
  'communications.mail.ui.aiReply': { en: 'AI Reply', ro: 'Răspuns AI' },
  'communications.mail.ui.loading': { en: 'Loading...', ro: 'Se încarcă...' },
  'communications.mail.ui.attachments': { en: 'Attachments', ro: 'Atașamente' },
  'communications.mail.ui.emailBody': { en: 'Email body', ro: 'Conținut email' },
  'communications.mail.ui.addImapHint': {
    en: 'Add an IMAP/SMTP account to get started.',
    ro: 'Adaugă un cont IMAP/SMTP pentru a începe.',
  },
  'communications.mail.ui.selectMessage': { en: 'Select a message', ro: 'Selectează un mesaj' },
  'communications.mail.ui.company': { en: 'Company', ro: 'Companie' },
  'communications.mail.ui.frequency': { en: 'Frequency', ro: 'Frecvență' },
  'communications.mail.ui.defaultBadge': { en: 'Default', ro: 'Implicit' },
  'communications.mail.ui.editSignature': { en: 'Edit signature', ro: 'Editează semnătura' },
  'communications.mail.ui.newSignature': { en: 'New signature', ro: 'Semnătură nouă' },
  'communications.mail.ui.noSignatures': { en: 'No signatures yet.', ro: 'Nicio semnătură încă.' },
  'communications.mail.ui.selectAccountFilters': {
    en: 'Select a mail account first to manage filters.',
    ro: 'Selectează mai întâi un cont de mail pentru filtre.',
  },
  'communications.mail.ui.disabled': { en: 'Disabled', ro: 'Dezactivat' },
  'communications.mail.ui.noFilters': {
    en: 'No filters configured.',
    ro: 'Niciun filtru configurat.',
  },
  'communications.mail.ui.conditionsAll': {
    en: 'Conditions (all must match)',
    ro: 'Condiții (toate trebuie îndeplinite)',
  },
  'communications.mail.ui.addCondition': { en: 'Add condition', ro: 'Adaugă condiție' },
  'communications.mail.ui.addAction': { en: 'Add action', ro: 'Adaugă acțiune' },
  'communications.mail.ui.reply': { en: 'Reply', ro: 'Răspunde' },
  'communications.mail.ui.replyAll': { en: 'Reply all', ro: 'Răspunde tuturor' },
  'communications.mail.ui.forward': { en: 'Forward', ro: 'Redirecționează' },
  'communications.mail.ui.newMessage': { en: 'New message', ro: 'Mesaj nou' },
  'communications.mail.ui.draftSaved': { en: 'Draft saved', ro: 'Ciornă salvată' },
  'communications.mail.ui.noSubject': { en: '(no subject)', ro: '(fără subiect)' },
  'communications.mail.ui.readReceipt': { en: 'Read receipt', ro: 'Confirmare citire' },
  'communications.mail.ui.noDrafts': { en: 'No drafts saved.', ro: 'Nicio ciornă salvată.' },
  'communications.mail.ui.addAccount': { en: 'Add account', ro: 'Adaugă cont' },
  'communications.mail.ui.sync': { en: 'Sync', ro: 'Sincronizează' },
  'communications.mail.ui.selectedCount': { en: '{count} selected', ro: '{count} selectate' },
  'communications.mail.ui.priority': { en: 'Priority:', ro: 'Prioritate:' },
  'communications.mail.ui.imapIncoming': { en: 'IMAP (Incoming)', ro: 'IMAP (intrare)' },
  'communications.mail.ui.smtpOutgoing': { en: 'SMTP (Outgoing)', ro: 'SMTP (ieșire)' },
  'communications.mail.ui.downloadEml': { en: 'Download .eml', ro: 'Descarcă .eml' },
  'communications.mail.ui.newFilter': { en: 'New filter', ro: 'Filtru nou' },
  'communications.mail.ui.conditionCount': { en: '{n} condition(s) →', ro: '{n} condiție(ii) →' },
  // Traceability — lots list
  'operations.traceability.lots.title': { en: 'Lots', ro: 'Loturi' },
  'operations.traceability.lots.newReception': { en: 'New reception', ro: 'Recepție nouă' },
  'operations.traceability.col.lotNumber': { en: 'Lot number', ro: 'Număr lot' },
  'operations.traceability.col.product': { en: 'Product', ro: 'Produs' },
  'operations.traceability.col.supplier': { en: 'Supplier', ro: 'Furnizor' },
  'operations.traceability.col.qtyRemaining': { en: 'Qty remaining', ro: 'Cant. rămasă' },
  'operations.traceability.col.expiry': { en: 'Expiry', ro: 'Valabilitate' },
  'operations.traceability.col.location': { en: 'Location', ro: 'Locație' },
  'operations.traceability.action.details': { en: 'Details', ro: 'Detalii' },
  'operations.traceability.pageOf': {
    en: 'Page {page} of {total}',
    ro: 'Pagina {page} din {total}',
  },
  // Reception
  'operations.traceability.reception.title': {
    en: 'Raw material reception',
    ro: 'Recepție materie primă',
  },
  'operations.traceability.reception.success': {
    en: 'Lot created successfully:',
    ro: 'Lot creat cu succes:',
  },
  'operations.traceability.reception.quarantineHint': {
    en: 'Initial status: quarantine. Release the lot after verification.',
    ro: 'Statusul inițial: carantină. Eliberați lotul după verificare.',
  },
  'operations.traceability.reception.lotDetails': { en: 'Lot details', ro: 'Detalii lot' },
  'operations.traceability.reception.printLabel': { en: 'Print label', ro: 'Printează etichetă' },
  'operations.traceability.form.product': { en: 'Product *', ro: 'Produs *' },
  'operations.traceability.form.quantity': { en: 'Quantity *', ro: 'Cantitate *' },
  'operations.traceability.form.unit': { en: 'Unit *', ro: 'Unitate *' },
  'operations.traceability.form.supplier': { en: 'Supplier', ro: 'Furnizor' },
  'operations.traceability.form.supplierLot': { en: 'Supplier lot', ro: 'Lot furnizor' },
  'operations.traceability.form.bbd': { en: 'Best before (BBD)', ro: 'Data valabilitate (BBD)' },
  'operations.traceability.form.receptionDate': { en: 'Reception date *', ro: 'Data recepție *' },
  'operations.traceability.form.invoice': { en: 'Invoice / delivery note', ro: 'Factură / Aviz' },
  'operations.traceability.form.location': { en: 'Location', ro: 'Locație' },
  'operations.traceability.form.notes': { en: 'Notes', ro: 'Note' },
  'operations.traceability.form.saving': { en: 'Saving...', ro: 'Se salvează...' },
  'operations.traceability.form.submit': {
    en: 'Save and create lot',
    ro: 'Salvează și creează lot',
  },
  'operations.traceability.ui.parseaz': { en: 'Parse', ro: 'Parsează' },
  // Reports
  'operations.traceability.reports.title': { en: 'Reports', ro: 'Rapoarte' },
  'operations.traceability.reports.report': { en: 'Report', ro: 'Raport' },
  'operations.traceability.reports.from': { en: 'From', ro: 'De la' },
  'operations.traceability.reports.to': { en: 'To', ro: 'Până la' },
  // Recalls
  'operations.traceability.recalls.title': {
    en: 'Product recall',
    ro: 'Recall / Retragere produs',
  },
  'operations.traceability.recalls.confirm': {
    en: 'Confirm triggering a REAL recall ({scope})?',
    ro: 'Confirmați declanșarea unui recall REAL ({scope})?',
  },
  'operations.traceability.recalls.affectedLots': { en: 'Affected lots', ro: 'Loturi afectate' },
  'operations.traceability.recalls.affectedClients': {
    en: 'Affected clients',
    ro: 'Clienți afectați',
  },
  'operations.traceability.recalls.affectedDeliveries': {
    en: 'Affected deliveries',
    ro: 'Livrări afectate',
  },
  'operations.traceability.recalls.finishedLots': {
    en: 'Affected finished lots',
    ro: 'Loturi finite afectate',
  },
  'operations.traceability.recalls.warning': {
    en: 'This will mark all affected lots as "recalled" and create an official file.',
    ro: 'Aceasta va marca toate loturile afectate ca "recalled" și va crea un dosar oficial.',
  },
  'operations.traceability.recalls.reason': { en: 'Recall reason *', ro: 'Motiv recall *' },
  'operations.traceability.recalls.type': { en: 'Recall type', ro: 'Tip recall' },
  'operations.traceability.recalls.noneActive': {
    en: 'No active recalls',
    ro: 'Niciun recall activ',
  },
  // Production
  'operations.traceability.production.title': {
    en: 'Production orders',
    ro: 'Ordine de producție',
  },
  'operations.traceability.production.finishedProduct': {
    en: 'Finished product *',
    ro: 'Produs finit *',
  },
  'operations.traceability.production.recipe': { en: 'Recipe (optional)', ro: 'Rețetă (opțional)' },
  'operations.traceability.production.plannedQty': {
    en: 'Planned quantity *',
    ro: 'Cantitate planificată *',
  },
  'operations.traceability.production.col.number': { en: 'Number', ro: 'Număr' },
  'operations.traceability.production.col.finished': { en: 'Finished product', ro: 'Produs finit' },
  'operations.traceability.production.col.qty': { en: 'Qty', ro: 'Cant.' },
  'operations.traceability.production.consume': {
    en: 'Record raw material consumption',
    ro: 'Înregistrare consum materie primă',
  },
  'operations.traceability.production.haccp': {
    en: 'CCP check (HACCP)',
    ro: 'Verificare CCP (HACCP)',
  },
  // Dispatches
  'operations.traceability.dispatches.title': { en: 'Dispatches', ro: 'Expedieri' },
  'operations.traceability.dispatches.lot': { en: 'Lot *', ro: 'Lot *' },
  'operations.traceability.dispatches.qty': { en: 'Quantity *', ro: 'Cantitate *' },
  'operations.traceability.dispatches.um': { en: 'UoM', ro: 'UM' },
  'operations.traceability.dispatches.client': { en: 'Client *', ro: 'Client *' },
  'operations.traceability.dispatches.invoice': {
    en: 'Invoice / note no. (optional)',
    ro: 'Nr. factură / aviz (opțional)',
  },
  'operations.traceability.dispatches.col.client': { en: 'Client', ro: 'Client' },
  'operations.traceability.dispatches.col.productLot': { en: 'Product / Lot', ro: 'Produs / Lot' },
  'operations.traceability.dispatches.col.invoicedQty': {
    en: 'Invoiced qty',
    ro: 'Cant. facturată',
  },
  'operations.traceability.dispatches.col.invoice': { en: 'Invoice', ro: 'Factură' },
  'operations.traceability.dispatches.billedProduct': {
    en: 'Product (invoiced)',
    ro: 'Produs (facturat)',
  },
  'operations.traceability.dispatches.expiry': { en: 'Expiry', ro: 'Valabilitate' },
  'operations.traceability.dispatches.availableInLot': {
    en: 'Available in lot',
    ro: 'Disponibil în lot',
  },
  'operations.traceability.dispatches.invoicedQtyLabel': {
    en: 'Invoiced quantity',
    ro: 'Cantitate facturată',
  },
  'operations.traceability.dispatches.dispatchedQty': {
    en: 'Dispatched quantity',
    ro: 'Cantitate expediată',
  },
  'operations.traceability.dispatches.confirmedAt': { en: 'Confirmed at', ro: 'Confirmat la' },
  // Lot detail
  'operations.traceability.lot.tab.info': { en: 'Information', ro: 'Informații' },
  'operations.traceability.lot.tab.tree': { en: 'Traceability tree', ro: 'Arbore trasabilitate' },
  'operations.traceability.lot.tab.timeline': { en: 'Timeline', ro: 'Cronologie' },
  'operations.traceability.lot.label.name': { en: 'Name:', ro: 'Denumire:' },
  'operations.traceability.lot.label.code': { en: 'Code:', ro: 'Cod:' },
  'operations.traceability.lot.label.type': { en: 'Type:', ro: 'Tip:' },
  'operations.traceability.lot.label.allergens': { en: 'Allergens:', ro: 'Alergeni:' },
  'operations.traceability.lot.label.conditions': { en: 'Conditions:', ro: 'Condiții:' },
  'operations.traceability.lot.label.initial': { en: 'Initial:', ro: 'Inițial:' },
  'operations.traceability.lot.label.remaining': { en: 'Remaining:', ro: 'Rămas:' },
  'operations.traceability.lot.label.bbd': { en: 'BBD:', ro: 'BBD:' },
  'operations.traceability.lot.label.productionDate': {
    en: 'Production date:',
    ro: 'Data producție:',
  },
  'operations.traceability.lot.label.receptionDate': {
    en: 'Reception date:',
    ro: 'Data recepție:',
  },
  'operations.traceability.lot.label.cui': { en: 'Tax ID:', ro: 'CUI:' },
  'operations.traceability.lot.label.supplierLot': { en: 'Supplier lot:', ro: 'Lot furnizor:' },
  'operations.traceability.lot.label.invoice': { en: 'Invoice:', ro: 'Factură:' },
  'operations.traceability.lot.label.row': { en: 'Row:', ro: 'Rând:' },
  'operations.traceability.lot.label.shelf': { en: 'Shelf:', ro: 'Raft:' },
  'operations.traceability.lot.label.zone': { en: 'Zone:', ro: 'Zonă:' },
  'operations.traceability.lot.col.datetime': { en: 'Date/Time', ro: 'Data/Ora' },
  'operations.traceability.lot.col.type': { en: 'Type', ro: 'Tip' },
  'operations.traceability.lot.col.quantity': { en: 'Quantity', ro: 'Cantitate' },
  'operations.traceability.lot.col.reference': { en: 'Reference', ro: 'Referință' },
};

for (const [k, v] of Object.entries(KEYS)) {
  en[k] = v.en;
  ro[k] = v.ro;
}

const MAIL_REPL: [string, string][] = [
  [
    "toast.error(e.message ?? 'Failed to load')",
    "toast.error(e.message ?? m['communications.mail.error.load']())",
  ],
  [
    "toast.error(e.message ?? 'Failed to load folders')",
    "toast.error(e.message ?? m['communications.mail.error.folders']())",
  ],
  [
    "toast.error(e.message ?? 'Failed to load messages')",
    "toast.error(e.message ?? m['communications.mail.error.messages']())",
  ],
  [
    "toast.error(e.message ?? 'Failed to load message')",
    "toast.error(e.message ?? m['communications.mail.error.message']())",
  ],
  [
    "toast.error(e.message ?? 'Sync failed')",
    "toast.error(e.message ?? m['communications.mail.error.sync']())",
  ],
  [
    "toast.error(e.message ?? 'Failed to send')",
    "toast.error(e.message ?? m['communications.mail.error.send']())",
  ],
  [
    "toast.error(e.message ?? 'Failed')",
    "toast.error(e.message ?? m['communications.mail.error.failed']())",
  ],
  [
    "toast.error(e.message ?? 'Failed to add account')",
    "toast.error(e.message ?? m['communications.mail.error.addAccount']())",
  ],
  ['>Mark read<', ">{m['communications.mail.ui.markRead']()}<"],
  ['>Mark unread<', ">{m['communications.mail.ui.markUnread']()}<"],
  ['>Star<', ">{m['communications.mail.ui.star']()}<"],
  ['>Spam<', ">{m['communications.mail.ui.spam']()}<"],
  [
    '<p class="text-sm">No messages</p>',
    '<p class="text-sm">{m[\'communications.mail.ui.noMessages\']()}</p>',
  ],
  ['From: <strong>', "{m['communications.mail.ui.fromLabel']()} <strong>"],
  ['<span>To: {', "<span>{m['communications.mail.ui.toLabel']()} {"],
  ['>High priority<', ">{m['communications.mail.ui.highPriority']()}<"],
  ['title="Reply"', "title={m['communications.mail.ui.reply']()}"],
  ['title="Reply All"', "title={m['communications.mail.ui.replyAll']()}"],
  ['title="Forward"', "title={m['communications.mail.ui.forward']()}"],
  ['title="Download .eml"', "title={m['communications.mail.ui.downloadEml']()}"],
  [' Summarize', " {m['communications.mail.ui.summarize']()}"],
  [' AI Reply', " {m['communications.mail.ui.aiReply']()}"],
  ['title="Email body"', "title={m['communications.mail.ui.emailBody']()}"],
  [' Loading...', " {m['communications.mail.ui.loading']()}"],
  [' Attachments</p>', " {m['communications.mail.ui.attachments']()}</p>"],
  [
    '<p class="text-sm">Add an IMAP/SMTP account to get started.</p>',
    '<p class="text-sm">{m[\'communications.mail.ui.addImapHint\']()}</p>',
  ],
  ['<p>Select a message</p>', "<p>{m['communications.mail.ui.selectMessage']()}</p>"],
  ['<th>Company</th>', "<th>{m['communications.mail.ui.company']()}</th>"],
  ['<th>Frequency</th>', "<th>{m['communications.mail.ui.frequency']()}</th>"],
  [
    '<span class="label-text text-sm">Name</span>',
    '<span class="label-text text-sm">{m[\'common.col.name\']()}</span>',
  ],
  ["'Edit Signature'", "m['communications.mail.ui.editSignature']()"],
  ["'New Signature'", "m['communications.mail.ui.newSignature']()"],
  ['>Default</span>', ">{m['communications.mail.ui.defaultBadge']()}</span>"],
  ['No signatures yet.', "m['communications.mail.ui.noSignatures']()"],
  [
    'Select a mail account first to manage filters.',
    "m['communications.mail.ui.selectAccountFilters']()",
  ],
  ['>Disabled</span>', ">{m['communications.mail.ui.disabled']()}</span>"],
  [' No filters configured.', " {m['communications.mail.ui.noFilters']()}"],
  ['Conditions (all must match)', "m['communications.mail.ui.conditionsAll']()"],
  [' Add Condition', " {m['communications.mail.ui.addCondition']()}"],
  [' Add Action', " {m['communications.mail.ui.addAction']()}"],
  ["'Reply'", "m['communications.mail.ui.reply']()"],
  ["'New Message'", "m['communications.mail.ui.newMessage']()"],
  ['Draft saved', "m['communications.mail.ui.draftSaved']()"],
  ["'(no subject)'", "m['communications.mail.ui.noSubject']()"],
  [' Read receipt', " {m['communications.mail.ui.readReceipt']()}"],
  [' Priority:', " {m['communications.mail.ui.priority']()}"],
  [' No drafts saved.', " {m['communications.mail.ui.noDrafts']()}"],
  [
    '<Mail class="w-4 h-4" /> Mail',
    '<Mail class="w-4 h-4" /> {m[\'communications.mail.tab.mail\']()}',
  ],
  ['title="Sync"', "title={m['communications.mail.ui.sync']()}"],
  ['title="Add Account"', "title={m['communications.mail.ui.addAccount']()}"],
  [
    '<Send class="w-3 h-3" /> Compose',
    '<Send class="w-3 h-3" /> {m[\'communications.mail.compose\']()}',
  ],
  [' Actions <', " {m['common.actions']()} <"],
  [
    '<span class="text-xs text-base-content/60">{selectedIds.size} selected</span>',
    '<span class="text-xs text-base-content/60">{m[\'communications.mail.ui.selectedCount\']({ count: selectedIds.size })}</span>',
  ],
  [
    '<Plus class="w-4 h-4" /> Add Account</button>',
    '<Plus class="w-4 h-4" /> {m[\'communications.mail.ui.addAccount\']()}</button>',
  ],
  [
    '<div class="divider text-xs">IMAP (Incoming)</div>',
    '<div class="divider text-xs">{m[\'communications.mail.ui.imapIncoming\']()}</div>',
  ],
  [
    '<div class="divider text-xs">SMTP (Outgoing)</div>',
    '<div class="divider text-xs">{m[\'communications.mail.ui.smtpOutgoing\']()}</div>',
  ],
  [
    '<span class="label-text text-sm">Email Address</span>',
    '<span class="label-text text-sm">{m[\'common.col.email\']()}</span>',
  ],
  [
    '<Plus class="w-3 h-3" /> New</button>',
    '<Plus class="w-3 h-3" /> {m[\'common.new\']()}</button>',
  ],
  [
    '<Plus class="w-3 h-3" /> New Filter</button>',
    '<Plus class="w-3 h-3" /> {m[\'communications.mail.ui.newFilter\']()}</button>',
  ],
  ['{/if} Send', "{/if} {m['common.send']()}"],
  ["aria-label=m['common.close']()", "aria-label={m['common.close']()}"],
  [
    "<option value=\"{m['communications.mail.ui.{m['communications.mail.ui.{m['communications.mail.ui.{m['communications.mail.ui.{m['communications.mail.ui.{m['communications.mail.ui.{m['communications.mail.ui.contains']()}']()}']()}']()}']()}']()}']()}']()}']()\">contains</option>",
    '<option value="contains">{m[\'communications.mail.ui.contains\']()}</option>',
  ],
];

function patchMail() {
  const p = join(EXT, 'communications/mail/studio/pages/+page.svelte');
  let c = readFileSync(p, 'utf8');
  for (const [a, b] of MAIL_REPL) c = c.replaceAll(a, b);
  writeFileSync(p, c);
  console.log('[mail] patched');
}

function dedupeTraceLots() {
  const p = join(EXT, 'operations/traceability/studio/pages/+page.svelte');
  let c = readFileSync(p, 'utf8');
  const marker = '{#if error}';
  const first = c.indexOf(marker);
  const second = c.indexOf(marker, first + 10);
  if (second > 0) c = c.slice(0, second).trimEnd() + '\n';
  c = c
    .replace(
      '<h1 class="text-2xl font-bold">Loturi</h1>',
      '<h1 class="text-2xl font-bold">{m[\'operations.traceability.lots.title\']()}</h1>',
    )
    .replace('+ Recepție nouă', "+ {m['operations.traceability.lots.newReception']()}")
    .replaceAll('<th>Număr lot</th>', "<th>{m['operations.traceability.col.lotNumber']()}</th>")
    .replaceAll('<th>Produs</th>', "<th>{m['operations.traceability.col.product']()}</th>")
    .replaceAll('<th>Furnizor</th>', "<th>{m['operations.traceability.col.supplier']()}</th>")
    .replaceAll(
      '<th>Cant. rămasă</th>',
      "<th>{m['operations.traceability.col.qtyRemaining']()}</th>",
    )
    .replaceAll('<th>Valabilitate</th>', "<th>{m['operations.traceability.col.expiry']()}</th>")
    .replaceAll('<th>Locație</th>', "<th>{m['operations.traceability.col.location']()}</th>")
    .replaceAll('>Detalii</a>', ">{m['operations.traceability.action.details']()}</a>")
    .replace(
      /Pagina \{page\} din \{totalPages\}/g,
      "{m['operations.traceability.pageOf']({ page: String(page), total: String(totalPages) })}",
    );
  writeFileSync(p, c);
  console.log('[trace lots] patched');
}

function patchReception() {
  const p = join(EXT, 'operations/traceability/studio/pages/reception/+page.svelte');
  let c = readFileSync(p, 'utf8');
  const R: [string, string][] = [
    [
      '<h1 class="text-2xl font-bold mb-6">Recepție materie primă</h1>',
      '<h1 class="text-2xl font-bold mb-6">{m[\'operations.traceability.reception.title\']()}</h1>',
    ],
    ['Lot creat cu succes:', "{m['operations.traceability.reception.success']()}"],
    [
      'Statusul inițial: carantină. Eliberați lotul după verificare.',
      "{m['operations.traceability.reception.quarantineHint']()}",
    ],
    ['>Detalii lot</a>', ">{m['operations.traceability.reception.lotDetails']()}</a>"],
    ['🖨 Printează etichetă', "{m['operations.traceability.reception.printLabel']()}"],
    [
      '<span class="label-text font-medium">Produs *</span>',
      '<span class="label-text font-medium">{m[\'operations.traceability.form.product\']()}</span>',
    ],
    [
      '<span class="label-text font-medium">Cantitate *</span>',
      '<span class="label-text font-medium">{m[\'operations.traceability.form.quantity\']()}</span>',
    ],
    [
      '<span class="label-text font-medium">Unitate *</span>',
      '<span class="label-text font-medium">{m[\'operations.traceability.form.unit\']()}</span>',
    ],
    [
      '<span class="label-text font-medium">Furnizor</span>',
      '<span class="label-text font-medium">{m[\'operations.traceability.form.supplier\']()}</span>',
    ],
    [
      '<span class="label-text font-medium">Lot furnizor</span>',
      '<span class="label-text font-medium">{m[\'operations.traceability.form.supplierLot\']()}</span>',
    ],
    [
      '<span class="label-text font-medium">Data valabilitate (BBD)</span>',
      '<span class="label-text font-medium">{m[\'operations.traceability.form.bbd\']()}</span>',
    ],
    [
      '<span class="label-text font-medium">Data recepție *</span>',
      '<span class="label-text font-medium">{m[\'operations.traceability.form.receptionDate\']()}</span>',
    ],
    [
      '<span class="label-text font-medium">Factură / Aviz</span>',
      '<span class="label-text font-medium">{m[\'operations.traceability.form.invoice\']()}</span>',
    ],
    [
      '<span class="label-text font-medium">Locație</span>',
      '<span class="label-text font-medium">{m[\'operations.traceability.form.location\']()}</span>',
    ],
    [
      '<span class="label-text font-medium">Note</span>',
      '<span class="label-text font-medium">{m[\'operations.traceability.form.notes\']()}</span>',
    ],
    ['>Anulează</a>', ">{m['common.cancel']()}</a>"],
    [
      "{saving ? 'Se salvează...' : 'Salvează și creează lot'}",
      "{saving ? m['operations.traceability.form.saving']() : m['operations.traceability.form.submit']()}",
    ],
  ];
  for (const [a, b] of R) c = c.replaceAll(a, b);
  writeFileSync(p, c);
}

function patchFile(path: string, reps: [string, string][]) {
  if (!existsSync(path)) return;
  let c = readFileSync(path, 'utf8');
  for (const [a, b] of reps) c = c.replaceAll(a, b);
  writeFileSync(path, c);
}

patchMail();
dedupeTraceLots();
patchReception();

patchFile(join(EXT, 'operations/traceability/studio/pages/recalls/+page.svelte'), [
  [
    '<h1 class="text-2xl font-bold">Recall / Retragere produs</h1>',
    '<h1 class="text-2xl font-bold">{m[\'operations.traceability.recalls.title\']()}</h1>',
  ],
  [
    'if (!confirm(`Confirmați declanșarea unui recall REAL (${initiateForm.scope})?`))',
    "if (!confirm(m['operations.traceability.recalls.confirm']({ scope: initiateForm.scope })))",
  ],
  [
    '<div class="text-sm">Loturi afectate</div>',
    '<div class="text-sm">{m[\'operations.traceability.recalls.affectedLots\']()}</div>',
  ],
  [
    '<div class="text-sm">Clienți afectați</div>',
    '<div class="text-sm">{m[\'operations.traceability.recalls.affectedClients\']()}</div>',
  ],
  [
    '<div class="text-sm">Livrări afectate</div>',
    '<div class="text-sm">{m[\'operations.traceability.recalls.affectedDeliveries\']()}</div>',
  ],
  [
    '<h4 class="font-semibold mb-2">Loturi finite afectate</h4>',
    '<h4 class="font-semibold mb-2">{m[\'operations.traceability.recalls.finishedLots\']()}</h4>',
  ],
  [
    'Aceasta va marca toate loturile afectate ca "recalled" și va crea un dosar oficial.',
    "{m['operations.traceability.recalls.warning']()}",
  ],
  [
    '<label class="label-text font-medium">Motiv recall *</label>',
    '<label class="label-text font-medium">{m[\'operations.traceability.recalls.reason\']()}</label>',
  ],
  [
    '<label class="label-text font-medium">Tip recall</label>',
    '<label class="label-text font-medium">{m[\'operations.traceability.recalls.type\']()}</label>',
  ],
  [
    '<div class="text-center opacity-50 py-12">Niciun recall activ</div>',
    '<div class="text-center opacity-50 py-12">{m[\'operations.traceability.recalls.noneActive\']()}</div>',
  ],
  ['>Anulează</button>', ">{m['common.cancel']()}</button>"],
]);

patchFile(join(EXT, 'operations/traceability/studio/pages/production/+page.svelte'), [
  [
    '<h1 class="text-2xl font-bold">Ordine de producție</h1>',
    '<h1 class="text-2xl font-bold">{m[\'operations.traceability.production.title\']()}</h1>',
  ],
  [
    '<label class="label-text font-medium">Produs finit *</label>',
    '<label class="label-text font-medium">{m[\'operations.traceability.production.finishedProduct\']()}</label>',
  ],
  [
    '<label class="label-text">Rețetă (opțional)</label>',
    '<label class="label-text">{m[\'operations.traceability.production.recipe\']()}</label>',
  ],
  [
    '<label class="label-text">Cantitate planificată *</label>',
    '<label class="label-text">{m[\'operations.traceability.production.plannedQty\']()}</label>',
  ],
  ['<th>Număr</th>', "<th>{m['operations.traceability.production.col.number']()}</th>"],
  ['<th>Produs finit</th>', "<th>{m['operations.traceability.production.col.finished']()}</th>"],
  ['<th>Cant.</th>', "<th>{m['operations.traceability.production.col.qty']()}</th>"],
  [
    '<h4 class="font-semibold mb-2">Înregistrare consum materie primă</h4>',
    '<h4 class="font-semibold mb-2">{m[\'operations.traceability.production.consume\']()}</h4>',
  ],
  [
    '<h4 class="font-semibold mb-2">Verificare CCP (HACCP)</h4>',
    '<h4 class="font-semibold mb-2">{m[\'operations.traceability.production.haccp\']()}</h4>',
  ],
  ['placeholder="UM"', "placeholder={m['operations.traceability.dispatches.um']()}"],
]);

patchFile(join(EXT, 'operations/traceability/studio/pages/dispatches/+page.svelte'), [
  [
    '<h1 class="text-2xl font-bold">Expedieri</h1>',
    '<h1 class="text-2xl font-bold">{m[\'operations.traceability.dispatches.title\']()}</h1>',
  ],
  [
    '<label class="label-text font-medium">Lot *</label>',
    '<label class="label-text font-medium">{m[\'operations.traceability.dispatches.lot\']()}</label>',
  ],
  [
    '<label class="label-text font-medium">Cantitate *</label>',
    '<label class="label-text font-medium">{m[\'operations.traceability.dispatches.qty\']()}</label>',
  ],
  [
    '<label class="label-text font-medium">UM</label>',
    '<label class="label-text font-medium">{m[\'operations.traceability.dispatches.um\']()}</label>',
  ],
  [
    '<label class="label-text font-medium">Client *</label>',
    '<label class="label-text font-medium">{m[\'operations.traceability.dispatches.client\']()}</label>',
  ],
  [
    '<label class="label-text font-medium">Nr. factură / aviz (opțional)</label>',
    '<label class="label-text font-medium">{m[\'operations.traceability.dispatches.invoice\']()}</label>',
  ],
  [
    '<label class="label-text font-medium">Note</label>',
    '<label class="label-text font-medium">{m[\'operations.traceability.form.notes\']()}</label>',
  ],
  ['<th>Client</th>', "<th>{m['operations.traceability.dispatches.col.client']()}</th>"],
  ['<th>Produs / Lot</th>', "<th>{m['operations.traceability.dispatches.col.productLot']()}</th>"],
  [
    '<th>Cant. facturată</th>',
    "<th>{m['operations.traceability.dispatches.col.invoicedQty']()}</th>",
  ],
  ['<th>Factură</th>', "<th>{m['operations.traceability.dispatches.col.invoice']()}</th>"],
  [
    '<span class="opacity-60">Produs (facturat)</span>',
    '<span class="opacity-60">{m[\'operations.traceability.dispatches.billedProduct\']()}</span>',
  ],
  [
    '<span class="opacity-60">Valabilitate</span>',
    '<span class="opacity-60">{m[\'operations.traceability.dispatches.expiry\']()}</span>',
  ],
  [
    '<span class="opacity-60">Disponibil în lot</span>',
    '<span class="opacity-60">{m[\'operations.traceability.dispatches.availableInLot\']()}</span>',
  ],
  [
    '<span class="opacity-60">Cantitate facturată</span>',
    '<span class="opacity-60">{m[\'operations.traceability.dispatches.invoicedQtyLabel\']()}</span>',
  ],
  [
    '<label class="label-text text-sm">Note</label>',
    '<label class="label-text text-sm">{m[\'operations.traceability.form.notes\']()}</label>',
  ],
  [
    '<span class="opacity-60">Cantitate expediată</span>',
    '<span class="opacity-60">{m[\'operations.traceability.dispatches.dispatchedQty\']()}</span>',
  ],
  [
    '<span class="opacity-60">Confirmat la</span>',
    '<span class="opacity-60">{m[\'operations.traceability.dispatches.confirmedAt\']()}</span>',
  ],
]);

const LOT_DETAIL: [string, string][] = [
  ['>Informații</button>', ">{m['operations.traceability.lot.tab.info']()}</button>"],
  ['>Arbore trasabilitate</button>', ">{m['operations.traceability.lot.tab.tree']()}</button>"],
  ['>Cronologie</button>', ">{m['operations.traceability.lot.tab.timeline']()}</button>"],
  [
    '<span class="text-sm opacity-60">Denumire:</span>',
    '<span class="text-sm opacity-60">{m[\'operations.traceability.lot.label.name\']()}</span>',
  ],
  [
    '<span class="text-sm opacity-60">Cod:</span>',
    '<span class="text-sm opacity-60">{m[\'operations.traceability.lot.label.code\']()}</span>',
  ],
  [
    '<span class="text-sm opacity-60">Tip:</span>',
    '<span class="text-sm opacity-60">{m[\'operations.traceability.lot.label.type\']()}</span>',
  ],
  [
    '<span class="text-sm opacity-60">Alergeni:</span>',
    '<span class="text-sm opacity-60">{m[\'operations.traceability.lot.label.allergens\']()}</span>',
  ],
  [
    '<span class="text-sm opacity-60">Condiții:</span>',
    '<span class="text-sm opacity-60">{m[\'operations.traceability.lot.label.conditions\']()}</span>',
  ],
  [
    '<span class="text-sm opacity-60">Inițial:</span>',
    '<span class="text-sm opacity-60">{m[\'operations.traceability.lot.label.initial\']()}</span>',
  ],
  [
    '<span class="text-sm opacity-60">Rămas:</span>',
    '<span class="text-sm opacity-60">{m[\'operations.traceability.lot.label.remaining\']()}</span>',
  ],
  [
    '<span class="text-sm opacity-60">BBD:</span>',
    '<span class="text-sm opacity-60">{m[\'operations.traceability.lot.label.bbd\']()}</span>',
  ],
  [
    '<span class="text-sm opacity-60">Data producție:</span>',
    '<span class="text-sm opacity-60">{m[\'operations.traceability.lot.label.productionDate\']()}</span>',
  ],
  [
    '<span class="text-sm opacity-60">Data recepție:</span>',
    '<span class="text-sm opacity-60">{m[\'operations.traceability.lot.label.receptionDate\']()}</span>',
  ],
  [
    '<span class="text-sm opacity-60">CUI:</span>',
    '<span class="text-sm opacity-60">{m[\'operations.traceability.lot.label.cui\']()}</span>',
  ],
  [
    '<span class="text-sm opacity-60">Lot furnizor:</span>',
    '<span class="text-sm opacity-60">{m[\'operations.traceability.lot.label.supplierLot\']()}</span>',
  ],
  [
    '<span class="text-sm opacity-60">Factură:</span>',
    '<span class="text-sm opacity-60">{m[\'operations.traceability.lot.label.invoice\']()}</span>',
  ],
  [
    '<span class="text-sm opacity-60">Rând:</span>',
    '<span class="text-sm opacity-60">{m[\'operations.traceability.lot.label.row\']()}</span>',
  ],
  [
    '<span class="text-sm opacity-60">Raft:</span>',
    '<span class="text-sm opacity-60">{m[\'operations.traceability.lot.label.shelf\']()}</span>',
  ],
  [
    '<span class="text-sm opacity-60">Zonă:</span>',
    '<span class="text-sm opacity-60">{m[\'operations.traceability.lot.label.zone\']()}</span>',
  ],
  ['<th>Data/Ora</th>', "<th>{m['operations.traceability.lot.col.datetime']()}</th>"],
  ['<th>Tip</th>', "<th>{m['operations.traceability.lot.col.type']()}</th>"],
  ['<th>Cantitate</th>', "<th>{m['operations.traceability.lot.col.quantity']()}</th>"],
  ['<th>Referință</th>', "<th>{m['operations.traceability.lot.col.reference']()}</th>"],
  ['<th>Locație</th>', "<th>{m['operations.traceability.col.location']()}</th>"],
];
patchFile(join(EXT, 'operations/traceability/studio/pages/lots/[id]/+page.svelte'), LOT_DETAIL);

// Ensure m import on trace subpages missing it
for (const rel of [
  'operations/traceability/studio/pages/reports/+page.svelte',
  'operations/traceability/studio/pages/recalls/+page.svelte',
  'operations/traceability/studio/pages/production/+page.svelte',
  'operations/traceability/studio/pages/dispatches/+page.svelte',
  'operations/traceability/studio/pages/lots/[id]/+page.svelte',
]) {
  const p = join(EXT, rel);
  if (!existsSync(p)) continue;
  let c = readFileSync(p, 'utf8');
  if (!c.includes("from '$lib/i18n")) {
    c = c.replace(
      /<script lang="ts">\n/,
      '<script lang="ts">\n  import { m } from \'$lib/i18n.svelte.js\';\n',
    );
    writeFileSync(p, c);
  }
}

patchFile(join(EXT, 'operations/traceability/studio/pages/reports/+page.svelte'), [
  [
    '<h1 class="text-2xl font-bold">Rapoarte</h1>',
    '<h1 class="text-2xl font-bold">{m[\'operations.traceability.reports.title\']()}</h1>',
  ],
  [
    '<label class="label-text text-sm">Raport</label>',
    '<label class="label-text text-sm">{m[\'operations.traceability.reports.report\']()}</label>',
  ],
  [
    '<label class="label-text text-sm">De la</label>',
    '<label class="label-text text-sm">{m[\'operations.traceability.reports.from\']()}</label>',
  ],
  [
    '<label class="label-text text-sm">Până la</label>',
    '<label class="label-text text-sm">{m[\'operations.traceability.reports.to\']()}</label>',
  ],
]);

writeFileSync(EN_PATH, JSON.stringify(en, null, 2) + '\n');
writeFileSync(RO_PATH, JSON.stringify(ro, null, 2) + '\n');
console.log(`[i18n-mail-trace] ${Object.keys(KEYS).length} keys merged`);
