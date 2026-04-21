-- Strip the 'data:' prefix from Casbin collection policies.
-- Previously data-collection resources were stored as 'data:collection_name'.
-- They are now stored as 'collection_name' directly for consistency.
UPDATE zvd_permissions
SET v1 = SUBSTRING(v1 FROM 6)
WHERE ptype = 'p' AND v1 LIKE 'data:%';
