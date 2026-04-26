import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startNotifyService } from './notifyService.ts';
import type { TicketEvent } from '../schemas/eventSchema.ts';

const TICKET_ID = '018f8a30-52f7-7d9f-bb7d-6924b8d8a001';

const mockEvent: TicketEvent = {
  id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a002',
  ticket_id: TICKET_ID,
  phase: 'triage',
  event_type: 'phase_started',
  payload: null,
  created_at: new Date(),
};

type NotifHandler = (msg: { payload: string }) => void;

type PgClientStub = {
  connect: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  triggerNotification: (ticketId: string) => void;
};

function makePgClient(): PgClientStub {
  let notifHandler: NotifHandler | null = null;
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue(undefined),
    on: vi.fn().mockImplementation((event: string, handler: NotifHandler) => {
      if (event === 'notification') notifHandler = handler;
    }),
    triggerNotification(ticketId: string) {
      notifHandler?.({ payload: ticketId });
    },
  };
}

function makeIo() {
  const ioStub = { to: vi.fn(), emit: vi.fn() };
  ioStub.to.mockReturnValue(ioStub);
  return ioStub;
}

async function flushAsync(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('notifyService', () => {
  let io: ReturnType<typeof makeIo>;
  let pgClient: PgClientStub;
  let getLatestEventByTicketId: (ticketId: string) => Promise<TicketEvent | null>;

  beforeEach(() => {
    io = makeIo();
    pgClient = makePgClient();
    getLatestEventByTicketId = vi.fn();
  });

  function start(): void {
    startNotifyService(io as never, {
      getLatestEventByTicketId,
      createClient: () => pgClient as never,
    });
  }

  it('connects and listens on ticket_events channel', async () => {
    start();
    await flushAsync();
    expect(pgClient.connect).toHaveBeenCalled();
    expect(pgClient.query).toHaveBeenCalledWith('LISTEN ticket_events');
  });

  it('registers notification handler', async () => {
    start();
    await flushAsync();
    expect(pgClient.on).toHaveBeenCalledWith('notification', expect.any(Function));
  });

  it('emits latest event to correct room on notification', async () => {
    vi.mocked(getLatestEventByTicketId).mockResolvedValueOnce(mockEvent);
    start();
    await flushAsync();

    pgClient.triggerNotification(TICKET_ID);
    await flushAsync();

    expect(io.to).toHaveBeenCalledWith(`ticket:${TICKET_ID}`);
    expect(io.emit).toHaveBeenCalledWith('ticket:event', mockEvent);
  });

  it('does not emit when no event found', async () => {
    vi.mocked(getLatestEventByTicketId).mockResolvedValueOnce(null);
    start();
    await flushAsync();

    pgClient.triggerNotification(TICKET_ID);
    await flushAsync();

    expect(io.emit).not.toHaveBeenCalled();
  });

  it('silences emit error — does not throw', async () => {
    vi.mocked(getLatestEventByTicketId).mockRejectedValueOnce(new Error('DB error'));
    start();
    await flushAsync();

    expect(() => pgClient.triggerNotification(TICKET_ID)).not.toThrow();
    await flushAsync();

    expect(io.emit).not.toHaveBeenCalled();
  });

  it('ignores notification with empty payload', async () => {
    start();
    await flushAsync();

    pgClient.triggerNotification('');
    await flushAsync();

    expect(getLatestEventByTicketId).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('isolates rooms — different ticket IDs go to different rooms', async () => {
    const OTHER = '018f8a30-52f7-7d9f-bb7d-6924b8d8a009';
    const otherEvent: TicketEvent = { ...mockEvent, ticket_id: OTHER };
    vi.mocked(getLatestEventByTicketId)
      .mockResolvedValueOnce(mockEvent)
      .mockResolvedValueOnce(otherEvent);
    start();
    await flushAsync();

    pgClient.triggerNotification(TICKET_ID);
    pgClient.triggerNotification(OTHER);
    await flushAsync();
    await flushAsync();

    expect(io.to).toHaveBeenCalledWith(`ticket:${TICKET_ID}`);
    expect(io.to).toHaveBeenCalledWith(`ticket:${OTHER}`);
  });
});
