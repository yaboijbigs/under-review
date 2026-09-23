-- A per-post administrator exception, never an automatic backfill permission.
ALTER TABLE publication_outbox ADD COLUMN IF NOT EXISTS manual_historical_initial boolean NOT NULL DEFAULT false;
ALTER TABLE publication_outbox ADD CONSTRAINT manual_historical_initial_requires_approval
 CHECK (NOT manual_historical_initial OR (mode='live' AND kind='initial' AND NOT queued_automatically AND approved_by IS NOT NULL));
