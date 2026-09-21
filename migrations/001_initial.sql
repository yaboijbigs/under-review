CREATE TABLE IF NOT EXISTS games (
 id text PRIMARY KEY, season integer NOT NULL, week integer NOT NULL, game_type text NOT NULL,
 home_team text NOT NULL, away_team text NOT NULL, kickoff_at timestamptz, game_json jsonb NOT NULL,
 publication_eligible boolean NOT NULL DEFAULT false, discovered_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS games_season_week ON games(season,week);
CREATE TABLE IF NOT EXISTS source_snapshots (
 id text PRIMARY KEY, provider text NOT NULL,url text NOT NULL,checksum text NOT NULL,retrieved_at timestamptz NOT NULL,
 snapshot_json jsonb NOT NULL,UNIQUE(provider,url,checksum)
);
CREATE TABLE IF NOT EXISTS plays (
 game_id text REFERENCES games(id),snapshot_id text REFERENCES source_snapshots(id),play_id text NOT NULL,provider_order integer NOT NULL,
 data jsonb NOT NULL,PRIMARY KEY(game_id,snapshot_id,play_id)
);
CREATE TABLE IF NOT EXISTS events (
 id text PRIMARY KEY,game_id text NOT NULL REFERENCES games(id),play_id text NOT NULL,manual boolean NOT NULL DEFAULT false,
 data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS model_artifacts (
 id text PRIMARY KEY,version text NOT NULL,manifest jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS analysis_revisions (
 id uuid PRIMARY KEY,game_id text NOT NULL REFERENCES games(id),number integer NOT NULL,input_hash text NOT NULL,
 statistical_status text NOT NULL CHECK(statistical_status IN ('awaiting_data','preliminary','reconciled','corrected')),
 charting_status text NOT NULL CHECK(charting_status IN ('unavailable','partial','available')),
 review_status text NOT NULL DEFAULT 'not_reviewed',change_summary text NOT NULL,summary text NOT NULL,
 analysis jsonb NOT NULL,snapshot_ids jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(game_id,number),UNIQUE(game_id,input_hash)
);
CREATE TABLE IF NOT EXISTS event_observations (
 event_id text REFERENCES events(id),revision_id uuid REFERENCES analysis_revisions(id),data jsonb NOT NULL,
 PRIMARY KEY(event_id,revision_id)
);
CREATE TABLE IF NOT EXISTS metric_results (
 revision_id uuid REFERENCES analysis_revisions(id),metric_id text NOT NULL,category text NOT NULL,data jsonb NOT NULL,
 PRIMARY KEY(revision_id,metric_id)
);
CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY,username text UNIQUE NOT NULL,password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','reviewer')),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
 id text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),csrf_token text NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reviews (
 id uuid PRIMARY KEY,event_id text NOT NULL REFERENCES events(id),revision_id uuid NOT NULL REFERENCES analysis_revisions(id),
 reviewer_id uuid NOT NULL REFERENCES users(id),status text NOT NULL CHECK(status IN ('not_reviewed','supported','likely_incorrect','debatable','insufficient_evidence')),
 rule_season integer NOT NULL,rule_reference text NOT NULL,evidence_url text NOT NULL,rationale text NOT NULL,confidence text NOT NULL,
 scope text NOT NULL,replay_corrected boolean NOT NULL DEFAULT false,approved boolean NOT NULL DEFAULT false,
 approved_by uuid REFERENCES users(id),stale boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS jobs (
 id uuid PRIMARY KEY,kind text NOT NULL,game_id text,job_key text NOT NULL UNIQUE,payload jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','succeeded','failed')),
 attempts integer NOT NULL DEFAULT 0,max_attempts integer NOT NULL DEFAULT 5,run_after timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz,worker_id text,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_claim ON jobs(status,run_after);
CREATE TABLE IF NOT EXISTS publication_outbox (
 id uuid PRIMARY KEY,game_id text NOT NULL REFERENCES games(id),revision_id uuid NOT NULL REFERENCES analysis_revisions(id),
 account_id text NOT NULL DEFAULT 'unconnected',kind text NOT NULL CHECK(kind IN ('initial','correction','update')),
 mode text NOT NULL CHECK(mode IN ('dry_run','live')),status text NOT NULL CHECK(status IN ('draft','approved','sending','published','failed','unknown_outcome','cancelled')),
 text text NOT NULL,evidence_ids jsonb NOT NULL,external_id text,reason text,approved_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(game_id,revision_id,account_id,kind,mode)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_live_initial ON publication_outbox(game_id,account_id) WHERE mode='live' AND kind='initial';
CREATE TABLE IF NOT EXISTS publication_attempts (
 id uuid PRIMARY KEY,outbox_id uuid NOT NULL REFERENCES publication_outbox(id),state text NOT NULL,
 http_status integer,error text,external_id text,started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY,value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO settings(key,value) VALUES('publishing','{"mode":"draft-only","killSwitch":true,"accountId":null,"activatedAt":null}') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS oauth_accounts (id text PRIMARY KEY,username text NOT NULL,encrypted_tokens text NOT NULL,expires_at timestamptz NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS oauth_states (state_hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),verifier text NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (id bigserial PRIMARY KEY,user_id uuid,action text NOT NULL,target text,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS rate_limits (key text PRIMARY KEY,count integer NOT NULL,window_start timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS worker_heartbeats (id text PRIMARY KEY,updated_at timestamptz NOT NULL DEFAULT now(),job_id uuid);
