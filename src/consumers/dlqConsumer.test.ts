import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processDlqMessage, type DlqConsumerDeps, type DlqMessage } from './dlqConsumer.ts';

const TID = '018f8a30-52f7-7d9f-bb7d-6924b8d8a001';

function makeDeps(overrides: Partial<DlqConsumerDeps> = {}): DlqConsumerDeps {
  return {
    receiveMessagesFn: vi.fn().mockResolvedValue([]),
    deleteMessageFn: vi.fn().mockResolvedValue(undefined),
    insertEventFn: vi.fn().mockResolvedValue(undefined),
    failTicketFn: vi.fn().mockResolvedValue(null),
    enqueueTicketFn: vi.fn().mockResolvedValue(undefined),
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

  it('enqueues ticket when autoReplay is true', async () => {
    const deps = makeDeps({ autoReplay: true });
    await processDlqMessage(makeMessage(TID), deps);

    expect(deps.enqueueTicketFn).toHaveBeenCalledWith(TID);
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
});
