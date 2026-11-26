CREATE TABLE sms_messages (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  account_id uuid NOT NULL,
  template text NOT NULL,
  masked_recipient text NOT NULL,
  payload jsonb,
  request_hash text NOT NULL,
  binding_hash text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sending','accepted','failed','uncertain')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  provider_reference text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,account_id) REFERENCES memberships(workspace_id,account_id)
);
CREATE INDEX sms_ready ON sms_messages(available_at) WHERE state='queued';
CREATE INDEX sms_lease ON sms_messages(lease_until) WHERE state='sending';
CREATE INDEX sms_workspace_recent ON sms_messages(workspace_id,created_at DESC,id);
CREATE INDEX sms_workspace_failures ON sms_messages(workspace_id,updated_at) WHERE state IN ('failed','uncertain');
