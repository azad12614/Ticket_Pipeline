CREATE OR REPLACE FUNCTION notify_ticket_event()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('ticket_events', NEW.ticket_id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ticket_event_notify
AFTER INSERT ON ticket_events
FOR EACH ROW EXECUTE FUNCTION notify_ticket_event();
