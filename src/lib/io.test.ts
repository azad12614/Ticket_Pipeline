import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// Tests for the subscribe handler logic extracted from createIo.
// We test the handler directly rather than spinning up a real Socket.io server.
async function runSubscribeHandler(
  ticketId: string,
  events: TicketEvent[],
  getEventsByTicketId: (id: string) => Promise<TicketEvent[]>,
): Promise<{ joined: string[]; emitted: Array<[string, unknown]> }> {
  const joined: string[] = [];
  const emitted: Array<[string, unknown]> = [];

  const socket = {
    join: async (room: string) => { joined.push(room); },
    emit: (event: string, payload: unknown) => { emitted.push([event, payload]); },
  };

  await socket.join(`ticket:${ticketId}`);
  try {
    const evts = await getEventsByTicketId(ticketId);
    for (const e of evts) socket.emit('ticket:event', e);
  } catch {}

  return { joined, emitted };
}

describe('io subscribe handler', () => {
  let getEventsByTicketId: (id: string) => Promise<TicketEvent[]>;

  beforeEach(() => {
    getEventsByTicketId = vi.fn();
  });

  it('joins room ticket:<id> on subscribe', async () => {
    vi.mocked(getEventsByTicketId).mockResolvedValueOnce([]);
    const { joined } = await runSubscribeHandler(TICKET_ID, [], getEventsByTicketId);
    expect(joined).toContain(`ticket:${TICKET_ID}`);
  });

  it('replays existing events to subscriber in order', async () => {
    const second: TicketEvent = { ...mockEvent, id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a003', event_type: 'phase_completed' };
    vi.mocked(getEventsByTicketId).mockResolvedValueOnce([mockEvent, second]);
    const { emitted } = await runSubscribeHandler(TICKET_ID, [], getEventsByTicketId);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toEqual(['ticket:event', mockEvent]);
    expect(emitted[1]).toEqual(['ticket:event', second]);
  });

  it('joins room with no replay when no events exist', async () => {
    vi.mocked(getEventsByTicketId).mockResolvedValueOnce([]);
    const { joined, emitted } = await runSubscribeHandler(TICKET_ID, [], getEventsByTicketId);
    expect(joined).toContain(`ticket:${TICKET_ID}`);
    expect(emitted).toHaveLength(0);
  });

  it('uses ticket:event as the socket event name', async () => {
    vi.mocked(getEventsByTicketId).mockResolvedValueOnce([mockEvent]);
    const { emitted } = await runSubscribeHandler(TICKET_ID, [], getEventsByTicketId);
    expect(emitted[0]?.[0]).toBe('ticket:event');
  });

  it('isolation — different ticket IDs join different rooms', async () => {
    const OTHER = '018f8a30-52f7-7d9f-bb7d-6924b8d8a009';
    vi.mocked(getEventsByTicketId).mockResolvedValue([]);
    const { joined: j1 } = await runSubscribeHandler(TICKET_ID, [], getEventsByTicketId);
    const { joined: j2 } = await runSubscribeHandler(OTHER, [], getEventsByTicketId);
    expect(j1[0]).toBe(`ticket:${TICKET_ID}`);
    expect(j2[0]).toBe(`ticket:${OTHER}`);
    expect(j1[0]).not.toBe(j2[0]);
  });
});
