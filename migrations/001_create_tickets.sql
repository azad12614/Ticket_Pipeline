CREATE TYPE ticket_status AS ENUM ('queued', 'processing', 'completed', 'failed');

CREATE TABLE IF NOT EXISTS tickets (
  id          UUID PRIMARY KEY,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      ticket_status NOT NULL DEFAULT 'queued',
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tickets_updated_at
  BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
