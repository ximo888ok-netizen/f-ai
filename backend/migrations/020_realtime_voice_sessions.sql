CREATE TABLE realtime_voice_sessions (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  id uuid NOT NULL,
  model text NOT NULL,
  voice text NOT NULL,
  binding_hash text NOT NULL,
  offer_hash text NOT NULL,
  cost integer NOT NULL CHECK (cost > 0),
  duration_seconds integer NOT NULL CHECK (duration_seconds BETWEEN 10 AND 3600),
  state text NOT NULL CHECK (state IN ('opening','active','closing','closed','failed')),
  close_requested boolean NOT NULL DEFAULT false,
  provider_call_id text,
  answer_sdp text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  next_action_at timestamptz,
  PRIMARY KEY (workspace_id,account_id,id),
  FOREIGN KEY (workspace_id,account_id) REFERENCES wallets(workspace_id,account_id),
  CHECK ((state='active') = (answer_sdp IS NOT NULL)),
  CHECK ((state IN ('opening','active','closing')) = (next_action_at IS NOT NULL))
);

CREATE UNIQUE INDEX realtime_voice_member_open ON realtime_voice_sessions(workspace_id,account_id)
  WHERE state IN ('opening','active');

CREATE INDEX realtime_voice_due ON realtime_voice_sessions(next_action_at)
  WHERE next_action_at IS NOT NULL;
