import request from 'supertest';
import express from 'express';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRetryRouter } from './retry.ts';
import type { RetryRouterDeps } from './retry.ts';

const TID = '018f8a30-52f7-7d9f-bb7d-6924b8d8a001';

function makeDeps(overrides: Partial<RetryRouterDeps> = {}): RetryRouterDeps {
  return {
    getTicketByIdFn: vi.fn().mockResolvedValue({ id: TID }),
    getLatestEventByTicketIdFn: vi.fn().mockResolvedValue({ event_type: 'dlq_routed' }),
    getTicketWithPhasesByIdFn: vi.fn().mockResolvedValue({
      phases: { triage: { status: 'failure' }, draft: { status: 'started' } },
    }),
    resetFailedPhasesFn: vi.fn().mockResolvedValue(undefined),
    updateTicketStatusFn: vi.fn().mockResolvedValue({}),
    transitionTicketStatusFn: vi.fn().mockResolvedValue({}),
    insertEventFn: vi.fn().mockResolvedValue(undefined),
    enqueueTicketFn: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeApp(deps: RetryRouterDeps) {
  const app = express();
  app.use(express.json());
  app.use('/tickets', createRetryRouter(deps));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /tickets/retry/:ticketId', () => {
  it('returns 400 for invalid UUID', async () => {
    const deps = makeDeps();
    const res = await request(makeApp(deps)).post('/tickets/retry/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(deps.getTicketByIdFn).not.toHaveBeenCalled();
  });

  it('returns 202 and enqueues on success', async () => {
    const deps = makeDeps();
    const res = await request(makeApp(deps)).post(`/tickets/retry/${TID}`);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'requeued' });
    expect(deps.enqueueTicketFn).toHaveBeenCalledWith(TID);
  });

  it('maps service error result to HTTP response', async () => {
    const deps = makeDeps({
      getLatestEventByTicketIdFn: vi.fn().mockResolvedValue({ event_type: 'retry_scheduled' }),
    });
    const res = await request(makeApp(deps)).post(`/tickets/retry/${TID}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_retried');
  });

  it('passes force=true from query param', async () => {
    const deps = makeDeps({
      getLatestEventByTicketIdFn: vi.fn().mockResolvedValue({ event_type: 'phase_failed' }),
    });
    const res = await request(makeApp(deps)).post(`/tickets/retry/${TID}?force=true`);
    expect(res.status).toBe(202);
    expect(deps.updateTicketStatusFn).toHaveBeenCalledWith(TID, 'queued');
  });
});
