import pg from 'pg';
import type { Server } from 'socket.io';
import type { TicketEvent } from '../schemas/eventSchema.ts';
import logger from '../lib/logger.ts';

const RECONNECT_DELAY_MS = 5_000;

export type NotifyDeps = {
  getLatestEventByTicketId: (ticketId: string) => Promise<TicketEvent | null>;
  createClient: () => pg.Client;
};

export type NotifyHandle = {
  stop: () => Promise<void>;
};

export function startNotifyService(io: Server, deps: NotifyDeps): NotifyHandle {
  let client = deps.createClient();
  let stopped = false;

  async function onNotification(ticketId: string): Promise<void> {
    try {
      const event = await deps.getLatestEventByTicketId(ticketId);
      if (!event) return;
      io.to(`ticket:${ticketId}`).emit('ticket:event', event);
    } catch (err) {
      logger.error({ err, ticketId }, 'notify emit failed');
    }
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    try {
      await client.connect();
      await client.query('LISTEN ticket_events');
      logger.info('notify service listening on ticket_events');
      client.on('notification', msg => {
        if (msg.payload) void onNotification(msg.payload);
      });
      client.on('error', err => {
        logger.error({ err }, 'notify service connection error — reconnecting');
        void reconnect();
      });
    } catch (err) {
      logger.error({ err }, 'notify service connect failed — retrying');
      setTimeout(() => void connect(), RECONNECT_DELAY_MS);
    }
  }

  async function reconnect(): Promise<void> {
    if (stopped) return;
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
    client = deps.createClient();
    setTimeout(() => void connect(), RECONNECT_DELAY_MS);
  }

  void connect();

  return {
    stop: async () => {
      stopped = true;
      await client.end();
    },
  };
}
