import { z } from 'zod';

export const draftOutputSchema = z.object({
  customer_reply: z.string().min(50).max(2000),
  internal_note: z.string().min(20).max(1000),
  next_actions: z.array(z.string()).min(1).max(5),
});

export type DraftOutput = z.infer<typeof draftOutputSchema>;
