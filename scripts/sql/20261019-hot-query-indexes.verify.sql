-- Read-only plan and source-membership checks; run before and after the index
-- script with psql -X -v ON_ERROR_STOP=1 -f <this file>.
\set ON_ERROR_STOP on
\pset pager off
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';

EXPLAIN (ANALYZE, BUFFERS)
 SELECT 1 FROM games
 WHERE season=2026
   AND kickoff_at BETWEEN now()-interval '8 hours' AND now()+interval '2 hours'
 LIMIT 1;

EXPLAIN (ANALYZE, BUFFERS)
 SELECT provider,max(retrieved_at) AS last FROM source_snapshots GROUP BY provider;

EXPLAIN (ANALYZE, BUFFERS)
 WITH selected AS (
  SELECT snapshot_ids FROM analysis_revisions
  WHERE game_id='2026_06_DAL_GB' ORDER BY number DESC LIMIT 1
 ) SELECT (SELECT jsonb_agg(s.snapshot_json) FROM source_snapshots s
           WHERE s.id = ANY(ARRAY(SELECT jsonb_array_elements_text(r.snapshot_ids))))
 FROM selected r;

-- Compare source membership for every stored revision. Both forms deduplicate
-- repeated IDs and omit missing IDs; ordering was unspecified in both queries.
WITH membership AS (
 SELECT r.id,
  ARRAY(SELECT s.id FROM source_snapshots s
        WHERE s.id IN (SELECT jsonb_array_elements_text(r.snapshot_ids))
        ORDER BY s.id) AS previous_ids,
  ARRAY(SELECT s.id FROM source_snapshots s
        WHERE s.id = ANY(ARRAY(SELECT jsonb_array_elements_text(r.snapshot_ids)))
        ORDER BY s.id) AS indexed_ids
 FROM analysis_revisions r
)
SELECT count(*) AS revisions_checked,
       count(*) FILTER (WHERE previous_ids IS DISTINCT FROM indexed_ids) AS source_mismatches
 FROM membership;

COMMIT;
