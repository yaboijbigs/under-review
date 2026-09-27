CREATE TABLE referee_assignment_feeds (
 season integer NOT NULL, week integer NOT NULL CHECK(week BETWEEN 1 AND 18),
 provider text NOT NULL CHECK(provider IN ('football-zebras','sharp-football')),
 snapshot_id text NOT NULL REFERENCES source_snapshots(id),
 assignments jsonb NOT NULL CHECK(jsonb_typeof(assignments)='array'),
 checked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(season,week,provider)
);
