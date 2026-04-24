import { describe, expect, it, vi } from 'vitest';
import { submitTicket } from './ticketService.ts';
import type { Ticket, TicketInput } from '../schemas/ticketSchema.ts';

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a001',
    subject: 'Subject',
    body: 'Body',
    status: 'queued',
    archived_at: null,
    created_at: new Date('2026-04-24T00:00:00.000Z'),
    updated_at: new Date('2026-04-24T00:00:00.000Z'),
    ...overrides,
  };
}

describe('submitTicket', () => {
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

    const ticket = await submitTicket(input, { createTicketFn, enqueueTicketFn });

    expect(ticket.id).toBe('018f8a30-52f7-7d9f-bb7d-6924b8d8a001');
    expect(callOrder).toEqual(['create', 'enqueue:018f8a30-52f7-7d9f-bb7d-6924b8d8a001']);
  });
});
