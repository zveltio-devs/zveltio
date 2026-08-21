/**
 * Legacy Business OS collections — adopt only, never create.
 *
 * Contacts, organizations, and transactions belong to the `crm` extension
 * (`zveltio-extensions/crm`). Fresh bare BaaS installs must not grow those
 * tables from the engine. When CRM (or an older core install) already created
 * the tables, we still adopt: metadata, tenant RLS, default grants, and the
 * contact↔organization junction — so Studio/`/api/data/*` keep working.
 *
 * Do not remount CREATE via DDLManager here. That was the purity leak that
 * made every install a mini-CRM whether or not CRM was enabled.
 */
import type { Database } from '../db/index.js';
import { DDLManager, type CollectionDefinition } from '../lib/data/index.js';
import { sql } from 'kysely';

/**
 * Pre-default shape used by the inline core-collection literals below.
 *
 * Original implementation used `z.input<typeof CollectionSchema>` so the
 * literals could omit fields with `.default(...)` (FieldSchema's
 * `unique`, `defaultValue`, `encrypted`, etc.). That worked under
 * zod ≤4.3, but zod 4.4 narrowed `z.input` on `z.preprocess` schemas to
 * `unknown` — the wrapping preprocess function's input is `any` in the
 * declaration, and 4.4 propagates the strict `unknown` upward,
 * breaking `def.name` / `def.fields` access in the for-loop below
 * (TS18046).
 *
 * Hand-written interface preserves the original ergonomic of "optional
 * fields stay optional at the definition site" without depending on
 * zod's input-vs-output type derivation. CollectionSchema.parse()
 * inside DDLManager.createCollection() still materialises every
 * default at runtime, so behaviour is unchanged.
 */
interface CoreCollectionField {
  name: string;
  type: string;
  required?: boolean;
  label?: string;
  defaultValue?: unknown;
  unique?: boolean;
  encrypted?: boolean;
  indexed?: boolean;
  relation?: unknown;
  options?: unknown;
}
interface CoreCollectionInput {
  name: string;
  displayName?: string;
  icon?: string;
  routeGroup?: 'public' | 'partners' | 'private' | 'admin';
  isPermissioned?: boolean;
  sort?: number;
  fields: CoreCollectionField[];
  description?: string;
  singularName?: string;
  aiSearchEnabled?: boolean;
  aiSearchField?: string | null;
  isManaged?: boolean;
  isSystem?: boolean;
  schemaLocked?: boolean;
}

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
    {
      name: 'organization_id',
      type: 'uuid',
      required: false,
      indexed: true,
      label: 'Organization',
    },
    { name: 'contact_id', type: 'uuid', required: false, label: 'Contact' },
    { name: 'currency', type: 'text', required: true, defaultValue: 'RON', label: 'Currency' },
    { name: 'amount', type: 'number', required: true, defaultValue: 0, label: 'Amount' },
    { name: 'tax_amount', type: 'number', required: true, defaultValue: 0, label: 'Tax amount' },
    {
      name: 'total_amount',
      type: 'number',
      required: true,
      defaultValue: 0,
      label: 'Total amount',
    },
    { name: 'due_date', type: 'date', required: false, label: 'Due date' },
    { name: 'paid_date', type: 'date', required: false, label: 'Paid date' },
    { name: 'line_items', type: 'json', required: true, label: 'Line items' },
    { name: 'notes', type: 'richtext', required: false, label: 'Notes' },
    { name: 'reference', type: 'text', required: false, label: 'Reference' },
    { name: 'metadata', type: 'json', required: false, label: 'Metadata' },
  ],
};

export const CORE_COLLECTIONS: CoreCollectionInput[] = [contacts, organizations, transactions];

/**
 * Creates the core collections through DDLManager if they don't already exist.
 * Idempotent — safe to call on every boot.
 *
 * Also creates the contact↔organization junction table and registers it in
 * zvd_relations. The junction lives here (not in DDLManager) because m2m
 * junctions are a separate concern from collection creation.
 */
/**
 * Make an already-existing core table into a real collection.
 *
 * Everything `createCollection` does APART from the DDL: register it so the
 * Studio can see it, isolate it per tenant, and grant the standard roles their
 * default access. Each step is guarded and non-fatal on its own, because a
 * table that exists and is half-registered is still better than a boot that
 * aborts — and every one of them is idempotent, so the next boot retries
 * whatever failed.
 */
async function adoptExistingCoreCollection(db: Database, def: CoreCollectionInput): Promise<void> {
  try {
    const registered = await db
      .selectFrom('zvd_collections')
      .select('name')
      .where('name', '=', def.name)
      .executeTakeFirst();
    if (!registered) {
      await DDLManager.registerMetadata(db, def as CollectionDefinition);
      console.log(`   📇 Core collection '${def.name}' registered (table already existed)`);
    }
  } catch (err) {
    console.warn(`   ⚠  registerMetadata for '${def.name}' failed:`, (err as Error).message);
  }

  try {
    const { applyTenantRLS, materializeDefaultGrants } = await import('../lib/tenancy/index.js');
    await applyTenantRLS(db, `zvd_${def.name}`);
    const granted = await materializeDefaultGrants(db, [def.name]);
    if (granted > 0) {
      console.log(`   🔑 Core collection '${def.name}': default access granted on ${granted}`);
    }
  } catch (err) {
    console.warn(`   ⚠  isolating/granting '${def.name}' failed:`, (err as Error).message);
  }
}

export async function ensureCoreCollections(db: Database): Promise<void> {
  let adopted = 0;
  for (const def of CORE_COLLECTIONS) {
    if (!(await DDLManager.tableExists(db, def.name))) {
      // Bare BaaS: CRM not installed — do not invent CRM tables in the engine.
      continue;
    }
    // Table exists (CRM migration or legacy core create). Adopt metadata/RLS/grants.
    await adoptExistingCoreCollection(db, def);
    adopted++;
  }
  if (adopted > 0) {
    console.log(`   ✅ Legacy CRM collections: ${adopted} adopted (owned by crm extension)`);
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

  // The junction is a table like any other, and it was not isolated.
  //
  // `zvd_contacts` and `zvd_organizations` both carry tenant RLS; the table
  // linking them carried none — no policy, `rowsecurity = false`. It escaped the
  // reconcile because that walks `zvd_collections`, and a junction deliberately
  // has no row there. Nothing in the engine reads it today, so this was not
  // leaking through any route, but "no caller happens to exist" is not
  // isolation: any extension holding the raw pool can select from it, and what
  // it holds is which people belong to which organizations.
  //
  // Backfilled from the contact BEFORE the policy goes on. `applyTenantRLS`
  // assigns existing rows to the default tenant, which is right for a table
  // being adopted on a single-tenant install and wrong for one whose rows
  // already belong to different tenants. It also enables FORCE ROW LEVEL
  // SECURITY, which applies to the table owner too — so a correcting UPDATE
  // afterwards would be filtered by the very policy it is trying to correct.
  // Doing it first means `applyTenantRLS`'s own `WHERE tenant_id IS NULL` pass
  // finds nothing left to do.
  await sql`ALTER TABLE zvd_contact_organizations ADD COLUMN IF NOT EXISTS tenant_id UUID`.execute(
    db,
  );
  await sql`
    UPDATE zvd_contact_organizations j
       SET tenant_id = c.tenant_id
      FROM zvd_contacts c
     WHERE c.id = j.contact_id
       AND j.tenant_id IS DISTINCT FROM c.tenant_id
  `.execute(db);
  try {
    const { applyTenantRLS } = await import('../lib/tenancy/index.js');
    await applyTenantRLS(db, 'zvd_contact_organizations');
  } catch (err) {
    console.warn(
      '   ⚠  applyTenantRLS on zvd_contact_organizations failed:',
      (err as Error).message,
    );
  }

  // Register in zvd_relations so Studio knows how to navigate the link.
  // ON CONFLICT avoids duplicate row on subsequent boots.
  await sql`
    INSERT INTO zvd_relations (name, type, source_collection, source_field, target_collection, target_field, junction_table, on_delete, on_update)
    VALUES ('contact_organizations', 'm2m', 'contacts', 'id', 'organizations', 'id', 'zvd_contact_organizations', 'CASCADE', 'CASCADE')
    ON CONFLICT (source_collection, source_field) DO NOTHING
  `.execute(db);
}
