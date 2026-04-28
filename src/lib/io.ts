import { Server } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { config } from './config.ts';
import { postgresTicketRepo } from '../repositories/ticketRepo.ts';
import type { TicketEvent } from '../schemas/eventSchema.ts';
import logger from './logger.ts';

export type IoDeps = {
  getEventsByTicketId: (ticketId: string) => Promise<TicketEvent[]>;
};

export function createIo(httpServer: HttpServer, deps: IoDeps = { getEventsByTicketId: postgresTicketRepo.getEventsByTicketId.bind(postgresTicketRepo) }): Server {
  const io = new Server(httpServer, { cors: { origin: config.corsOrigin } });

  io.on('connection', (socket) => {
    socket.on('subscribe', async (ticketId: string) => {
      await socket.join(`ticket:${ticketId}`);
      try {
        const events = await deps.getEventsByTicketId(ticketId);
        for (const event of events) {
          socket.emit('ticket:event', event);
        }
      } catch (err) {
        logger.error({ err, ticketId }, 'subscribe replay failed');
      }
    });
  });

  return io;
}
