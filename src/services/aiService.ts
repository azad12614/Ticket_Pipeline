import * as PortkeyModule from 'portkey-ai';
import { FatalPhaseError } from '../lib/errors.ts';
import logger from '../lib/logger.ts';
import { getTicketById } from '../repositories/ticketRepo.ts';
import { triageOutputSchema, type TriageOutput } from '../schemas/triageSchema.ts';

type PortkeyClient = InstanceType<typeof PortkeyModule.Portkey>;

let _portkey: PortkeyClient | null = null;

function getPortkeyClient(): PortkeyClient {
  if (!_portkey) {
    const apiKey = process.env['PORTKEY_API_KEY'];
    if (!apiKey) throw new Error('PORTKEY_API_KEY not set');
    _portkey = new PortkeyModule.Portkey({
      apiKey,
      config: process.env['PORTKEY_CONFIG'],
    });
  }
  return _portkey;
}

const TRIAGE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'triage_ticket',
    description: 'Analyze a support ticket and produce structured triage output.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['billing', 'technical', 'account', 'general', 'other'],
          description: 'Type of support issue.',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'Urgency level.',
        },
        sentiment: {
          type: 'string',
          enum: ['positive', 'neutral', 'negative', 'frustrated'],
          description: 'Customer emotional state.',
        },
        escalation: {
          type: 'boolean',
          description: 'True if ticket needs immediate escalation.',
        },
        routing_target: {
          type: 'string',
          enum: ['support', 'billing-team', 'technical-team', 'account-team'],
          description: 'Team that should handle this ticket.',
        },
        summary: {
          type: 'string',
          description: 'One-sentence factual description of the issue. Max 300 chars.',
        },
      },
      required: ['category', 'priority', 'sentiment', 'escalation', 'routing_target', 'summary'],
    },
  },
};

export async function triageTicket(ticketId: string): Promise<TriageOutput> {
  const ticket = await getTicketById(ticketId);
  if (!ticket) throw new FatalPhaseError(`Ticket ${ticketId} not found`);

  const portkey = getPortkeyClient();
  const start = Date.now();
  logger.info({ ticketId }, 'AI triage started');

  const response = await portkey.chat.completions.create(
    {
      model: process.env['PORTKEY_DEFAULT_MODEL'] ?? 'claude-haiku-4-5-20251001',
      messages: [
        {
          role: 'system',
          content:
            'You are a support ticket triage system. Analyze the ticket and call triage_ticket with structured output. Classify strictly from allowed enum values — do not invent categories. Summary must be one sentence, factual, under 300 characters.',
        },
        {
          role: 'user',
          content: `Subject: ${ticket.subject}\n\nBody: ${ticket.body}`,
        },
      ],
      tools: [TRIAGE_TOOL],
      tool_choice: { type: 'function', function: { name: 'triage_ticket' } },
    },
    { timeout: 30_000 },
  );

  logger.info({ ticketId, durationMs: Date.now() - start }, 'AI triage complete');

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') {
    throw new FatalPhaseError('No tool call in triage response');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(toolCall.function.arguments);
  } catch {
    throw new FatalPhaseError('Triage response arguments not valid JSON');
  }

  const parsed = triageOutputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FatalPhaseError(`Triage output failed validation: ${parsed.error.message}`);
  }

  return parsed.data;
}

export async function runPhase(ticketId: string, phase: 'triage' | 'draft'): Promise<unknown> {
  if (phase === 'triage') return triageTicket(ticketId);
  throw new Error(`Phase '${phase}' not yet implemented`);
}
