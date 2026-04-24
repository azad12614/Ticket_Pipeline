import { z } from 'zod';

export const ticketInputSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
});

export type TicketInput = z.infer<typeof ticketInputSchema>;

export const ticketSchema = z.object({
  id: z.uuidv7(),
  subject: z.string(),
  body: z.string(),
  status: z.enum(['queued', 'processing', 'completed', 'failed']),
  archived_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});

export type Ticket = z.infer<typeof ticketSchema>;
