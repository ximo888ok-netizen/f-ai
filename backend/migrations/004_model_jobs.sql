ALTER TABLE tasks ADD COLUMN provider_job_id text;
ALTER TABLE tasks ADD COLUMN provider_sent_at timestamptz;
ALTER TABLE tasks ADD COLUMN poll_failures integer NOT NULL DEFAULT 0;
