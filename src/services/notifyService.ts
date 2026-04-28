import pg from 'pg';
import type { Server } from 'socket.io';
import { config } from '../lib/config.ts';
import { pool } from '../lib/db.ts';
import { ticketEventSchema } from '../schemas/eventSchema.ts';
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

async function defaultGetLatestEvent(ticketId: string): Promise<TicketEvent | null> {
  const result = await pool.query(
    'SELECT * FROM ticket_events WHERE ticket_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
    [ticketId],
  );
  if (!result.rows[0]) return null;
  const parsed = ticketEventSchema.safeParse(result.rows[0]);
  if (!parsed.success) {
    logger.error({ ticketId, issues: parsed.error.issues }, 'notify: event row failed validation');
    return null;
  }
  return parsed.data;
}

export function startNotifyService(io: Server, deps?: Partial<NotifyDeps>): NotifyHandle {
  const getLatestEvent = deps?.getLatestEventByTicketId ?? defaultGetLatestEvent;
  const createClient =
    deps?.createClient ?? (() => new pg.Client({ connectionString: config.databaseUrl }));

  let client = createClient();
  let stopped = false;

  async function onNotification(ticketId: string): Promise<void> {
    try {
      const event = await getLatestEvent(ticketId);
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
    client = createClient();
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
