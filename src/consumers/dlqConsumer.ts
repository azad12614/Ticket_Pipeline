import type { TicketRepo } from '../repositories/ticketRepo.ts';
import logger from '../lib/logger.ts';

export type DlqMessage = { body: string; receiptHandle: string };

export type DlqConsumerDeps = {
  receiveMessagesFn: () => Promise<DlqMessage[]>;
  deleteMessageFn: (receiptHandle: string) => Promise<void>;
  insertEventFn: TicketRepo['insertEvent'];
  failTicketFn: TicketRepo['failTicket'];
  enqueueTicketFn: (ticketId: string) => Promise<void>;
  autoReplay?: boolean;
};

export type DlqConsumerHandle = {
  stop: () => void;
  done: Promise<void>;
};

function parseMessageBody(body: string): { ticketId?: string; raw?: unknown } {
  try {
    const parsed = JSON.parse(body);
    return { ...(typeof parsed === 'object' ? parsed : { raw: parsed }) };
  } catch {
    return { raw: body };
  }
}

export async function processDlqMessage(
  message: DlqMessage,
  deps: DlqConsumerDeps,
): Promise<void> {
  const parsed = parseMessageBody(message.body);
  const ticketId = typeof parsed.ticketId === 'string' ? parsed.ticketId : undefined;

  if (ticketId) {
    await deps.insertEventFn(ticketId, 'dlq_routed', null, { body: parsed });
    await deps.failTicketFn(ticketId);
    logger.error({ ticketId }, 'DLQ: ticket failed after exhausting retries');

    if (deps.autoReplay) {
      try {
        await deps.enqueueTicketFn(ticketId);
        logger.info({ ticketId }, 'DLQ: requeued ticket');
      } catch (err) {
        logger.error({ err, ticketId }, 'DLQ: failed to requeue');
      }
    }
  } else {
    logger.warn({ body: parsed }, 'DLQ: message without ticketId');
  }

  await deps.deleteMessageFn(message.receiptHandle);
}

export function startDlqConsumer(deps: DlqConsumerDeps, pollIntervalMs = 20000): DlqConsumerHandle {
  const controller = new AbortController();

  const done = (async () => {
    while (!controller.signal.aborted) {
      try {
        const messages = await deps.receiveMessagesFn();
        for (const message of messages) {
          try {
            await processDlqMessage(message, deps);
          } catch (err) {
            logger.error({ err }, 'DLQ: message processing failed');
          }
        }
      } catch (err) {
        if (controller.signal.aborted) break;
        logger.error({ err }, 'DLQ: receive loop error — retrying after delay');
        await new Promise(r => setTimeout(r, pollIntervalMs));
      }
    }
  })();

  return {
    stop: () => controller.abort(),
    done,
  };
}
