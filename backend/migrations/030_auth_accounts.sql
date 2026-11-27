ALTER TABLE accounts
  ADD COLUMN username text UNIQUE,
  ADD COLUMN phone text UNIQUE,
  ADD COLUMN email_verified_at timestamptz,
  ADD COLUMN phone_verified_at timestamptz,
  ADD CONSTRAINT accounts_verified_identity CHECK (
    (username IS NULL AND phone IS NULL AND email_verified_at IS NULL AND phone_verified_at IS NULL)
    OR
    (username IS NOT NULL AND phone IS NOT NULL AND email_verified_at IS NOT NULL AND phone_verified_at IS NOT NULL)
  );
