-- Close four more resources that migration 034 had already opened.
--
-- Owner decision, 2026-08-07, after an audit measured what an ordinary
-- `tenant_member` could reach on a running instance. Expense reports carry
-- amounts, merchants and receipts per person — where somebody was and who with.
-- Time tracking is attendance. Accounting is the company's books, and invoicing
-- is its revenue. All four had default grants because nobody had decided
-- otherwise, which is the thing deny-by-default exists to stop.
--
-- Adding names to `SENSITIVE_RESOURCES` alone would have changed nothing here.
-- That set is consulted when a grant is CREATED, so it governs new resources and
-- new installs; the rows for these four were written by migration 034 minutes
-- after the rule landed and would simply have stayed. Withholding a future grant
-- and revoking an existing one are different operations, and only the second one
-- closes an instance that is already running.
--
-- Scoped to the two roles that received the automatic grant. A role an operator
-- created and granted by name — an `accountant` who should reach the books — is
-- untouched, which is the whole point of having made these rows explicit: they
-- can be told apart and removed individually.
--
-- `tenant_owner` and `tenant_admin` are unaffected. Their grant is total.
--
-- This is expected to take access away from people who had it, particularly for
-- invoicing, which in many companies is daily work. The remedy is one grant per
-- role, from the permissions UI, and it is a decision somebody makes once rather
-- than an accident everyone inherits.

DELETE FROM zvd_permissions
 WHERE ptype = 'p'
   AND v0 IN ('tenant_member', 'tenant_viewer')
   AND v1 = '*'
   AND v2 IN ('expenses', 'time-tracking', 'accounting', 'invoices');
