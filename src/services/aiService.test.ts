import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { triageTicket, draftResolution, runPhase } from './aiService.ts';
import { FatalPhaseError } from '../lib/errors.ts';

const { mockCreate, mockGetTicketById, mockGetTicketPhasesByTicketId } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockGetTicketById: vi.fn(),
  mockGetTicketPhasesByTicketId: vi.fn(),
}));

vi.mock('portkey-ai', () => ({
  Portkey: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

vi.mock('../repositories/ticketRepo.ts', () => ({
  getTicketById: mockGetTicketById,
  getTicketPhasesByTicketId: mockGetTicketPhasesByTicketId,
}));

const TICKET_ID = '018f8a30-52f7-7d9f-bb7d-6924b8d8a002';

const mockTicket = {
  id: TICKET_ID,
  subject: 'Cannot access my account',
  body: 'I have been unable to log in for 3 days.',
  status: 'processing' as const,
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

function triageResponse(args: object) {
  return {
    choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'triage_ticket', arguments: JSON.stringify(args) } }] } }],
  };
}

beforeAll(() => {
  process.env['PORTKEY_API_KEY'] = 'test-key';
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('triageTicket', () => {
  it('returns TriageOutput on valid tool call response', async () => {
    mockGetTicketById.mockResolvedValueOnce(mockTicket);
    mockCreate.mockResolvedValueOnce(triageResponse(VALID_TRIAGE_ARGS));

    const result = await triageTicket(TICKET_ID);

    expect(result).toEqual(VALID_TRIAGE_ARGS);
  });

  it('throws FatalPhaseError when ticket not found', async () => {
    mockGetTicketById.mockResolvedValueOnce(null);

    await expect(triageTicket(TICKET_ID)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('throws FatalPhaseError when response has no tool call', async () => {
    mockGetTicketById.mockResolvedValueOnce(mockTicket);
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { tool_calls: [] } }] });

    await expect(triageTicket(TICKET_ID)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('throws FatalPhaseError when arguments not valid JSON', async () => {
    mockGetTicketById.mockResolvedValueOnce(mockTicket);
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'triage_ticket', arguments: 'not-json' } }] } }],
    });

    await expect(triageTicket(TICKET_ID)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('throws FatalPhaseError when Zod validation fails', async () => {
    mockGetTicketById.mockResolvedValueOnce(mockTicket);
    mockCreate.mockResolvedValueOnce(triageResponse({ ...VALID_TRIAGE_ARGS, category: 'invalid-category' }));

    await expect(triageTicket(TICKET_ID)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('propagates network error as plain Error (retryable)', async () => {
    mockGetTicketById.mockResolvedValueOnce(mockTicket);
    mockCreate.mockRejectedValueOnce(new Error('Network timeout'));

    let caught: unknown;
    try {
      await triageTicket(TICKET_ID);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(FatalPhaseError);
  });
});

// --- shared draft test data ---

const VALID_TRIAGE_OUTPUT = {
  category: 'account',
  priority: 'high',
  sentiment: 'frustrated',
  escalation: false,
  routing_target: 'account-team',
  summary: 'Customer unable to log in for 3 days.',
};

const mockSuccessTriagePhase = {
  id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a003',
  ticket_id: TICKET_ID,
  phase: 'triage' as const,
  status: 'success' as const,
  attempts: 1,
  output: VALID_TRIAGE_OUTPUT,
  started_at: new Date(),
  completed_at: new Date(),
};

const VALID_DRAFT_ARGS = {
  customer_reply: 'Thank you for reaching out. We understand how frustrating it can be to be locked out of your account for multiple days. Our account team will investigate and resolve this within 24 hours.',
  internal_note: 'High priority account access issue. Customer is frustrated. No escalation needed. Route to account-team for credential reset.',
  next_actions: ['Verify account status in admin panel', 'Check login audit logs', 'Reset credentials if blocked'],
};

function draftResponse(args: object) {
  return {
    choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'draft_resolution', arguments: JSON.stringify(args) } }] } }],
  };
}

describe('draftResolution', () => {
  it('returns DraftOutput using stored triage context', async () => {
    mockGetTicketById.mockResolvedValueOnce(mockTicket);
    mockGetTicketPhasesByTicketId.mockResolvedValueOnce([mockSuccessTriagePhase]);
    mockCreate.mockResolvedValueOnce(draftResponse(VALID_DRAFT_ARGS));

    const result = await draftResolution(TICKET_ID);

    expect(result).toEqual(VALID_DRAFT_ARGS);
  });

  it('throws FatalPhaseError when ticket not found', async () => {
    mockGetTicketById.mockResolvedValueOnce(null);
    mockGetTicketPhasesByTicketId.mockResolvedValueOnce([mockSuccessTriagePhase]);

    await expect(draftResolution(TICKET_ID)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('throws FatalPhaseError when triage phase not in success status', async () => {
    mockGetTicketById.mockResolvedValueOnce(mockTicket);
    mockGetTicketPhasesByTicketId.mockResolvedValueOnce([
      { ...mockSuccessTriagePhase, status: 'failure' as const },
    ]);

    await expect(draftResolution(TICKET_ID)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('throws FatalPhaseError when stored triage output is invalid', async () => {
    mockGetTicketById.mockResolvedValueOnce(mockTicket);
    mockGetTicketPhasesByTicketId.mockResolvedValueOnce([
      { ...mockSuccessTriagePhase, output: { bad: 'data' } },
    ]);

    await expect(draftResolution(TICKET_ID)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('throws FatalPhaseError when draft Zod validation fails', async () => {
    mockGetTicketById.mockResolvedValueOnce(mockTicket);
    mockGetTicketPhasesByTicketId.mockResolvedValueOnce([mockSuccessTriagePhase]);
    mockCreate.mockResolvedValueOnce(draftResponse({ ...VALID_DRAFT_ARGS, customer_reply: 'too short' }));

    await expect(draftResolution(TICKET_ID)).rejects.toBeInstanceOf(FatalPhaseError);
  });

  it('propagates network error as plain Error (retryable)', async () => {
    mockGetTicketById.mockResolvedValueOnce(mockTicket);
    mockGetTicketPhasesByTicketId.mockResolvedValueOnce([mockSuccessTriagePhase]);
    mockCreate.mockRejectedValueOnce(new Error('Network timeout'));

    let caught: unknown;
    try {
      await draftResolution(TICKET_ID);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(FatalPhaseError);
  });
});

describe('runPhase', () => {
  it("routes 'triage' through triageTicket", async () => {
    mockGetTicketById.mockResolvedValueOnce(mockTicket);
    mockCreate.mockResolvedValueOnce(triageResponse(VALID_TRIAGE_ARGS));

    const result = await runPhase(TICKET_ID, 'triage');

    expect(result).toEqual(VALID_TRIAGE_ARGS);
  });

  it("routes 'draft' through draftResolution", async () => {
    mockGetTicketById.mockResolvedValueOnce(mockTicket);
    mockGetTicketPhasesByTicketId.mockResolvedValueOnce([mockSuccessTriagePhase]);
    mockCreate.mockResolvedValueOnce(draftResponse(VALID_DRAFT_ARGS));

    const result = await runPhase(TICKET_ID, 'draft');

    expect(result).toEqual(VALID_DRAFT_ARGS);
  });

  it('throws for unknown phase', async () => {
    await expect(runPhase(TICKET_ID, 'unknown' as 'triage')).rejects.toThrow();
  });
});
