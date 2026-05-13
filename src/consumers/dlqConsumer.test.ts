import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processDlqMessage, type DlqConsumerDeps, type DlqMessage } from './dlqConsumer.ts';
import type { TicketEvent } from '../schemas/eventSchema.ts';

const TID = '018f8a30-52f7-7d9f-bb7d-6924b8d8a001';

function makeDlqEvent(payload: unknown = null): TicketEvent {
  return {
    id: TID,
    ticket_id: TID,
    phase: null,
    event_type: 'dlq_routed',
    payload,
    created_at: new Date(),
  };
}

function makeDeps(overrides: Partial<DlqConsumerDeps> = {}): DlqConsumerDeps {
  return {
    receiveMessagesFn: vi.fn().mockResolvedValue([]),
    deleteMessageFn: vi.fn().mockResolvedValue(undefined),
    insertEventFn: vi.fn().mockResolvedValue(undefined),
    failTicketFn: vi.fn().mockResolvedValue(null),
    enqueueTicketFn: vi.fn().mockResolvedValue(undefined),
    getEventsByTicketIdFn: vi.fn().mockResolvedValue([]),
    autoReplay: false,
    ...overrides,
  };
}

function makeMessage(ticketId: string, receiptHandle = 'receipt-1'): DlqMessage {
  return { body: JSON.stringify({ ticketId }), receiptHandle };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('processDlqMessage', () => {
  it('inserts dlq_routed event, fails ticket, and deletes message', async () => {
    const deps = makeDeps();
    await processDlqMessage(makeMessage(TID), deps);

    expect(deps.insertEventFn).toHaveBeenCalledWith(TID, 'dlq_routed', null, expect.anything());
    expect(deps.failTicketFn).toHaveBeenCalledWith(TID);
    expect(deps.deleteMessageFn).toHaveBeenCalledWith('receipt-1');
  });

  it('does not fail ticket or insert event when ticketId is missing', async () => {
    const deps = makeDeps();
    await processDlqMessage({ body: JSON.stringify({ foo: 'bar' }), receiptHandle: 'r1' }, deps);

    expect(deps.insertEventFn).not.toHaveBeenCalled();
    expect(deps.failTicketFn).not.toHaveBeenCalled();
    expect(deps.deleteMessageFn).toHaveBeenCalledWith('r1');
  });

  it('deletes message when body is invalid JSON', async () => {
    const deps = makeDeps();
    await processDlqMessage({ body: 'not-json', receiptHandle: 'r2' }, deps);

    expect(deps.deleteMessageFn).toHaveBeenCalledWith('r2');
    expect(deps.insertEventFn).not.toHaveBeenCalled();
  });

  it('does not enqueue when autoReplay is false', async () => {
    const deps = makeDeps({ autoReplay: false });
    await processDlqMessage(makeMessage(TID), deps);

    expect(deps.enqueueTicketFn).not.toHaveBeenCalled();
  });

  it('deletes message even when enqueue fails during autoReplay', async () => {
    const deps = makeDeps({
      autoReplay: true,
      enqueueTicketFn: vi.fn().mockRejectedValue(new Error('SQS down')),
    });
    await processDlqMessage(makeMessage(TID), deps);

    expect(deps.deleteMessageFn).toHaveBeenCalledWith('receipt-1');
  });

  describe('autoReplay guardrails', () => {
    it('enqueues with delay when autoReplay is true and no prior dlq events', async () => {
      const deps = makeDeps({ autoReplay: true });
      await processDlqMessage(makeMessage(TID), deps);

      expect(deps.enqueueTicketFn).toHaveBeenCalledWith(TID, 30);
    });

    it('skips replay when dlq_routed event count meets maxReplayCount', async () => {
      const deps = makeDeps({
        autoReplay: true,
        maxReplayCount: 2,
        getEventsByTicketIdFn: vi.fn().mockResolvedValue([makeDlqEvent(), makeDlqEvent()]),
      });
      await processDlqMessage(makeMessage(TID), deps);

      expect(deps.enqueueTicketFn).not.toHaveBeenCalled();
    });

    it('skips replay when any dlq event has reason=fatal_error', async () => {
      const deps = makeDeps({
        autoReplay: true,
        getEventsByTicketIdFn: vi
          .fn()
          .mockResolvedValue([makeDlqEvent({ reason: 'fatal_error', attempt: 1 })]),
      });
      await processDlqMessage(makeMessage(TID), deps);

      expect(deps.enqueueTicketFn).not.toHaveBeenCalled();
    });

    it('replays with custom delay when replayDelaySeconds is set', async () => {
      const deps = makeDeps({ autoReplay: true, replayDelaySeconds: 60 });
      await processDlqMessage(makeMessage(TID), deps);

      expect(deps.enqueueTicketFn).toHaveBeenCalledWith(TID, 60);
    });

    it('still inserts dlq_routed and fails ticket even when replay is skipped', async () => {
      const deps = makeDeps({
        autoReplay: true,
        maxReplayCount: 1,
        getEventsByTicketIdFn: vi.fn().mockResolvedValue([makeDlqEvent()]),
      });
      await processDlqMessage(makeMessage(TID), deps);

      expect(deps.insertEventFn).toHaveBeenCalled();
      expect(deps.failTicketFn).toHaveBeenCalled();
      expect(deps.enqueueTicketFn).not.toHaveBeenCalled();
    });
  });
});
