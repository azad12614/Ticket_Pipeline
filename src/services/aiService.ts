import { z } from 'zod';
import * as PortkeyModule from 'portkey-ai';
import { config } from '../lib/config.ts';
import { FatalPhaseError } from '../lib/errors.ts';
import logger from '../lib/logger.ts';
import type { TicketRepo } from '../repositories/ticketRepo.ts';
import { draftOutputSchema } from '../schemas/draftSchema.ts';
import { triageOutputSchema } from '../schemas/triageSchema.ts';

export type PortkeyClient = InstanceType<typeof PortkeyModule.Portkey>;

type CreateParams = Parameters<PortkeyClient['chat']['completions']['create']>[0];
type ChatMessages = NonNullable<CreateParams['messages']>;
type ChatTool = NonNullable<CreateParams['tools']>[number];

type PortkeyResponse = {
  model?: string;
  getHeaders?: () => Record<string, string> | null | undefined;
};

function resolveProvider(response: PortkeyResponse): string {
  return response.model ?? response.getHeaders?.()?.['x-portkey-provider'] ?? 'unknown';
}

type PhaseName = 'triage' | 'draft';

export type PhaseResult = { output: unknown; durationMs: number; provider: string };

type PhaseHandler = (ticketId: string) => Promise<PhaseResult>;

export function createPortkeyClient(): PortkeyClient {
  const apiKey = config.portkey.apiKey;
  if (!apiKey) throw new Error('PORTKEY_API_KEY is not configured');
  return new PortkeyModule.Portkey({ apiKey, config: config.portkey.config });
}

const TRIAGE_TOOL: ChatTool = {
  type: 'function',
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

const DRAFT_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'draft_resolution',
    description: 'Draft a resolution for a support ticket based on triage analysis.',
    parameters: {
      type: 'object',
      properties: {
        customer_reply: {
          type: 'string',
          description:
            'Warm, professional customer-facing reply addressing the specific issue. Min 50 chars.',
        },
        internal_note: {
          type: 'string',
          description:
            'Internal note for the support agent: reasoning behind the draft, edge cases, handling nuances, or anything not captured in the structured triage fields. Do not repeat category, priority, or escalation — those are already stored.',
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
  private readonly repo: TicketRepo;
  private readonly portkey: PortkeyClient;
  private readonly phaseHandlers: Record<PhaseName, PhaseHandler>;

  constructor(repo: TicketRepo, portkey: PortkeyClient) {
    this.repo = repo;
    this.portkey = portkey;
    this.phaseHandlers = {
      triage: ticketId => this.triageTicket(ticketId),
      draft: ticketId => this.draftResolution(ticketId),
    } satisfies Record<PhaseName, PhaseHandler>;
  }

  private async callPortkeyTool<T>(
    messages: ChatMessages,
    tool: ChatTool,
    toolName: string,
    schema: z.ZodType<T>,
    label: string,
  ): Promise<{ output: T; durationMs: number; provider: string }> {
    const start = Date.now();
    const response = await this.portkey.chat.completions.create(
      { messages, tools: [tool], tool_choice: { type: 'function', function: { name: toolName } } },
      { timeout: 30_000 },
    );
    const durationMs = Date.now() - start;
    const provider = resolveProvider(response);

    if (!response.choices.length) {
      throw new FatalPhaseError(`Empty choices in ${label} response`);
    }
    const toolCall = response.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.type !== 'function') {
      throw new FatalPhaseError(`No tool call in ${label} response`);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(toolCall.function.arguments);
    } catch {
      throw new FatalPhaseError(`${label} response arguments not valid JSON`);
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new FatalPhaseError(`${label} output failed validation: ${parsed.error.message}`);
    }

    return { output: parsed.data, durationMs, provider };
  }

  async triageTicket(ticketId: string): Promise<PhaseResult> {
    const ticket = await this.repo.getTicketById(ticketId);
    if (!ticket) throw new FatalPhaseError(`Ticket ${ticketId} not found`);

    logger.info({ ticketId }, 'AI triage started');
    const result = await this.callPortkeyTool(
      [
        {
          role: 'system',
          content:
            'You are a support ticket triage system. Analyze the ticket and call triage_ticket with structured output. Classify strictly from allowed enum values — do not invent categories. Summary must be one sentence, factual, under 300 characters.',
        },
        {
          role: 'user',
          content: `<ticket>\n<subject>${ticket.subject}</subject>\n<body>${ticket.body}</body>\n</ticket>`,
        },
      ],
      TRIAGE_TOOL,
      'triage_ticket',
      triageOutputSchema,
      'triage',
    );
    logger.info({ ticketId, durationMs: result.durationMs, provider: result.provider }, 'AI triage complete');
    return result;
  }

  async draftResolution(ticketId: string): Promise<PhaseResult> {
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

    logger.info({ ticketId }, 'AI draft started');
    const result = await this.callPortkeyTool(
      [
        {
          role: 'system',
          content:
            'You are a support ticket resolution specialist. Draft a response using the triage analysis. Customer reply must be warm, professional, and address the specific issue. Internal note must provide agent-specific reasoning, nuances, or edge cases not captured in the structured triage fields — do not repeat category, priority, or escalation verbatim. Next actions must be specific and actionable (1–5 items).',
        },
        {
          role: 'user',
          content: `<ticket>\n<subject>${ticket.subject}</subject>\n<body>${ticket.body}</body>\n</ticket>\n\n<triage_analysis>\n${JSON.stringify(triageParsed.data, null, 2)}\n</triage_analysis>`,
        },
      ],
      DRAFT_TOOL,
      'draft_resolution',
      draftOutputSchema,
      'draft',
    );
    logger.info({ ticketId, durationMs: result.durationMs, provider: result.provider }, 'AI draft complete');
    return result;
  }

  async runPhase(ticketId: string, phase: PhaseName): Promise<PhaseResult> {
    return this.phaseHandlers[phase](ticketId);
  }
}

export type RunPhaseDeps = {
  repo: TicketRepo;
  portkey: PortkeyClient;
};

export function runPhase(
  ticketId: string,
  phase: PhaseName,
  deps: RunPhaseDeps,
): Promise<PhaseResult> {
  const service = new AiService(deps.repo, deps.portkey);
  return service.runPhase(ticketId, phase);
}
