import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiService, type PortkeyClient } from './aiService.ts';
import { FatalPhaseError } from '../lib/errors.ts';
import type { ITicketRepo } from '../repositories/ticketRepo.ts';
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

function makeFakeRepo(): ITicketRepo {
  return {
    createTicket: vi.fn(),
    getTicketById: vi.fn(),
    getTicketPhasesByTicketId: vi.fn(),
    getTicketWithPhasesById: vi.fn(),
    updateTicketStatus: vi.fn(),
    transitionTicketStatus: vi.fn(),
    claimPhaseForProcessing: vi.fn(),
    completePhaseSuccess: vi.fn(),
    failPhaseAttempt: vi.fn(),
  };
}

function makeFakePortkey(mockCreate: ReturnType<typeof vi.fn>): PortkeyClient {
  return { chat: { completions: { create: mockCreate } } } as unknown as PortkeyClient;
}

describe('AiService.triageTicket', () => {
  let repo: ITicketRepo;
  let mockCreate: ReturnType<typeof vi.fn>;
  let service: AiService;

  beforeEach(() => {
    repo = makeFakeRepo();
    mockCreate = vi.fn();
    service = new AiService(repo, makeFakePortkey(mockCreate));
  });

  it('returns TriageOutput on valid tool call response', async () => {
    vi.mocked(repo.getTicketById).mockResolvedValueOnce(mockTicket);
    mockCreate.mockResolvedValueOnce(triageResponse(VALID_TRIAGE_ARGS));

    const result = await service.triageTicket(TICKET_ID);

    expect(result).toEqual(VALID_TRIAGE_ARGS);
  });

  it('throws FatalPhaseError when ticket not found', async () => {
    vi.mocked(repo.getTicketById).mockResolvedValueOnce(null);

    await expect(service.triageTicket(TICKET_ID)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('throws FatalPhaseError when choices array is empty', async () => {
    vi.mocked(repo.getTicketById).mockResolvedValueOnce(mockTicket);
    mockCreate.mockResolvedValueOnce({ choices: [] });

    await expect(service.triageTicket(TICKET_ID)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('throws FatalPhaseError when response has no tool call', async () => {
    vi.mocked(repo.getTicketById).mockResolvedValueOnce(mockTicket);
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { tool_calls: [] } }] });

    await expect(service.triageTicket(TICKET_ID)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('throws FatalPhaseError when arguments not valid JSON', async () => {
    vi.mocked(repo.getTicketById).mockResolvedValueOnce(mockTicket);
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'triage_ticket', arguments: 'not-json' } }] } }],
    });

    await expect(service.triageTicket(TICKET_ID)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('throws FatalPhaseError when Zod validation fails', async () => {
    vi.mocked(repo.getTicketById).mockResolvedValueOnce(mockTicket);
    mockCreate.mockResolvedValueOnce(triageResponse({ ...VALID_TRIAGE_ARGS, category: 'invalid-category' }));

    await expect(service.triageTicket(TICKET_ID)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('propagates network error as plain Error (retryable)', async () => {
    vi.mocked(repo.getTicketById).mockResolvedValueOnce(mockTicket);
    mockCreate.mockRejectedValueOnce(new Error('Network timeout'));

    let caught: unknown;
    try {
      await service.triageTicket(TICKET_ID);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(FatalPhaseError);
  });
});

describe('AiService.draftResolution', () => {
  let repo: ITicketRepo;
  let mockCreate: ReturnType<typeof vi.fn>;
  let service: AiService;

  beforeEach(() => {
    repo = makeFakeRepo();
    mockCreate = vi.fn();
    service = new AiService(repo, makeFakePortkey(mockCreate));
  });

  it('returns DraftOutput using stored triage context', async () => {
    vi.mocked(repo.getTicketById).mockResolvedValueOnce(mockTicket);
    vi.mocked(repo.getTicketPhasesByTicketId).mockResolvedValueOnce([makeTriagePhase()]);
    mockCreate.mockResolvedValueOnce(draftResponse(VALID_DRAFT_ARGS));

    const result = await service.draftResolution(TICKET_ID);

    expect(result).toEqual(VALID_DRAFT_ARGS);
  });

  it('throws FatalPhaseError when ticket not found', async () => {
    vi.mocked(repo.getTicketById).mockResolvedValueOnce(null);
    vi.mocked(repo.getTicketPhasesByTicketId).mockResolvedValueOnce([makeTriagePhase()]);

    await expect(service.draftResolution(TICKET_ID)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('throws FatalPhaseError when triage phase not in success status', async () => {
    vi.mocked(repo.getTicketById).mockResolvedValueOnce(mockTicket);
    vi.mocked(repo.getTicketPhasesByTicketId).mockResolvedValueOnce([
      makeTriagePhase({ status: 'failure' }),
    ]);

    await expect(service.draftResolution(TICKET_ID)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('throws FatalPhaseError when stored triage output is invalid', async () => {
    vi.mocked(repo.getTicketById).mockResolvedValueOnce(mockTicket);
    vi.mocked(repo.getTicketPhasesByTicketId).mockResolvedValueOnce([
      makeTriagePhase({ output: { bad: 'data' } }),
    ]);

    await expect(service.draftResolution(TICKET_ID)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('throws FatalPhaseError when draft Zod validation fails', async () => {
    vi.mocked(repo.getTicketById).mockResolvedValueOnce(mockTicket);
    vi.mocked(repo.getTicketPhasesByTicketId).mockResolvedValueOnce([makeTriagePhase()]);
    mockCreate.mockResolvedValueOnce(draftResponse({ ...VALID_DRAFT_ARGS, customer_reply: 'too short' }));

    await expect(service.draftResolution(TICKET_ID)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('propagates network error as plain Error (retryable)', async () => {
    vi.mocked(repo.getTicketById).mockResolvedValueOnce(mockTicket);
    vi.mocked(repo.getTicketPhasesByTicketId).mockResolvedValueOnce([makeTriagePhase()]);
    mockCreate.mockRejectedValueOnce(new Error('Network timeout'));

    let caught: unknown;
    try {
      await service.draftResolution(TICKET_ID);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(FatalPhaseError);
  });
});

describe('AiService.runPhase', () => {
  let repo: ITicketRepo;
  let mockCreate: ReturnType<typeof vi.fn>;
  let service: AiService;

  beforeEach(() => {
    repo = makeFakeRepo();
    mockCreate = vi.fn();
    service = new AiService(repo, makeFakePortkey(mockCreate));
  });

  it("routes 'triage' through triageTicket", async () => {
    vi.mocked(repo.getTicketById).mockResolvedValueOnce(mockTicket);
    mockCreate.mockResolvedValueOnce(triageResponse(VALID_TRIAGE_ARGS));

    const result = await service.runPhase(TICKET_ID, 'triage');

    expect(result).toEqual(VALID_TRIAGE_ARGS);
  });

  it("routes 'draft' through draftResolution", async () => {
    vi.mocked(repo.getTicketById).mockResolvedValueOnce(mockTicket);
    vi.mocked(repo.getTicketPhasesByTicketId).mockResolvedValueOnce([makeTriagePhase()]);
    mockCreate.mockResolvedValueOnce(draftResponse(VALID_DRAFT_ARGS));

    const result = await service.runPhase(TICKET_ID, 'draft');

    expect(result).toEqual(VALID_DRAFT_ARGS);
  });

  it('throws for unknown phase', async () => {
    await expect(service.runPhase(TICKET_ID, 'unknown' as 'triage')).rejects.toThrow();
  });
});
