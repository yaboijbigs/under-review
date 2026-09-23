ALTER TABLE analysis_revisions ADD CONSTRAINT analysis_revisions_id_game_unique UNIQUE(id,game_id);

CREATE TABLE visitor_feedback (
 id uuid PRIMARY KEY,
 game_id text NOT NULL,
 revision_id uuid NOT NULL,
 rules_version text NOT NULL CHECK(char_length(rules_version) BETWEEN 1 AND 100),
 visitor_id text NOT NULL CHECK(visitor_id ~ '^[a-f0-9]{64}$'),
 agreement text NOT NULL CHECK(agreement IN ('agree','disagree')),
 rating smallint NOT NULL CHECK(rating BETWEEN 1 AND 5),
 model_rating smallint NOT NULL CHECK(model_rating BETWEEN 1 AND 5),
 comment text NOT NULL DEFAULT '' CHECK(char_length(comment)<=1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(revision_id,game_id) REFERENCES analysis_revisions(id,game_id) ON DELETE CASCADE,
 UNIQUE(game_id,revision_id,rules_version,visitor_id)
);
CREATE INDEX visitor_feedback_recent ON visitor_feedback(updated_at DESC);
