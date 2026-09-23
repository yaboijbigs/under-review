-- Previous submissions were private. Only a new explicit public:true submission
-- may publish its comment; do not backfill existing rows as public.
ALTER TABLE visitor_feedback ADD COLUMN is_public boolean NOT NULL DEFAULT false;
CREATE INDEX visitor_feedback_public_game ON visitor_feedback(game_id,updated_at DESC,id DESC) WHERE is_public=true;
