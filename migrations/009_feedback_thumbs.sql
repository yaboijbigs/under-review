-- A thumb is a complete response. Only an explicitly chosen slider contributes
-- to the community average; existing explicit ratings retain their values.
ALTER TABLE visitor_feedback ALTER COLUMN rating DROP NOT NULL;
CREATE INDEX visitor_feedback_latest_game_visitor ON visitor_feedback(game_id,visitor_id,updated_at DESC,id DESC);
