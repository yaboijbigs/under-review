ALTER TABLE reviews ADD COLUMN scope_complete boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN reviews.scope_complete IS 'Reviewer attestation that the explicitly stated scope is complete; administrator approval is required for reviewed_within_scope. This is not whole-game coverage.';
