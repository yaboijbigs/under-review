ALTER TABLE analysis_revisions ADD COLUMN source_kind text NOT NULL DEFAULT 'unknown'
 CHECK(source_kind IN ('raw','clean','unknown'));
-- Statistical corrections and human-review revisions can use either source.
-- Determine maturity only from the immutable PBP provenance, never the label.
UPDATE analysis_revisions r SET source_kind=CASE
 WHEN EXISTS(SELECT 1 FROM source_snapshots s WHERE r.snapshot_ids ? s.id AND s.provider='nflverse-pbp')
  AND NOT EXISTS(SELECT 1 FROM source_snapshots s WHERE r.snapshot_ids ? s.id AND s.provider='nflverse-raw-pbp') THEN 'clean'
 WHEN EXISTS(SELECT 1 FROM source_snapshots s WHERE r.snapshot_ids ? s.id AND s.provider='nflverse-raw-pbp')
  AND NOT EXISTS(SELECT 1 FROM source_snapshots s WHERE r.snapshot_ids ? s.id AND s.provider='nflverse-pbp') THEN 'raw'
 ELSE 'unknown' END;
COMMENT ON COLUMN analysis_revisions.source_kind IS 'Original PBP maturity; independent of numerical correction and human-review status.';
