ALTER TABLE games ADD COLUMN IF NOT EXISTS first_validated_at timestamptz;
ALTER TABLE analysis_revisions ADD COLUMN IF NOT EXISTS game_json jsonb NOT NULL DEFAULT '{}';
ALTER TABLE analysis_revisions ADD COLUMN IF NOT EXISTS reviews_json jsonb NOT NULL DEFAULT '[]';
UPDATE analysis_revisions r SET game_json=g.game_json FROM games g WHERE g.id=r.game_id AND r.game_json='{}';
