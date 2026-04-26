import pg from 'pg';
import type { Server } from 'socket.io';
import { config } from '../lib/config.ts';
import { pool } from '../lib/db.ts';
import { ticketEventSchema } from '../schemas/eventSchema.ts';
import type { TicketEvent } from '../schemas/eventSchema.ts';
import logger from '../lib/logger.ts';

export type NotifyDeps = {
  getLatestEventByTicketId: (ticketId: string) => Promise<TicketEvent | null>;
  createClient: () => pg.Client;
};

async function defaultGetLatestEvent(ticketId: string): Promise<TicketEvent | null> {
  const result = await pool.query(
    'SELECT * FROM ticket_events WHERE ticket_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
    [ticketId],
  );
  if (!result.rows[0]) return null;
  return ticketEventSchema.parse(result.rows[0]);
}

export function startNotifyService(io: Server, deps?: Partial<NotifyDeps>): void {
  const getLatestEvent = deps?.getLatestEventByTicketId ?? defaultGetLatestEvent;
  const createClient = deps?.createClient ?? (() => new pg.Client({ connectionString: config.databaseUrl }));

  const client = createClient();

  void (async () => {
    try {
      await client.connect();
      await client.query('LISTEN ticket_events');
      logger.info('notify service listening on ticket_events');

      client.on('notification', (msg) => {
        const ticketId = msg.payload;
        if (!ticketId) return;

        void (async () => {
          try {
            const event = await getLatestEvent(ticketId);
            if (!event) return;
            io.to(`ticket:${ticketId}`).emit('ticket:event', event);
          } catch (err) {
            logger.error({ err, ticketId }, 'notify emit failed');
          }
        })();
      });
    } catch (err) {
      logger.error({ err }, 'notify service connect failed');
    }
  })();
}
