CREATE TYPE phase_name AS ENUM ('triage', 'draft');
CREATE TYPE phase_status AS ENUM ('started', 'progress', 'success', 'failure');

CREATE TABLE IF NOT EXISTS ticket_phases (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid_v7(),
  ticket_id    UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  phase        phase_name NOT NULL,
  status       phase_status NOT NULL DEFAULT 'started',
  attempts     INT NOT NULL DEFAULT 0,
  output       JSON,
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE(ticket_id, phase)
);
