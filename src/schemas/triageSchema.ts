import { z } from 'zod';

export const triageOutputSchema = z.object({
  category: z.enum(['billing', 'technical', 'account', 'general', 'other']),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'frustrated']),
  escalation: z.boolean(),
  routing_target: z.enum(['support', 'billing-team', 'technical-team', 'account-team']),
  summary: z.string().min(10).max(300),
});

export type TriageOutput = z.infer<typeof triageOutputSchema>;
