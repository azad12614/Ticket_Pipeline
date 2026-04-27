ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'ticket_created';

REVOKE UPDATE, DELETE ON ticket_events FROM ticketuser;
