import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/ticketService.ts', () => ({
  getTicket: vi.fn(),
  submitTicket: vi.fn(),
}));

import { getTicketStatusHandler } from './ticketController.ts';
import { getTicket } from '../services/ticketService.ts';

function makeResponse() {
  const response = {
    statusCode: 0,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.jsonBody = payload;
      return this;
    },
  };

  return response;
}

describe('ticket status handler', () => {
  it('returns phase status records in the ticket status response', async () => {
    const ticket = {
      id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a102',
      subject: 'Subject',
      body: 'Body',
      status: 'processing',
      archived_at: null,
      created_at: new Date('2026-04-24T00:00:00.000Z'),
      updated_at: new Date('2026-04-24T00:00:00.000Z'),
      phases: {
        triage: {
          status: 'success',
          attempts: 1,
          output: { category: 'billing' },
        },
        draft: {
          status: 'started',
          attempts: 0,
          output: null,
        },
      },
    };

    vi.mocked(getTicket).mockResolvedValue(ticket as never);

    const req = { params: { id: ticket.id } };
    const res = makeResponse();
    const next = vi.fn();

    await getTicketStatusHandler(req as never, res as never, next);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({
      ticketId: ticket.id,
      status: ticket.status,
      phases: ticket.phases,
    });
    expect(next).not.toHaveBeenCalled();
  });
});
