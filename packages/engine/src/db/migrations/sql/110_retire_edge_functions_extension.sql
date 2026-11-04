-- 110_retire_edge_functions_extension.sql
--
-- Edge function administration is the engine's again: `/api/edge-functions`
-- (tenant admins) and the Studio page Developer → Edge Functions. The
-- `developer/edge-functions` extension that held the CRUD was retired; it owned
-- no table, and the engine never stopped owning `zv_edge_functions`, the runner
-- and `/api/fn/:name`.
--
-- Its registry rows have to go with it. The loader treats an enabled row whose
-- files are absent as a bundle to fetch, so an upgraded instance that had the
-- extension enabled would download the retired 1.x bundle from the registry
-- and mount a second, stale administration surface beside the engine's. The
-- functions themselves are rows of `zv_edge_functions` and are untouched.

DELETE FROM zv_extension_registry WHERE name = 'developer/edge-functions';

-- DOWN

-- Not reversed: the extension no longer exists to re-enable.
SELECT 1;
