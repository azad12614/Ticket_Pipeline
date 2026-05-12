import { z } from 'zod';

export const PHASE_NAMES = ['triage', 'draft'] as const;

export const ticketPhaseSchema = z.object({
  id: z.uuidv7(),
  ticket_id: z.uuidv7(),
  phase: z.enum(PHASE_NAMES),
  status: z.enum(['started', 'progress', 'success', 'failure']),
  attempts: z.number().int(),
  output: z.unknown().nullable(),
  started_at: z.coerce.date().nullable(),
  completed_at: z.coerce.date().nullable(),
});

export type TicketPhase = z.infer<typeof ticketPhaseSchema>;
