import { createServer } from 'http';
import { io as ioClient } from 'socket.io-client';
import { describe, it, expect, vi } from 'vitest';
import { createIo } from './io.ts';
import type { Server } from 'socket.io';
import type { Socket } from 'socket.io-client';
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

type TestCtx = {
  port: number;
  ioServer: Server;
  teardown: () => Promise<void>;
};

async function setup(getEventsByTicketId: (id: string) => Promise<TicketEvent[]>): Promise<TestCtx> {
  const httpServer = createServer();
  const ioServer = createIo(httpServer, { getEventsByTicketId });
  await new Promise<void>(resolve => httpServer.listen(0, resolve));
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {
    port,
    ioServer,
    teardown: () => new Promise<void>(resolve => ioServer.close(() => httpServer.close(() => resolve()))),
  };
}

type ClientHandle = {
  client: Socket;
  events: () => TicketEvent[];
  waitConnected: Promise<void>;
};

function connect(port: number, ticketId: string): ClientHandle {
  const client = ioClient(`http://localhost:${port}`, { transports: ['websocket'] });
  const received: TicketEvent[] = [];
  client.on('ticket:event', (e: TicketEvent) => received.push(e));
  const waitConnected = new Promise<void>((resolve, reject) => {
    client.on('connect', () => { client.emit('subscribe', ticketId); resolve(); });
    client.on('connect_error', reject);
  });
  return { client, events: () => received, waitConnected };
}

describe('io subscribe handler', () => {
  it('joins room ticket:<id> — receives future events emitted to that room', async () => {
    const getEventsByTicketId = vi.fn().mockResolvedValue([]);
    const ctx = await setup(getEventsByTicketId);
    const { client, events, waitConnected } = connect(ctx.port, TICKET_ID);
    try {
      await waitConnected;
      await vi.waitFor(() => expect(getEventsByTicketId).toHaveBeenCalledWith(TICKET_ID));
      ctx.ioServer.to(`ticket:${TICKET_ID}`).emit('ticket:event', mockEvent);
      await vi.waitFor(() => expect(events()).toHaveLength(1));
    } finally {
      client.disconnect();
      await ctx.teardown();
    }
  });

  it('replays existing events to subscriber in order', async () => {
    const second: TicketEvent = { ...mockEvent, id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a003', event_type: 'phase_completed' };
    const ctx = await setup(vi.fn().mockResolvedValue([mockEvent, second]));
    const { client, events, waitConnected } = connect(ctx.port, TICKET_ID);
    try {
      await waitConnected;
      await vi.waitFor(() => expect(events()).toHaveLength(2));
      expect(events()[0]).toMatchObject({ event_type: 'phase_started' });
      expect(events()[1]).toMatchObject({ event_type: 'phase_completed' });
    } finally {
      client.disconnect();
      await ctx.teardown();
    }
  });

  it('joins room with no replay when no events exist', async () => {
    const getEventsByTicketId = vi.fn().mockResolvedValue([]);
    const ctx = await setup(getEventsByTicketId);
    const { client, events, waitConnected } = connect(ctx.port, TICKET_ID);
    try {
      await waitConnected;
      await vi.waitFor(() => expect(getEventsByTicketId).toHaveBeenCalledWith(TICKET_ID));
      expect(events()).toHaveLength(0);
    } finally {
      client.disconnect();
      await ctx.teardown();
    }
  });

  it('uses ticket:event as the socket event name', async () => {
    const ctx = await setup(vi.fn().mockResolvedValue([mockEvent]));
    const received: Array<[string, unknown]> = [];
    const httpServer = createServer();
    const client = ioClient(`http://localhost:${ctx.port}`, { transports: ['websocket'] });
    client.onAny((event, payload) => received.push([event, payload]));
    try {
      await new Promise<void>((resolve, reject) => {
        client.on('connect', () => { client.emit('subscribe', TICKET_ID); resolve(); });
        client.on('connect_error', reject);
      });
      await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));
      expect(received[0]?.[0]).toBe('ticket:event');
    } finally {
      client.disconnect();
      httpServer.close();
      await ctx.teardown();
    }
  });

  it('isolation — different ticket IDs receive only their events', async () => {
    const OTHER = '018f8a30-52f7-7d9f-bb7d-6924b8d8a009';
    const otherEvent: TicketEvent = { ...mockEvent, id: '018f8a30-52f7-7d9f-bb7d-6924b8d8a009', ticket_id: OTHER };
    const getEventsByTicketId = vi.fn().mockResolvedValue([]);
    const ctx = await setup(getEventsByTicketId);

    const a = connect(ctx.port, TICKET_ID);
    const b = connect(ctx.port, OTHER);
    try {
      await Promise.all([a.waitConnected, b.waitConnected]);
      await vi.waitFor(() => expect(getEventsByTicketId).toHaveBeenCalledTimes(2));

      ctx.ioServer.to(`ticket:${TICKET_ID}`).emit('ticket:event', mockEvent);
      await vi.waitFor(() => expect(a.events()).toHaveLength(1));
      expect(b.events()).toHaveLength(0);

      ctx.ioServer.to(`ticket:${OTHER}`).emit('ticket:event', otherEvent);
      await vi.waitFor(() => expect(b.events()).toHaveLength(1));
      expect(a.events()).toHaveLength(1);
    } finally {
      a.client.disconnect();
      b.client.disconnect();
      await ctx.teardown();
    }
  });
});
