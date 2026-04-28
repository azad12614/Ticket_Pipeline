import { describe, expect, it, vi } from 'vitest';
import { processTicketLifecycle } from './ticketWorker.ts';
import type { WorkerDeps } from './ticketWorker.ts';
import type { Ticket } from '../schemas/ticketSchema.ts';
import type { TicketPhase } from '../schemas/phaseSchema.ts';

const TICKET_ID = '018f8a30-52f7-7d9f-bb7d-6924b8d8a002';
const RECEIPT = 'test-receipt-handle';

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

function makePhase(overrides: Partial<TicketPhase> = {}): TicketPhase {
  return {
    id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a201',
    ticket_id: TICKET_ID,
    phase: 'triage',
    status: 'started',
    attempts: 0,
    output: null,
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

function makePhaseResult(output: unknown = {}) {
  return { output, durationMs: 0, provider: 'test' };
}

function makeWorkerDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    getTicketByIdFn: vi.fn().mockResolvedValue(null),
    getTicketPhasesByTicketIdFn: vi.fn().mockResolvedValue([]),
    transitionTicketStatusFn: vi.fn().mockResolvedValue(null),
    updateTicketStatusFn: vi.fn().mockResolvedValue(null),
    claimPhaseForProcessingFn: vi.fn().mockResolvedValue(null),
    completePhaseSuccessFn: vi.fn().mockResolvedValue(null),
    failPhaseAttemptFn: vi.fn().mockResolvedValue(null),
    completeTicketFn: vi.fn().mockResolvedValue(null),
    failTicketFn: vi.fn().mockResolvedValue(null),
    insertEventFn: vi.fn().mockResolvedValue(undefined),
    changeMessageVisibilityFn: vi.fn().mockResolvedValue(undefined),
    deleteMessageFn: vi.fn().mockResolvedValue(undefined),
    processPhaseFn: vi.fn().mockResolvedValue(makePhaseResult()),
    ...overrides,
  };
}

describe('processTicketLifecycle', () => {
  it('transitions queued -> processing -> completed after both phases succeed', async () => {
    const transitionTicketStatusFn = vi.fn().mockResolvedValue(makeTicket({ status: 'processing' }));
    const completeTicketFn = vi.fn().mockResolvedValue(makeTicket({ status: 'completed' }));
    const deleteMessageFn = vi.fn().mockResolvedValue(undefined);

    const getTicketPhasesByTicketIdFn = vi.fn()
      .mockResolvedValueOnce([
        makePhase({ phase: 'triage', status: 'started' }),
        makePhase({ id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202', phase: 'draft', status: 'started' }),
      ])
      .mockResolvedValueOnce([
        makePhase({ phase: 'triage', status: 'success', output: { category: 'billing' } }),
        makePhase({ id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202', phase: 'draft', status: 'started' }),
      ])
      .mockResolvedValueOnce([
        makePhase({ phase: 'triage', status: 'success', output: { category: 'billing' } }),
        makePhase({ id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202', phase: 'draft', status: 'success', output: { reply: 'done' } }),
      ]);

    const processPhaseFn = vi.fn()
      .mockResolvedValueOnce(makePhaseResult({ category: 'billing' }))
      .mockResolvedValueOnce(makePhaseResult({ reply: 'done' }));

    await processTicketLifecycle(TICKET_ID, RECEIPT, makeWorkerDeps({
      getTicketByIdFn: vi.fn().mockResolvedValue(makeTicket({ status: 'queued' })),
      getTicketPhasesByTicketIdFn,
      transitionTicketStatusFn,
      completeTicketFn,
      claimPhaseForProcessingFn: vi.fn()
        .mockResolvedValueOnce(makePhase({ phase: 'triage', status: 'progress', started_at: new Date() }))
        .mockResolvedValueOnce(makePhase({ phase: 'draft', status: 'progress', started_at: new Date() })),
      completePhaseSuccessFn: vi.fn().mockResolvedValue(makePhase({ status: 'success', completed_at: new Date() })),
      processPhaseFn,
      deleteMessageFn,
    }));

    expect(transitionTicketStatusFn).toHaveBeenCalledWith(TICKET_ID, ['queued'], 'processing');
    expect(completeTicketFn).toHaveBeenCalledWith(TICKET_ID);
    expect(processPhaseFn).toHaveBeenNthCalledWith(1, TICKET_ID, 'triage');
    expect(processPhaseFn).toHaveBeenNthCalledWith(2, TICKET_ID, 'draft');
    expect(deleteMessageFn).toHaveBeenCalledWith(RECEIPT);
  });

  it('keeps ticket queued when a phase fails before max attempts', async () => {
    const transitionTicketStatusFn = vi.fn()
      .mockResolvedValueOnce(makeTicket({ status: 'processing' }))
      .mockResolvedValueOnce(makeTicket({ status: 'queued' }));

    const failPhaseAttemptFn = vi.fn().mockResolvedValue(
      makePhase({ phase: 'triage', status: 'failure', attempts: 1 }),
    );
    const changeMessageVisibilityFn = vi.fn().mockResolvedValue(undefined);

    await processTicketLifecycle(TICKET_ID, RECEIPT, makeWorkerDeps({
      getTicketByIdFn: vi.fn().mockResolvedValue(makeTicket({ status: 'queued' })),
      getTicketPhasesByTicketIdFn: vi.fn().mockResolvedValue([
        makePhase({ phase: 'triage', status: 'started' }),
        makePhase({ id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202', phase: 'draft', status: 'started' }),
      ]),
      transitionTicketStatusFn,
      claimPhaseForProcessingFn: vi.fn().mockResolvedValue(makePhase({ phase: 'triage', status: 'progress' })),
      failPhaseAttemptFn,
      changeMessageVisibilityFn,
      processPhaseFn: vi.fn().mockRejectedValue(new Error('processing failed')),
    }));

    expect(transitionTicketStatusFn).toHaveBeenNthCalledWith(2, TICKET_ID, ['processing'], 'queued');
    expect(failPhaseAttemptFn).toHaveBeenCalledWith(TICKET_ID, 'triage', 'processing failed');
    expect(changeMessageVisibilityFn).toHaveBeenCalledWith(RECEIPT, expect.any(Number));
  });

  it('does not re-run a successful phase when re-processing a queued ticket', async () => {
    const processPhaseFn = vi.fn().mockResolvedValue(makePhaseResult({ reply: 'drafted' }));
    const completeTicketFn = vi.fn().mockResolvedValue(makeTicket({ status: 'completed' }));

    const getTicketPhasesByTicketIdFn = vi.fn()
      .mockResolvedValueOnce([
        makePhase({ phase: 'triage', status: 'success', output: { category: 'billing' } }),
        makePhase({ id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202', phase: 'draft', status: 'started' }),
      ])
      .mockResolvedValueOnce([
        makePhase({ phase: 'triage', status: 'success', output: { category: 'billing' } }),
        makePhase({ id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202', phase: 'draft', status: 'success', output: { reply: 'drafted' } }),
      ]);

    await processTicketLifecycle(TICKET_ID, RECEIPT, makeWorkerDeps({
      getTicketByIdFn: vi.fn().mockResolvedValue(makeTicket({ status: 'queued' })),
      getTicketPhasesByTicketIdFn,
      transitionTicketStatusFn: vi.fn().mockResolvedValue(makeTicket({ status: 'processing' })),
      completeTicketFn,
      claimPhaseForProcessingFn: vi.fn().mockResolvedValue(makePhase({ phase: 'draft', status: 'progress' })),
      completePhaseSuccessFn: vi.fn().mockResolvedValue(makePhase({ phase: 'draft', status: 'success' })),
      processPhaseFn,
    }));

    expect(processPhaseFn).toHaveBeenCalledTimes(1);
    expect(processPhaseFn).toHaveBeenCalledWith(TICKET_ID, 'draft');
    expect(completeTicketFn).toHaveBeenCalledWith(TICKET_ID);
  });

  it('skips all processing for terminal ticket states', async () => {
    const processPhaseFn = vi.fn();
    const transitionTicketStatusFn = vi.fn();

    await processTicketLifecycle(TICKET_ID, RECEIPT, makeWorkerDeps({
      getTicketByIdFn: vi.fn().mockResolvedValue(makeTicket({ status: 'completed' })),
      transitionTicketStatusFn,
      processPhaseFn,
    }));

    expect(processPhaseFn).not.toHaveBeenCalled();
    expect(transitionTicketStatusFn).not.toHaveBeenCalled();
  });

  it('skips processing when ticket is not found in the database', async () => {
    const transitionTicketStatusFn = vi.fn();
    const processPhaseFn = vi.fn();

    await processTicketLifecycle(TICKET_ID, RECEIPT, makeWorkerDeps({
      getTicketByIdFn: vi.fn().mockResolvedValue(null),
      transitionTicketStatusFn,
      processPhaseFn,
    }));

    expect(transitionTicketStatusFn).not.toHaveBeenCalled();
    expect(processPhaseFn).not.toHaveBeenCalled();
  });

  it('marks ticket failed and deletes message after phase reaches 3 attempts', async () => {
    const failTicketFn = vi.fn().mockResolvedValue(makeTicket({ status: 'failed' }));
    const deleteMessageFn = vi.fn().mockResolvedValue(undefined);
    const changeMessageVisibilityFn = vi.fn().mockResolvedValue(undefined);

    await processTicketLifecycle(TICKET_ID, RECEIPT, makeWorkerDeps({
      getTicketByIdFn: vi.fn().mockResolvedValue(makeTicket({ status: 'queued' })),
      getTicketPhasesByTicketIdFn: vi.fn().mockResolvedValue([
        makePhase({ phase: 'triage', status: 'started' }),
        makePhase({ id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202', phase: 'draft', status: 'started' }),
      ]),
      transitionTicketStatusFn: vi.fn().mockResolvedValue(makeTicket({ status: 'processing' })),
      failTicketFn,
      claimPhaseForProcessingFn: vi.fn().mockResolvedValue(makePhase({ phase: 'triage', status: 'progress', started_at: new Date() })),
      failPhaseAttemptFn: vi.fn().mockResolvedValue(makePhase({ phase: 'triage', status: 'failure', attempts: 3 })),
      insertEventFn: vi.fn().mockResolvedValue(undefined),
      changeMessageVisibilityFn,
      deleteMessageFn,
      processPhaseFn: vi.fn().mockRejectedValue(new Error('phase error')),
    }));

    expect(failTicketFn).toHaveBeenCalledWith(TICKET_ID);
    expect(deleteMessageFn).toHaveBeenCalledWith(RECEIPT);
    expect(changeMessageVisibilityFn).not.toHaveBeenCalled();
  });

  it('stores each phase output linked to the ticket id', async () => {
    const triageOutput = { category: 'billing' };
    const draftOutput = { reply: 'resolved' };
    const completePhaseSuccessFn = vi.fn().mockResolvedValue(makePhase({ status: 'success', completed_at: new Date() }));

    await processTicketLifecycle(TICKET_ID, RECEIPT, makeWorkerDeps({
      getTicketByIdFn: vi.fn().mockResolvedValue(makeTicket({ status: 'queued' })),
      getTicketPhasesByTicketIdFn: vi.fn()
        .mockResolvedValueOnce([
          makePhase({ phase: 'triage', status: 'started' }),
          makePhase({ id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202', phase: 'draft', status: 'started' }),
        ])
        .mockResolvedValueOnce([
          makePhase({ phase: 'triage', status: 'success', output: triageOutput }),
          makePhase({ id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202', phase: 'draft', status: 'started' }),
        ])
        .mockResolvedValueOnce([
          makePhase({ phase: 'triage', status: 'success', output: triageOutput }),
          makePhase({ id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202', phase: 'draft', status: 'success', output: draftOutput }),
        ]),
      transitionTicketStatusFn: vi.fn().mockResolvedValue(makeTicket({ status: 'processing' })),
      completeTicketFn: vi.fn().mockResolvedValue(makeTicket({ status: 'completed' })),
      claimPhaseForProcessingFn: vi.fn()
        .mockResolvedValueOnce(makePhase({ phase: 'triage', status: 'progress', started_at: new Date() }))
        .mockResolvedValueOnce(makePhase({ phase: 'draft', status: 'progress', started_at: new Date() })),
      completePhaseSuccessFn,
      processPhaseFn: vi.fn()
        .mockResolvedValueOnce(makePhaseResult(triageOutput))
        .mockResolvedValueOnce(makePhaseResult(draftOutput)),
    }));

    expect(completePhaseSuccessFn).toHaveBeenNthCalledWith(1, TICKET_ID, 'triage', triageOutput, { durationMs: 0, provider: 'test' });
    expect(completePhaseSuccessFn).toHaveBeenNthCalledWith(2, TICKET_ID, 'draft', draftOutput, { durationMs: 0, provider: 'test' });
  });

  it('claims only the pending phase when triage already succeeded', async () => {
    const claimPhaseForProcessingFn = vi.fn().mockResolvedValue(
      makePhase({ phase: 'draft', status: 'progress', started_at: new Date() }),
    );

    await processTicketLifecycle(TICKET_ID, RECEIPT, makeWorkerDeps({
      getTicketByIdFn: vi.fn().mockResolvedValue(makeTicket({ status: 'queued' })),
      getTicketPhasesByTicketIdFn: vi.fn()
        .mockResolvedValueOnce([
          makePhase({ phase: 'triage', status: 'success', output: { category: 'billing' } }),
          makePhase({ id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202', phase: 'draft', status: 'started' }),
        ])
        .mockResolvedValueOnce([
          makePhase({ phase: 'triage', status: 'success', output: { category: 'billing' } }),
          makePhase({ id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202', phase: 'draft', status: 'success', output: { reply: 'done' } }),
        ]),
      transitionTicketStatusFn: vi.fn().mockResolvedValue(makeTicket({ status: 'processing' })),
      completeTicketFn: vi.fn().mockResolvedValue(makeTicket({ status: 'completed' })),
      claimPhaseForProcessingFn,
      completePhaseSuccessFn: vi.fn().mockResolvedValue(makePhase({ phase: 'draft', status: 'success', completed_at: new Date() })),
      processPhaseFn: vi.fn().mockResolvedValue(makePhaseResult({ reply: 'done' })),
    }));

    expect(claimPhaseForProcessingFn).toHaveBeenCalledTimes(1);
    expect(claimPhaseForProcessingFn).toHaveBeenCalledWith(TICKET_ID, 'draft');
  });
});
