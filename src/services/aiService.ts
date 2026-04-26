import * as PortkeyModule from 'portkey-ai';
import { config } from '../lib/config.ts';
import { FatalPhaseError } from '../lib/errors.ts';
import logger from '../lib/logger.ts';
import { postgresTicketRepo, type ITicketRepo } from '../repositories/ticketRepo.ts';
import { draftOutputSchema, type DraftOutput } from '../schemas/draftSchema.ts';
import { triageOutputSchema, type TriageOutput } from '../schemas/triageSchema.ts';

export type PortkeyClient = InstanceType<typeof PortkeyModule.Portkey>;

type PhaseName = 'triage' | 'draft';
type PhaseHandler = (ticketId: string) => Promise<unknown>;

export function createPortkeyClient(): PortkeyClient {
  return new PortkeyModule.Portkey({
    apiKey: config.portkey.apiKey!,
    config: config.portkey.config,
  });
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

const DRAFT_TOOL = {
  type: 'function' as const,
  function: {
    name: 'draft_resolution',
    description: 'Draft a resolution for a support ticket based on triage analysis.',
    parameters: {
      type: 'object',
      properties: {
        customer_reply: {
          type: 'string',
          description: 'Warm, professional customer-facing reply addressing the specific issue. Min 50 chars.',
        },
        internal_note: {
          type: 'string',
          description: 'Internal note for the agent referencing triage category, priority, and escalation status.',
        },
        next_actions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific actionable next steps, 1 to 5 items.',
          minItems: 1,
          maxItems: 5,
        },
      },
      required: ['customer_reply', 'internal_note', 'next_actions'],
    },
  },
};

export class AiService {
  private readonly phaseHandlers: Record<PhaseName, PhaseHandler>;

  constructor(
    private readonly repo: ITicketRepo,
    private readonly portkey: PortkeyClient,
  ) {
    this.phaseHandlers = {
      triage: (ticketId) => this.triageTicket(ticketId),
      draft: (ticketId) => this.draftResolution(ticketId),
    } satisfies Record<PhaseName, PhaseHandler>;
  }

  async triageTicket(ticketId: string): Promise<TriageOutput> {
    const ticket = await this.repo.getTicketById(ticketId);
    if (!ticket) throw new FatalPhaseError(`Ticket ${ticketId} not found`);

    const start = Date.now();
    logger.info({ ticketId }, 'AI triage started');

    const response = await this.portkey.chat.completions.create(
      {
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

    if (!response.choices.length) {
      throw new FatalPhaseError('Empty choices in triage response');
    }
    const toolCall = response.choices[0].message?.tool_calls?.[0];
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

  async draftResolution(ticketId: string): Promise<DraftOutput> {
    const [ticket, phases] = await Promise.all([
      this.repo.getTicketById(ticketId),
      this.repo.getTicketPhasesByTicketId(ticketId),
    ]);

    if (!ticket) throw new FatalPhaseError(`Ticket ${ticketId} not found`);

    const triagePhase = phases.find(p => p.phase === 'triage' && p.status === 'success');
    if (!triagePhase) throw new FatalPhaseError(`Triage output not available for ticket ${ticketId}`);

    const triageParsed = triageOutputSchema.safeParse(triagePhase.output);
    if (!triageParsed.success) {
      throw new FatalPhaseError(`Stored triage output invalid: ${triageParsed.error.message}`);
    }

    const start = Date.now();
    logger.info({ ticketId }, 'AI draft started');

    const response = await this.portkey.chat.completions.create(
      {
        messages: [
          {
            role: 'system',
            content:
              'You are a support ticket resolution specialist. Draft a response using the triage analysis. Customer reply must be warm, professional, and address the specific issue. Internal note must reference the triage category, priority, and escalation status. Next actions must be specific and actionable (1–5 items).',
          },
          {
            role: 'user',
            content: `Subject: ${ticket.subject}\n\nBody: ${ticket.body}\n\nTriage Analysis:\n${JSON.stringify(triageParsed.data, null, 2)}`,
          },
        ],
        tools: [DRAFT_TOOL],
        tool_choice: { type: 'function', function: { name: 'draft_resolution' } },
      },
      { timeout: 30_000 },
    );

    logger.info({ ticketId, durationMs: Date.now() - start }, 'AI draft complete');

    if (!response.choices.length) {
      throw new FatalPhaseError('Empty choices in draft response');
    }
    const toolCall = response.choices[0].message?.tool_calls?.[0];
    if (!toolCall || toolCall.type !== 'function') {
      throw new FatalPhaseError('No tool call in draft response');
    }

    let raw: unknown;
    try {
      raw = JSON.parse(toolCall.function.arguments);
    } catch {
      throw new FatalPhaseError('Draft response arguments not valid JSON');
    }

    const parsed = draftOutputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new FatalPhaseError(`Draft output failed validation: ${parsed.error.message}`);
    }

    return parsed.data;
  }

  async runPhase(ticketId: string, phase: PhaseName): Promise<unknown> {
    const handler = this.phaseHandlers[phase];
    if (!handler) throw new Error(`Unknown phase: ${String(phase)}`);
    return handler(ticketId);
  }
}

let _defaultService: AiService | null = null;

function getDefaultService(): AiService {
  if (!_defaultService) _defaultService = new AiService(postgresTicketRepo, createPortkeyClient());
  return _defaultService;
}

export function runPhase(ticketId: string, phase: PhaseName): Promise<unknown> {
  return getDefaultService().runPhase(ticketId, phase);
}
