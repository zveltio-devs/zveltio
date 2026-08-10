-- The last uuid column named `*_by`, so the class can be checked rather than remembered.
--
-- `zv_rate_limit_configs.updated_by` is a uuid and `"user".id` is a 32-character
-- nanoid. Nothing writes it today, which is exactly why it survived two passes: a
-- column read and never written looks harmless. It is not. The first route that
-- records who changed a rate limit fails with 22P02, and whoever adds it spends
-- the afternoon on a cast error instead of on the feature.
--
-- Converted alongside five in the extensions repo, and the reason for doing the
-- whole class at once is the detector. The earlier sweep worked from a
-- hand-written list of column names — `created_by`, `approved_by`, `changed_by`
-- and so on — and missed `checked_by`, which is the column every tick on a
-- checklist writes. Ticking an item off had never worked on any installation,
-- and the list did not know to ask about it.
--
-- Ask the catalogue instead: which uuid columns are named `*_by`? With this
-- migration the answer is none, which is a property a test can assert without
-- anybody having to think of the name first.

ALTER TABLE IF EXISTS zv_rate_limit_configs ALTER COLUMN updated_by TYPE TEXT;
