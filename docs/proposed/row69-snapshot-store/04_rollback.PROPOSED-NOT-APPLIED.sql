-- ROW 69 FEED SNAPSHOT STORE: ROLLBACK. PROPOSED, NOT APPLIED. Run only to undo 02_apply, after any server code that
-- calls these functions has been switched back to the live (non-stable) fallback. Loses only short-lived snapshot rows
-- (TTL <= 1 hour); no job, user or billing data is touched.
BEGIN;
DROP FUNCTION IF EXISTS public.feed_purge_expired_snapshots(integer);
DROP FUNCTION IF EXISTS public.feed_read_snapshot_window(text, uuid, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.feed_capture_search_snapshot(jsonb, boolean, uuid, text, text, text, integer, integer, text[]);
DROP FUNCTION IF EXISTS public.feed_snapshot_filter_sql(jsonb, integer);
DROP FUNCTION IF EXISTS public.feed_capture_snapshot(text, uuid, text, text, text, uuid[], integer);
DROP FUNCTION IF EXISTS public.feed_snapshot_check_args(text, text, text, text, integer);
DROP FUNCTION IF EXISTS public.feed_snapshot_admit(uuid);
DROP FUNCTION IF EXISTS public.feed_snapshot_limits();
DROP TABLE IF EXISTS public.feed_snapshots;
COMMIT;
-- After rollback, 03_verify.READONLY.sql section 1 should report the table and every function as absent.
