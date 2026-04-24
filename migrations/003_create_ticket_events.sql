CREATE TYPE event_type AS ENUM (
  'phase_started', 'phase_completed', 'phase_failed',
  'retry_scheduled', 'fallback_triggered', 'dlq_routed',
  'ticket_completed', 'ticket_failed'
);

CREATE TABLE IF NOT EXISTS ticket_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid_v7(),
  ticket_id  UUID NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  phase      phase_name,
  event_type event_type NOT NULL,
  payload    JSON,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ticket_events_ticket_id ON ticket_events(ticket_id);
