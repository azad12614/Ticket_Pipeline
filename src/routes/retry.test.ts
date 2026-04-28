import request from 'supertest';
import express from 'express';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks for collaborators
const mockEnqueue = vi.fn();
const mockGetTicketById = vi.fn();
const mockGetLatestEvent = vi.fn();
const mockGetTicketWithPhases = vi.fn();
const mockInsertEvent = vi.fn();

vi.mock('../queues/ticketQueue.ts', () => ({
  enqueueTicket: (id: string) => mockEnqueue(id),
}));

vi.mock('../repositories/ticketRepo.ts', () => ({
  postgresTicketRepo: {
    getTicketById: (id: string) => mockGetTicketById(id),
    getLatestEventByTicketId: (id: string) => mockGetLatestEvent(id),
    getTicketWithPhasesById: (id: string) => mockGetTicketWithPhases(id),
    insertEvent: (ticketId: string, eventType: string, phase: unknown, payload: unknown) =>
      mockInsertEvent(ticketId, eventType, phase, payload),
  },
}));

import retryRouter from './retry.ts';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/tickets', retryRouter);
  return app;
}

const TID = '018f8a30-52f7-7d9f-bb7d-6924b8d8a001';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /tickets/retry/:ticketId', () => {
  it('requeues when latest event is dlq_routed and phases are not completed', async () => {
    mockGetTicketById.mockResolvedValue({ id: TID });
    mockGetLatestEvent.mockResolvedValue({ event_type: 'dlq_routed' });
    mockGetTicketWithPhases.mockResolvedValue({
      phases: { triage: { status: 'failure' }, draft: { status: 'started' } },
    });

    const app = makeApp();
    const res = await request(app).post(`/tickets/retry/${TID}`);

    expect(res.status).toBe(202);
    expect(mockEnqueue).toHaveBeenCalledWith(TID);
    expect(mockInsertEvent).toHaveBeenCalledWith(
      TID,
      'retry_scheduled',
      null,
      expect.objectContaining({ by: 'ops', manual: true }),
    );
  });

  it('rejects when latest event is not dlq_routed and not forced', async () => {
    mockGetTicketById.mockResolvedValue({ id: TID });
    mockGetLatestEvent.mockResolvedValue({ event_type: 'phase_failed' });

    const app = makeApp();
    const res = await request(app).post(`/tickets/retry/${TID}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('not_dlq_routed');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('returns 409 when ticket was already manually retried', async () => {
    mockGetTicketById.mockResolvedValue({ id: TID });
    mockGetLatestEvent.mockResolvedValue({ event_type: 'retry_scheduled' });

    const app = makeApp();
    const res = await request(app).post(`/tickets/retry/${TID}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_retried');
  });

  it('rejects when all phases are success', async () => {
    mockGetTicketById.mockResolvedValue({ id: TID });
    mockGetLatestEvent.mockResolvedValue({ event_type: 'dlq_routed' });
    mockGetTicketWithPhases.mockResolvedValue({
      phases: { triage: { status: 'success' }, draft: { status: 'success' } },
    });

    const app = makeApp();
    const res = await request(app).post(`/tickets/retry/${TID}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('already_completed');
  });
});
