import { z } from 'zod';

export const ticketEventSchema = z.object({
  id: z.uuidv7(),
  ticket_id: z.uuidv7(),
  phase: z.enum(['triage', 'draft']).nullable(),
  event_type: z.enum([
    'ticket_created',
    'phase_started', 'phase_completed', 'phase_failed',
    'retry_scheduled', 'fallback_triggered', 'dlq_routed',
    'ticket_completed', 'ticket_failed',
  ]),
  payload: z.unknown().nullable(),
  created_at: z.date(),
});

export type TicketEvent = z.infer<typeof ticketEventSchema>;
