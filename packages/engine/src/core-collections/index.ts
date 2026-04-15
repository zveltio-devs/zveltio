/**
 * Core collections — single source of truth.
 *
 * These are the universal entities (contacts, organizations, transactions) that
 * extensions can reference via foreign keys. They are created through the same
 * DDLManager.createCollection() path that the Studio UI uses, so there is exactly
 * one way a collection comes into existence — installer or UI, same code path,
 * same system columns, same FTS triggers, same metadata row.
 *
 * Why not create them in a SQL migration?
 *   Migrations running raw CREATE TABLE bypass DDLManager, leaving zvd_collections
 *   with fields=[] and Studio hammering the API trying to discover the schema.
 *   Concurrent creates also race on shared trigger functions. Going through
 *   DDLManager removes both failure modes.
 *
 * Idempotent: ensureCoreCollections() skips any collection whose table already
 * exists (upgraded installs), so it's safe to run on every boot.
 */
import type { Database } from '../db/index.js';
import { DDLManager, CollectionSchema, type CollectionDefinition } from '../lib/ddl-manager.js';
import { sql } from 'kysely';
import { z } from 'zod';

/**
 * Input shape — omits fields that Zod fills in via `.default()` so call sites
 * aren't forced to spell them out. CollectionSchema.parse() adds them at runtime.
 */
type CoreCollectionInput = z.input<typeof CollectionSchema>;

/**
 * Definition for `contacts` — individual people (CRM primitive).
 * Note: `address` is free-form JSON; per-country address schemas live in extensions.
 */
const contacts: CoreCollectionInput = {
  name: 'contacts',
  displayName: 'Contacts',
  icon: 'Users',
  isSystem: true,
  isManaged: true,
  schemaLocked: false, // admins may ADD columns; core columns cannot be removed
  fields: [
    { name: 'first_name', type: 'text', required: true, label: 'First name' },
    { name: 'last_name', type: 'text', required: true, label: 'Last name' },
    { name: 'email', type: 'email', required: false, indexed: true, label: 'Email' },
    { name: 'phone', type: 'text', required: false, label: 'Phone' },
    { name: 'company', type: 'text', required: false, indexed: true, label: 'Company' },
    { name: 'job_title', type: 'text', required: false, label: 'Job title' },
    { name: 'avatar_url', type: 'text', required: false, label: 'Avatar URL' },
    { name: 'address', type: 'json', required: false, label: 'Address' },
    { name: 'tags', type: 'tags', required: false, label: 'Tags' },
    { name: 'notes', type: 'richtext', required: false, label: 'Notes' },
    { name: 'source', type: 'text', required: false, label: 'Source' },
    { name: 'external_id', type: 'text', required: false, label: 'External ID' },
    { name: 'metadata', type: 'json', required: false, label: 'Metadata' },
  ],
};

const organizations: CoreCollectionInput = {
  name: 'organizations',
  displayName: 'Organizations',
  icon: 'Building2',
  isSystem: true,
  isManaged: true,
  schemaLocked: false,
  fields: [
    { name: 'name', type: 'text', required: true, indexed: true, label: 'Name' },
    { name: 'legal_name', type: 'text', required: false, label: 'Legal name' },
    { name: 'tax_id', type: 'text', required: false, indexed: true, label: 'Tax ID' },
    { name: 'registration_no', type: 'text', required: false, label: 'Registration number' },
    {
      name: 'type',
      type: 'enum',
      required: false,
      label: 'Type',
      defaultValue: 'company',
      options: { values: ['company', 'nonprofit', 'government', 'individual'] },
    },
    { name: 'industry', type: 'text', required: false, label: 'Industry' },
    { name: 'website', type: 'text', required: false, label: 'Website' },
    { name: 'email', type: 'email', required: false, label: 'Email' },
    { name: 'phone', type: 'text', required: false, label: 'Phone' },
    { name: 'address', type: 'json', required: false, label: 'Address' },
    { name: 'billing_address', type: 'json', required: false, label: 'Billing address' },
    { name: 'logo_url', type: 'text', required: false, label: 'Logo URL' },
    { name: 'tags', type: 'tags', required: false, label: 'Tags' },
    { name: 'metadata', type: 'json', required: false, label: 'Metadata' },
    { name: 'is_active', type: 'boolean', required: true, defaultValue: true, label: 'Active' },
  ],
};

/**
 * Transactions — invoices, payments, credit notes, expenses, transfers.
 *
 * Historical note: the old SQL migration overrode the system `status` column
 * with a domain-specific CHECK (draft/pending/completed/cancelled/refunded).
 * That conflicted with the generic DDLManager contract (active/draft/archived).
 * We now keep `status` generic and use a dedicated `payment_status` enum for
 * invoice lifecycle — cleaner separation, no special cases in DDLManager.
 */
const transactions: CoreCollectionInput = {
  name: 'transactions',
  displayName: 'Transactions',
  icon: 'Receipt',
  isSystem: true,
  isManaged: true,
  schemaLocked: false,
  fields: [
    {
      name: 'type',
      type: 'enum',
      required: true,
      label: 'Type',
      options: { values: ['invoice', 'payment', 'credit_note', 'expense', 'transfer', 'other'] },
    },
    {
      name: 'payment_status',
      type: 'enum',
      required: true,
      label: 'Payment status',
      defaultValue: 'draft',
      options: { values: ['draft', 'pending', 'completed', 'cancelled', 'refunded'] },
    },
    { name: 'number', type: 'text', required: false, indexed: true, label: 'Number' },
    { name: 'organization_id', type: 'uuid', required: false, indexed: true, label: 'Organization' },
    { name: 'contact_id', type: 'uuid', required: false, label: 'Contact' },
    { name: 'currency', type: 'text', required: true, defaultValue: 'RON', label: 'Currency' },
    { name: 'amount', type: 'number', required: true, defaultValue: 0, label: 'Amount' },
    { name: 'tax_amount', type: 'number', required: true, defaultValue: 0, label: 'Tax amount' },
    { name: 'total_amount', type: 'number', required: true, defaultValue: 0, label: 'Total amount' },
    { name: 'due_date', type: 'date', required: false, label: 'Due date' },
    { name: 'paid_date', type: 'date', required: false, label: 'Paid date' },
    { name: 'line_items', type: 'json', required: true, label: 'Line items' },
    { name: 'notes', type: 'richtext', required: false, label: 'Notes' },
    { name: 'reference', type: 'text', required: false, label: 'Reference' },
    { name: 'metadata', type: 'json', required: false, label: 'Metadata' },
  ],
};

export const CORE_COLLECTIONS: CoreCollectionInput[] = [
  contacts,
  organizations,
  transactions,
];

/**
 * Creates the core collections through DDLManager if they don't already exist.
 * Idempotent — safe to call on every boot.
 *
 * Also creates the contact↔organization junction table and registers it in
 * zvd_relations. The junction lives here (not in DDLManager) because m2m
 * junctions are a separate concern from collection creation.
 */
export async function ensureCoreCollections(db: Database): Promise<void> {
  let created = 0;
  for (const def of CORE_COLLECTIONS) {
    if (await DDLManager.tableExists(db, def.name)) continue;
    try {
      // Cast: CoreCollectionInput is the pre-default shape; CollectionSchema.parse()
      // inside createCollection() materialises the defaults (unique=false, etc).
      await DDLManager.createCollection(db, def as CollectionDefinition);
      created++;
      console.log(`   ✨ Core collection '${def.name}' created via DDLManager`);
    } catch (err) {
      // If creation fails mid-way (e.g. lock timeout), the next boot retries.
      // We log but don't throw — one broken core collection shouldn't block engine startup.
      console.error(`   ⚠  Failed to create core collection '${def.name}':`, err);
    }
  }
  if (created > 0) {
    console.log(`   ✅ Core collections bootstrap: ${created} created`);
  }

  await ensureContactOrganizationJunction(db);
}

/**
 * m2m junction linking contacts and organizations.
 *
 * DDLManager doesn't model junctions as first-class collections (they have no
 * zvd_collections row), so we create the table + relation row manually. Both
 * operations are idempotent.
 */
async function ensureContactOrganizationJunction(db: Database): Promise<void> {
  const contactsExists = await DDLManager.tableExists(db, 'contacts');
  const orgsExists = await DDLManager.tableExists(db, 'organizations');
  if (!contactsExists || !orgsExists) return; // nothing to link yet

  await sql`
    CREATE TABLE IF NOT EXISTS zvd_contact_organizations (
      contact_id      UUID    NOT NULL REFERENCES zvd_contacts(id) ON DELETE CASCADE,
      organization_id UUID    NOT NULL REFERENCES zvd_organizations(id) ON DELETE CASCADE,
      role            TEXT,
      is_primary      BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (contact_id, organization_id)
    )
  `.execute(db);

  // Register in zvd_relations so Studio knows how to navigate the link.
  // ON CONFLICT avoids duplicate row on subsequent boots.
  await sql`
    INSERT INTO zvd_relations (name, type, source_collection, source_field, target_collection, target_field, junction_table, on_delete, on_update)
    VALUES ('contact_organizations', 'm2m', 'contacts', 'id', 'organizations', 'id', 'zvd_contact_organizations', 'CASCADE', 'CASCADE')
    ON CONFLICT (source_collection, source_field) DO NOTHING
  `.execute(db);
}
