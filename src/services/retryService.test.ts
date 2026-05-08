import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retryTicket, type RetryTicketDeps } from './retryService.ts';

const TID = '018f8a30-52f7-7d9f-bb7d-6924b8d8a001';
const DEFAULT_OPTS = { force: false, actor: '127.0.0.1' };

function makeDeps(overrides: Partial<RetryTicketDeps> = {}): RetryTicketDeps {
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('retryTicket', () => {
  it('returns 404 when ticket not found', async () => {
    const deps = makeDeps({ getTicketByIdFn: vi.fn().mockResolvedValue(null) });
    const result = await retryTicket(TID, DEFAULT_OPTS, deps);
    expect(result).toMatchObject({ ok: false, code: 404, error: 'ticket_not_found' });
    expect(deps.enqueueTicketFn).not.toHaveBeenCalled();
  });

  it('returns 409 when latest event is retry_scheduled', async () => {
    const deps = makeDeps({
      getLatestEventByTicketIdFn: vi.fn().mockResolvedValue({ event_type: 'retry_scheduled' }),
    });
    const result = await retryTicket(TID, DEFAULT_OPTS, deps);
    expect(result).toMatchObject({ ok: false, code: 409, error: 'already_retried' });
    expect(deps.enqueueTicketFn).not.toHaveBeenCalled();
  });

  it('returns 400 when latest event is not dlq_routed', async () => {
    const deps = makeDeps({
      getLatestEventByTicketIdFn: vi.fn().mockResolvedValue({ event_type: 'phase_failed' }),
    });
    const result = await retryTicket(TID, DEFAULT_OPTS, deps);
    expect(result).toMatchObject({ ok: false, code: 400, error: 'not_dlq_routed' });
    expect(deps.enqueueTicketFn).not.toHaveBeenCalled();
  });

  it('returns 400 when all phases already succeeded', async () => {
    const deps = makeDeps({
      getTicketWithPhasesByIdFn: vi.fn().mockResolvedValue({
        phases: { triage: { status: 'success' }, draft: { status: 'success' } },
      }),
    });
    const result = await retryTicket(TID, DEFAULT_OPTS, deps);
    expect(result).toMatchObject({ ok: false, code: 400, error: 'already_completed' });
    expect(deps.enqueueTicketFn).not.toHaveBeenCalled();
  });

  it('returns 400 when a phase is in progress', async () => {
    const deps = makeDeps({
      getTicketWithPhasesByIdFn: vi.fn().mockResolvedValue({
        phases: { triage: { status: 'progress' }, draft: { status: 'started' } },
      }),
    });
    const result = await retryTicket(TID, DEFAULT_OPTS, deps);
    expect(result).toMatchObject({ ok: false, code: 400, error: 'phase_in_progress' });
    expect(deps.enqueueTicketFn).not.toHaveBeenCalled();
  });

  it('resets phases, transitions status, enqueues, and inserts event on success', async () => {
    const deps = makeDeps();
    const result = await retryTicket(TID, DEFAULT_OPTS, deps);
    expect(result).toEqual({ ok: true });
    expect(deps.resetFailedPhasesFn).toHaveBeenCalledWith(TID);
    expect(deps.transitionTicketStatusFn).toHaveBeenCalledWith(TID, ['failed'], 'queued');
    expect(deps.updateTicketStatusFn).not.toHaveBeenCalled();
    expect(deps.enqueueTicketFn).toHaveBeenCalledWith(TID);
    expect(deps.insertEventFn).toHaveBeenCalledWith(
      TID,
      'retry_scheduled',
      null,
      expect.objectContaining({ by: 'ops', actor: '127.0.0.1', manual: true, force: false }),
    );
  });

  it('force: bypasses DLQ check, uses updateTicketStatus, records force flag', async () => {
    const deps = makeDeps({
      getLatestEventByTicketIdFn: vi.fn().mockResolvedValue({ event_type: 'phase_failed' }),
    });
    const result = await retryTicket(TID, { force: true, actor: 'admin' }, deps);
    expect(result).toEqual({ ok: true });
    expect(deps.updateTicketStatusFn).toHaveBeenCalledWith(TID, 'queued');
    expect(deps.transitionTicketStatusFn).not.toHaveBeenCalled();
    expect(deps.insertEventFn).toHaveBeenCalledWith(
      TID,
      'retry_scheduled',
      null,
      expect.objectContaining({ force: true, actor: 'admin' }),
    );
  });

  it('force: bypasses already_retried check', async () => {
    const deps = makeDeps({
      getLatestEventByTicketIdFn: vi.fn().mockResolvedValue({ event_type: 'retry_scheduled' }),
    });
    const result = await retryTicket(TID, { force: true, actor: 'admin' }, deps);
    expect(result).toEqual({ ok: true });
  });
});
