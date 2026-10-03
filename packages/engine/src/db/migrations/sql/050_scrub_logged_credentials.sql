-- 050_scrub_logged_credentials.sql
--
-- Credentials already written into the request and slow-request logs.
--
-- The request log recorded the raw path, and `GET /api/invitations/:token` puts
-- a live invitation in it: one SELECT on `zv_request_logs` (or a backup) was
-- every invitation that had been opened, after 038 removed them from
-- `zv_invitations`. The slow-request log also recorded the query string as it
-- came, so a slow better-auth verify or magic link (`?token=`), an OAuth
-- callback (`?code=&state=`) or a reset link (`/api/auth/reset-password/<token>`)
-- stayed there too. The writers now go through `loggablePath` / `loggableQuery`
-- (lib/security/loggable-request.ts); this rewrites the rows they wrote before,
-- with the same rule. The query-key pattern below is SECRET_QUERY's.
--
-- Neither table has a policy or a tenant: plain UPDATEs. Each scans its table
-- once and locks only the rows it rewrites.
--
-- Re-runnable: a rewritten row no longer matches.

UPDATE zv_request_logs
   SET path = '/api/invitations/:token'
 WHERE path LIKE '/api/invitations/%'
   AND path NOT LIKE '/api/invitations/%/%'
   AND path NOT IN ('/api/invitations/accept', '/api/invitations/:token');

UPDATE zv_slow_queries
   SET path = '/api/invitations/:token'
 WHERE path LIKE '/api/invitations/%'
   AND path NOT LIKE '/api/invitations/%/%'
   AND path NOT IN ('/api/invitations/accept', '/api/invitations/:token');

UPDATE zv_slow_queries
   SET path = '/api/auth/reset-password/:token'
 WHERE path LIKE '/api/auth/reset-password/%'
   AND path NOT LIKE '/api/auth/reset-password/%/%'
   AND path <> '/api/auth/reset-password/:token';

UPDATE zv_slow_queries q
   SET query_params = (
         SELECT jsonb_object_agg(
                  e.k,
                  CASE WHEN e.k ~* 'token|secret|password|signature|^sig$|^code$|^state$|^otp$|api_?key'
                       THEN to_jsonb('[redacted]'::text) ELSE e.v END)
           FROM jsonb_each(q.query_params) AS e(k, v))
 WHERE jsonb_typeof(q.query_params) = 'object'
   AND EXISTS (
         SELECT 1 FROM jsonb_each(q.query_params) AS e(k, v)
          WHERE e.k ~* 'token|secret|password|signature|^sig$|^code$|^state$|^otp$|api_?key'
            AND e.v IS DISTINCT FROM to_jsonb('[redacted]'::text));

-- DOWN

-- Deliberately a no-op: the credentials are gone, and putting them back is the
-- defect.
SELECT 1;
