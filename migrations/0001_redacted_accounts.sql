CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  type TEXT NOT NULL,
  last_refresh TEXT NOT NULL,
  expired TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS accounts_email_idx ON accounts(email);
CREATE INDEX IF NOT EXISTS accounts_expired_idx ON accounts(expired);
