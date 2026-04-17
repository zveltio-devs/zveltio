-- Align Client Portal zone base_path with the actual Studio route (/portal-client).
-- The original seed in 052 used "/portal/client" which never matched any Svelte route.
UPDATE zvd_zones
SET base_path = '/portal-client'
WHERE slug = 'client' AND base_path = '/portal/client';

-- DOWN
-- UPDATE zvd_zones SET base_path = '/portal/client' WHERE slug = 'client' AND base_path = '/portal-client';
