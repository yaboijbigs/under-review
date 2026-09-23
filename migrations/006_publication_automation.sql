-- Initial live posts already have a game/account-wide unique index in 001.
-- Retain all prior previews and publication history; distinguish new automated queue entries.
ALTER TABLE publication_outbox ADD COLUMN IF NOT EXISTS template_version text;
ALTER TABLE publication_outbox ADD COLUMN IF NOT EXISTS queued_automatically boolean NOT NULL DEFAULT false;
