import { describe, expect, it, vi } from 'vitest';
import { submitTicket, listTickets, getTicket, NotFoundError } from './ticketService.ts';
import type { Ticket, TicketInput } from '../schemas/ticketSchema.ts';
import type { TicketWithPhases } from '../repositories/ticketRepo.ts';

const TICKET_ID = '018f8a30-52f7-7d9f-bb7d-6924b8d8a001';

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: TICKET_ID,
    subject: 'Subject',
    body: 'Body',
    status: 'queued',
    archived_at: null,
    created_at: new Date('2026-04-24T00:00:00.000Z'),
    updated_at: new Date('2026-04-24T00:00:00.000Z'),
    ...overrides,
  };
}

function makeTicketWithPhases(overrides: Partial<TicketWithPhases> = {}): TicketWithPhases {
  return {
    ...makeTicket(),
    phases: {
      triage: { status: 'started', attempts: 0, output: null },
      draft: { status: 'started', attempts: 0, output: null },
    },
    events: [],
    ...overrides,
  };
}

describe('submitTicket', () => {
  // US-1.1: ticket persisted with queued status before processing begins
  it('returns ticket with queued status immediately on submission', async () => {
    const input: TicketInput = { subject: 'Test subject', body: 'Test body' };

    const ticket = await submitTicket(input, {
      createTicketFn: vi.fn().mockResolvedValue(makeTicket({ status: 'queued' })),
      enqueueTicketFn: vi.fn(),
      insertEventFn: vi.fn(),
    });

    expect(ticket.status).toBe('queued');
    expect(ticket.id).toBe(TICKET_ID);
  });

  // US-1.1: ticket saved before background work starts
  it('creates ticket before enqueueing id', async () => {
    const callOrder: string[] = [];
    const input: TicketInput = { subject: 'A', body: 'B' };

    const createTicketFn = vi.fn(async () => {
      callOrder.push('create');
      return makeTicket();
    });

    const enqueueTicketFn = vi.fn((ticketId: string) => {
      callOrder.push(`enqueue:${ticketId}`);
    });

    const ticket = await submitTicket(input, { createTicketFn, enqueueTicketFn, insertEventFn: vi.fn() });

    expect(ticket.id).toBe(TICKET_ID);
    expect(callOrder).toEqual(['create', `enqueue:${TICKET_ID}`]);
  });
});

describe('listTickets', () => {
  it('returns array of tickets from getAllTicketsFn', async () => {
    const row = { id: TICKET_ID, status: 'queued' as const, created_at: new Date() };
    const result = await listTickets({
      getAllTicketsFn: vi.fn().mockResolvedValue([row]),
    });

    expect(result).toEqual([row]);
  });

  it('returns empty array when no tickets exist', async () => {
    const result = await listTickets({
      getAllTicketsFn: vi.fn().mockResolvedValue([]),
    });

    expect(result).toEqual([]);
  });
});

describe('getTicket', () => {
  it('returns TicketWithPhases for a known id', async () => {
    const full = makeTicketWithPhases();
    const result = await getTicket(TICKET_ID, {
      getTicketWithPhasesByIdFn: vi.fn().mockResolvedValue(full),
    });

    expect(result).toBe(full);
  });

  it('throws NotFoundError when ticket does not exist', async () => {
    await expect(
      getTicket(TICKET_ID, {
        getTicketWithPhasesByIdFn: vi.fn().mockResolvedValue(null),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('NotFoundError carries code 404', async () => {
    let caught: unknown;
    try {
      await getTicket(TICKET_ID, {
        getTicketWithPhasesByIdFn: vi.fn().mockResolvedValue(null),
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as NotFoundError).code).toBe(404);
  });
});
