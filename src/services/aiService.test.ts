import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiService, type PortkeyClient } from './aiService.ts';
import { FatalPhaseError } from '../lib/errors.ts';
import type { Ticket } from '../schemas/ticketSchema.ts';
import type { TicketPhase } from '../schemas/phaseSchema.ts';

const TICKET_ID = '018f8a30-52f7-7d9f-bb7d-6924b8d8a002';

const mockTicket: Ticket = {
  id: TICKET_ID,
  subject: 'Cannot access my account',
  body: 'I have been unable to log in for 3 days.',
  status: 'processing',
  archived_at: null,
  created_at: new Date(),
  updated_at: new Date(),
};

const VALID_TRIAGE_ARGS = {
  category: 'account',
  priority: 'high',
  sentiment: 'frustrated',
  escalation: false,
  routing_target: 'account-team',
  summary: 'Customer unable to log in for 3 days.',
};

const VALID_DRAFT_ARGS = {
  customer_reply: 'Thank you for reaching out. We understand how frustrating it can be to be locked out of your account for multiple days. Our account team will investigate and resolve this within 24 hours.',
  internal_note: 'High priority account access issue. Customer is frustrated. No escalation needed. Route to account-team for credential reset.',
  next_actions: ['Verify account status in admin panel', 'Check login audit logs', 'Reset credentials if blocked'],
};

function makeTriagePhase(overrides: Partial<TicketPhase> = {}): TicketPhase {
  return {
    id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a003',
    ticket_id: TICKET_ID,
    phase: 'triage',
    status: 'success',
    attempts: 1,
    output: VALID_TRIAGE_ARGS,
    started_at: new Date(),
    completed_at: new Date(),
    ...overrides,
  };
}

function triageResponse(args: object) {
  return {
    choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'triage_ticket', arguments: JSON.stringify(args) } }] } }],
  };
}

function draftResponse(args: object) {
  return {
    choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'draft_resolution', arguments: JSON.stringify(args) } }] } }],
  };
}

function makeFakePortkey(mockCreate: ReturnType<typeof vi.fn>): PortkeyClient {
  return { chat: { completions: { create: mockCreate } } } as unknown as PortkeyClient;
}

describe('AiService.triageTicket', () => {
  let mockCreate: ReturnType<typeof vi.fn>;
  let service: AiService;

  beforeEach(() => {
    mockCreate = vi.fn();
    service = new AiService(makeFakePortkey(mockCreate));
  });

  it('returns TriageOutput on valid tool call response', async () => {
    mockCreate.mockResolvedValueOnce(triageResponse(VALID_TRIAGE_ARGS));

    const result = await service.triageTicket(mockTicket);

    expect(result).toMatchObject({ output: VALID_TRIAGE_ARGS });
  });

  it('throws FatalPhaseError when choices array is empty', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [] });

    await expect(service.triageTicket(mockTicket)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('throws FatalPhaseError when response has no tool call', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { tool_calls: [] } }] });

    await expect(service.triageTicket(mockTicket)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('throws FatalPhaseError when arguments not valid JSON', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'triage_ticket', arguments: 'not-json' } }] } }],
    });

    await expect(service.triageTicket(mockTicket)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('throws FatalPhaseError when Zod validation fails', async () => {
    mockCreate.mockResolvedValueOnce(triageResponse({ ...VALID_TRIAGE_ARGS, category: 'invalid-category' }));

    await expect(service.triageTicket(mockTicket)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('propagates network error as plain Error (retryable)', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Network timeout'));

    let caught: unknown;
    try {
      await service.triageTicket(mockTicket);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(FatalPhaseError);
  });
});

describe('AiService.draftResolution', () => {
  let mockCreate: ReturnType<typeof vi.fn>;
  let service: AiService;

  beforeEach(() => {
    mockCreate = vi.fn();
    service = new AiService(makeFakePortkey(mockCreate));
  });

  it('returns DraftOutput using stored triage context', async () => {
    mockCreate.mockResolvedValueOnce(draftResponse(VALID_DRAFT_ARGS));

    const result = await service.draftResolution(mockTicket, [makeTriagePhase()]);

    expect(result).toMatchObject({ output: VALID_DRAFT_ARGS });
  });

  it('throws FatalPhaseError when triage phase not in success status', async () => {
    await expect(
      service.draftResolution(mockTicket, [makeTriagePhase({ status: 'failure' })]),
    ).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('throws FatalPhaseError when stored triage output is invalid', async () => {
    await expect(
      service.draftResolution(mockTicket, [makeTriagePhase({ output: { bad: 'data' } })]),
    ).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('throws FatalPhaseError when draft Zod validation fails', async () => {
    mockCreate.mockResolvedValueOnce(draftResponse({ ...VALID_DRAFT_ARGS, customer_reply: 'too short' }));

    await expect(
      service.draftResolution(mockTicket, [makeTriagePhase()]),
    ).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('propagates network error as plain Error (retryable)', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Network timeout'));

    let caught: unknown;
    try {
      await service.draftResolution(mockTicket, [makeTriagePhase()]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(FatalPhaseError);
  });
});

describe('AiService.runPhase', () => {
  let mockCreate: ReturnType<typeof vi.fn>;
  let service: AiService;

  beforeEach(() => {
    mockCreate = vi.fn();
    service = new AiService(makeFakePortkey(mockCreate));
  });

  it("routes 'triage' through triageTicket", async () => {
    mockCreate.mockResolvedValueOnce(triageResponse(VALID_TRIAGE_ARGS));

    const result = await service.runPhase(TICKET_ID, 'triage', mockTicket, []);

    expect(result).toMatchObject({ output: VALID_TRIAGE_ARGS });
  });

  it("routes 'draft' through draftResolution", async () => {
    mockCreate.mockResolvedValueOnce(draftResponse(VALID_DRAFT_ARGS));

    const result = await service.runPhase(TICKET_ID, 'draft', mockTicket, [makeTriagePhase()]);

    expect(result).toMatchObject({ output: VALID_DRAFT_ARGS });
  });

  it('throws for unknown phase', async () => {
    await expect(service.runPhase(TICKET_ID, 'unknown' as 'triage', mockTicket, [])).rejects.toThrow();
  });
});
