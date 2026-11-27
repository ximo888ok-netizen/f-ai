CREATE TABLE auth_captchas (
  id uuid PRIMARY KEY,
  answer_hash text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_captchas_expires ON auth_captchas (expires_at);

CREATE TABLE auth_contact_codes (
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  target text NOT NULL,
  id uuid NOT NULL UNIQUE,
  flow_id uuid NOT NULL,
  code_hash text,
  attempts integer NOT NULL DEFAULT 0,
  resend_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (channel, target)
);
CREATE INDEX auth_contact_codes_expires ON auth_contact_codes (expires_at);
