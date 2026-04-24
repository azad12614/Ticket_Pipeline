import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processTicketLifecycle, startTicketWorker } from './ticketWorker.ts';
import { enqueueTicket, purgeQueue } from '../queues/ticketQueue.ts';
import type { Ticket } from '../schemas/ticketSchema.ts';
import type { TicketPhase } from '../schemas/phaseSchema.ts';

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a002',
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
    ticket_id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a002',
    phase: 'triage',
    status: 'started',
    attempts: 0,
    output: null,
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

describe('processTicketLifecycle', () => {
  it('transitions queued -> processing -> completed after both phases succeed', async () => {
    const transitions: Array<{ from: Ticket['status'][]; to: Ticket['status'] }> = [];

    const transitionTicketStatusFn = vi.fn(
      async (
        _id: string,
        fromStatuses: Ticket['status'][],
        toStatus: Ticket['status'],
      ): Promise<Ticket | null> => {
        transitions.push({ from: fromStatuses, to: toStatus });
        return makeTicket({ status: toStatus });
      },
    );

    const claimPhaseForProcessingFn = vi
      .fn()
      .mockResolvedValueOnce(
        makePhase({ phase: 'triage', status: 'progress', started_at: new Date() }),
      )
      .mockResolvedValueOnce(
        makePhase({ phase: 'draft', status: 'progress', started_at: new Date() }),
      );

    const completePhaseSuccessFn = vi.fn(async () =>
      makePhase({ status: 'success', completed_at: new Date() }),
    );

    const getTicketPhasesByTicketIdFn = vi
      .fn()
      .mockResolvedValueOnce([
        makePhase({ phase: 'triage', status: 'started' }),
        makePhase({
          id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202',
          phase: 'draft',
          status: 'started',
        }),
      ])
      .mockResolvedValueOnce([
        makePhase({ phase: 'triage', status: 'success', output: { category: 'billing' } }),
        makePhase({
          id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202',
          phase: 'draft',
          status: 'started',
        }),
      ])
      .mockResolvedValueOnce([
        makePhase({ phase: 'triage', status: 'success', output: { category: 'billing' } }),
        makePhase({
          id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202',
          phase: 'draft',
          status: 'success',
          output: { reply: 'done' },
        }),
      ]);

    const processPhaseFn = vi
      .fn()
      .mockResolvedValueOnce({ category: 'billing' })
      .mockResolvedValueOnce({ reply: 'done' });

    await processTicketLifecycle('018f8a30-52f7-7d9f-bb7d-6924b8d8a002', {
      getTicketByIdFn: vi.fn(async () => makeTicket({ status: 'queued' })),
      getTicketPhasesByTicketIdFn,
      transitionTicketStatusFn,
      claimPhaseForProcessingFn,
      completePhaseSuccessFn,
      processPhaseFn,
    });

    expect(transitions).toEqual([
      { from: ['queued'], to: 'processing' },
      { from: ['processing'], to: 'completed' },
    ]);
    expect(processPhaseFn).toHaveBeenNthCalledWith(
      1,
      '018f8a30-52f7-7d9f-bb7d-6924b8d8a002',
      'triage',
    );
    expect(processPhaseFn).toHaveBeenNthCalledWith(
      2,
      '018f8a30-52f7-7d9f-bb7d-6924b8d8a002',
      'draft',
    );
  });

  it('keeps ticket queued when a phase fails before max attempts', async () => {
    const transitionTicketStatusFn = vi
      .fn()
      .mockResolvedValueOnce(makeTicket({ status: 'processing' }))
      .mockResolvedValueOnce(makeTicket({ status: 'queued' }));

    const getTicketPhasesByTicketIdFn = vi.fn(async () => [
      makePhase({ phase: 'triage', status: 'started' }),
      makePhase({
        id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202',
        phase: 'draft',
        status: 'started',
      }),
    ]);

    const failPhaseAttemptFn = vi.fn(async () =>
      makePhase({ phase: 'triage', status: 'failure', attempts: 1 }),
    );
    const enqueueTicketFn = vi.fn(async () => {});

    await processTicketLifecycle('018f8a30-52f7-7d9f-bb7d-6924b8d8a002', {
      getTicketByIdFn: vi.fn(async () => makeTicket({ status: 'queued' })),
      getTicketPhasesByTicketIdFn,
      transitionTicketStatusFn,
      claimPhaseForProcessingFn: vi.fn(async () =>
        makePhase({ phase: 'triage', status: 'progress' }),
      ),
      failPhaseAttemptFn,
      enqueueTicketFn,
      processPhaseFn: vi.fn(async () => {
        throw new Error('processing failed');
      }),
    });

    expect(transitionTicketStatusFn).toHaveBeenNthCalledWith(
      2,
      '018f8a30-52f7-7d9f-bb7d-6924b8d8a002',
      ['processing'],
      'queued',
    );
    expect(failPhaseAttemptFn).toHaveBeenCalledWith(
      '018f8a30-52f7-7d9f-bb7d-6924b8d8a002',
      'triage',
    );
    expect(enqueueTicketFn).toHaveBeenCalledWith('018f8a30-52f7-7d9f-bb7d-6924b8d8a002');
  });

  it('does not re-run a successful phase when re-processing a queued ticket', async () => {
    const processPhaseFn = vi.fn(async () => ({ reply: 'drafted' }));
    const transitionTicketStatusFn = vi
      .fn()
      .mockResolvedValueOnce(makeTicket({ status: 'processing' }))
      .mockResolvedValueOnce(makeTicket({ status: 'completed' }));

    const getTicketPhasesByTicketIdFn = vi
      .fn()
      .mockResolvedValueOnce([
        makePhase({ phase: 'triage', status: 'success', output: { category: 'billing' } }),
        makePhase({
          id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202',
          phase: 'draft',
          status: 'started',
        }),
      ])
      .mockResolvedValueOnce([
        makePhase({ phase: 'triage', status: 'success', output: { category: 'billing' } }),
        makePhase({
          id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202',
          phase: 'draft',
          status: 'success',
          output: { reply: 'drafted' },
        }),
      ]);

    await processTicketLifecycle('018f8a30-52f7-7d9f-bb7d-6924b8d8a002', {
      getTicketByIdFn: vi.fn(async () => makeTicket({ status: 'queued' })),
      getTicketPhasesByTicketIdFn,
      transitionTicketStatusFn,
      claimPhaseForProcessingFn: vi.fn(async () =>
        makePhase({ phase: 'draft', status: 'progress' }),
      ),
      completePhaseSuccessFn: vi.fn(async () => makePhase({ phase: 'draft', status: 'success' })),
      processPhaseFn,
    });

    expect(processPhaseFn).toHaveBeenCalledTimes(1);
    expect(processPhaseFn).toHaveBeenCalledWith('018f8a30-52f7-7d9f-bb7d-6924b8d8a002', 'draft');
    expect(transitionTicketStatusFn).toHaveBeenNthCalledWith(
      2,
      '018f8a30-52f7-7d9f-bb7d-6924b8d8a002',
      ['processing'],
      'completed',
    );
  });

  it('skips all processing for terminal ticket states', async () => {
    const processPhaseFn = vi.fn(async () => Promise.resolve({}));
    const transitionTicketStatusFn = vi.fn(async () => makeTicket({ status: 'processing' }));

    await processTicketLifecycle('018f8a30-52f7-7d9f-bb7d-6924b8d8a002', {
      getTicketByIdFn: vi.fn(async () => makeTicket({ status: 'completed' })),
      transitionTicketStatusFn,
      processPhaseFn,
    });

    expect(processPhaseFn).not.toHaveBeenCalled();
    expect(transitionTicketStatusFn).not.toHaveBeenCalled();
  });

  // US-1.1: ticket not found → no status mutation, no processing
  it('skips processing when ticket is not found in the database', async () => {
    const transitionTicketStatusFn = vi.fn();
    const processPhaseFn = vi.fn();

    await processTicketLifecycle('018f8a30-52f7-7d9f-bb7d-6924b8d8a002', {
      getTicketByIdFn: vi.fn(async () => null),
      transitionTicketStatusFn,
      processPhaseFn,
    });

    expect(transitionTicketStatusFn).not.toHaveBeenCalled();
    expect(processPhaseFn).not.toHaveBeenCalled();
  });

  // US-1.1: failed ticket remains in DB with failed status (not deleted)
  // US-1.2: attempt counter drives retry vs permanent failure threshold
  it('transitions ticket to failed after phase reaches 3 attempts', async () => {
    const transitionTicketStatusFn = vi.fn()
      .mockResolvedValueOnce(makeTicket({ status: 'processing' }))
      .mockResolvedValueOnce(makeTicket({ status: 'failed' }));

    await processTicketLifecycle('018f8a30-52f7-7d9f-bb7d-6924b8d8a002', {
      getTicketByIdFn: vi.fn(async () => makeTicket({ status: 'queued' })),
      getTicketPhasesByTicketIdFn: vi.fn(async () => [
        makePhase({ phase: 'triage', status: 'started' }),
        makePhase({ id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202', phase: 'draft', status: 'started' }),
      ]),
      transitionTicketStatusFn,
      claimPhaseForProcessingFn: vi.fn(async () =>
        makePhase({ phase: 'triage', status: 'progress', started_at: new Date() }),
      ),
      failPhaseAttemptFn: vi.fn(async () =>
        makePhase({ phase: 'triage', status: 'failure', attempts: 3 }),
      ),
      processPhaseFn: vi.fn(async () => {
        throw new Error('phase error');
      }),
    });

    expect(transitionTicketStatusFn).toHaveBeenCalledWith(
      '018f8a30-52f7-7d9f-bb7d-6924b8d8a002',
      ['queued', 'processing'],
      'failed',
    );
  });

  // US-1.2: phase output stored and linked to ticketId on success
  it('stores each phase output linked to the ticket id', async () => {
    const triageOutput = { category: 'billing' };
    const draftOutput = { reply: 'resolved' };
    const completePhaseSuccessFn = vi.fn(async () =>
      makePhase({ status: 'success', completed_at: new Date() }),
    );

    await processTicketLifecycle('018f8a30-52f7-7d9f-bb7d-6924b8d8a002', {
      getTicketByIdFn: vi.fn(async () => makeTicket({ status: 'queued' })),
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
          makePhase({
            id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202',
            phase: 'draft',
            status: 'success',
            output: draftOutput,
          }),
        ]),
      transitionTicketStatusFn: vi.fn()
        .mockResolvedValueOnce(makeTicket({ status: 'processing' }))
        .mockResolvedValueOnce(makeTicket({ status: 'completed' })),
      claimPhaseForProcessingFn: vi.fn()
        .mockResolvedValueOnce(makePhase({ phase: 'triage', status: 'progress', started_at: new Date() }))
        .mockResolvedValueOnce(makePhase({ phase: 'draft', status: 'progress', started_at: new Date() })),
      completePhaseSuccessFn,
      processPhaseFn: vi.fn()
        .mockResolvedValueOnce(triageOutput)
        .mockResolvedValueOnce(draftOutput),
    });

    expect(completePhaseSuccessFn).toHaveBeenNthCalledWith(
      1,
      '018f8a30-52f7-7d9f-bb7d-6924b8d8a002',
      'triage',
      triageOutput,
    );
    expect(completePhaseSuccessFn).toHaveBeenNthCalledWith(
      2,
      '018f8a30-52f7-7d9f-bb7d-6924b8d8a002',
      'draft',
      draftOutput,
    );
  });

  // US-1.2: completed phase skip enforced at claim level — only pending phase claimed
  it('claims only the pending phase when triage already succeeded', async () => {
    const claimPhaseForProcessingFn = vi.fn(async () =>
      makePhase({ phase: 'draft', status: 'progress', started_at: new Date() }),
    );

    await processTicketLifecycle('018f8a30-52f7-7d9f-bb7d-6924b8d8a002', {
      getTicketByIdFn: vi.fn(async () => makeTicket({ status: 'queued' })),
      getTicketPhasesByTicketIdFn: vi.fn()
        .mockResolvedValueOnce([
          makePhase({ phase: 'triage', status: 'success', output: { category: 'billing' } }),
          makePhase({ id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202', phase: 'draft', status: 'started' }),
        ])
        .mockResolvedValueOnce([
          makePhase({ phase: 'triage', status: 'success', output: { category: 'billing' } }),
          makePhase({
            id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202',
            phase: 'draft',
            status: 'success',
            output: { reply: 'done' },
          }),
        ]),
      transitionTicketStatusFn: vi.fn()
        .mockResolvedValueOnce(makeTicket({ status: 'processing' }))
        .mockResolvedValueOnce(makeTicket({ status: 'completed' })),
      claimPhaseForProcessingFn,
      completePhaseSuccessFn: vi.fn(async () =>
        makePhase({ phase: 'draft', status: 'success', completed_at: new Date() }),
      ),
      processPhaseFn: vi.fn(async () => ({ reply: 'done' })),
    });

    expect(claimPhaseForProcessingFn).toHaveBeenCalledTimes(1);
    expect(claimPhaseForProcessingFn).toHaveBeenCalledWith(
      '018f8a30-52f7-7d9f-bb7d-6924b8d8a002',
      'draft',
    );
  });
});

describe('startTicketWorker SQS integration', () => {
  beforeEach(async () => {
    await purgeQueue();
  });

  it('picks up SQS message and processes ticket lifecycle', async () => {
    const ticketId = '018f8a30-52f7-7d9f-bb7d-6924b8d8a999';

    await enqueueTicket(ticketId);

    const getTicketByIdFn = vi.fn(async () => makeTicket({ id: ticketId, status: 'queued' }));
    const transitionTicketStatusFn = vi.fn()
      .mockResolvedValueOnce(makeTicket({ id: ticketId, status: 'processing' }))
      .mockResolvedValueOnce(makeTicket({ id: ticketId, status: 'completed' }));
    const getTicketPhasesByTicketIdFn = vi.fn().mockResolvedValue([
      makePhase({ phase: 'triage', status: 'success', output: {} }),
      makePhase({ id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a202', phase: 'draft', status: 'success', output: {} }),
    ]);

    const worker = startTicketWorker({
      getTicketByIdFn,
      transitionTicketStatusFn,
      getTicketPhasesByTicketIdFn,
    });

    await vi.waitFor(
      () => { expect(getTicketByIdFn).toHaveBeenCalledWith(ticketId); },
      { timeout: 10000 },
    );

    worker.stop();
    await worker.done;

    expect(transitionTicketStatusFn).toHaveBeenCalledWith(ticketId, ['queued'], 'processing');
    expect(transitionTicketStatusFn).toHaveBeenCalledWith(ticketId, ['processing'], 'completed');
  });
});
