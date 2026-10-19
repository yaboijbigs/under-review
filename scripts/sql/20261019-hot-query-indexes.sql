-- Run with psql -X -v ON_ERROR_STOP=1 -f <this file>, after taking a pg_dump.
-- Deliberately outside migrations/: migrate() wraps those files in BEGIN,
-- whereas PostgreSQL requires CREATE INDEX CONCURRENTLY to run in autocommit.
-- Do not use psql --single-transaction or send this entire file as one query.
\set ON_ERROR_STOP on

SET lock_timeout = '5s';
SET statement_timeout = '10min';
-- Coordinate with the existing migration runner for this database.
SELECT pg_advisory_lock(1926032101);

-- Cover provider freshness without reading the wide snapshot_json heap rows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS source_snapshots_provider_retrieved_at
 ON source_snapshots(provider, retrieved_at DESC);

-- Bound minute-by-minute kickoff polling and recent-game reconciliation.
-- id also supports the recent-unreported-games anti-join without heap reads.
CREATE INDEX CONCURRENTLY IF NOT EXISTS games_season_kickoff_at
 ON games(season, kickoff_at) INCLUDE(id);

-- IF NOT EXISTS alone can silently retain an invalid interrupted build.
DO $$
BEGIN
 IF (SELECT count(*) FROM pg_index
     WHERE indexrelid IN (to_regclass('source_snapshots_provider_retrieved_at'),
                          to_regclass('games_season_kickoff_at'))
       AND indisvalid AND indisready) <> 2 THEN
  RAISE EXCEPTION 'Performance index missing or invalid. Inspect pg_index; drop only the invalid performance index CONCURRENTLY, then rerun this file.';
 END IF;
END $$;

SELECT indexrelid::regclass AS index_name, indisvalid, indisready,
       pg_get_indexdef(indexrelid) AS definition
 FROM pg_index
 WHERE indexrelid IN (to_regclass('source_snapshots_provider_retrieved_at'),
                      to_regclass('games_season_kickoff_at'));

SELECT pg_advisory_unlock(1926032101);
RESET lock_timeout;
RESET statement_timeout;

-- Undo, also as separate autocommit commands:
-- DROP INDEX CONCURRENTLY IF EXISTS source_snapshots_provider_retrieved_at;
-- DROP INDEX CONCURRENTLY IF EXISTS games_season_kickoff_at;
