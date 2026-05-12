import type { TicketRepo } from '../repositories/ticketRepo.ts';
import logger from '../lib/logger.ts';

export type DlqMessage = { body: string; receiptHandle: string };

const DEFAULT_MAX_REPLAY_COUNT = 3;
const DEFAULT_REPLAY_DELAY_SECONDS = 30;

export type DlqConsumerDeps = {
  receiveMessagesFn: () => Promise<DlqMessage[]>;
  deleteMessageFn: (receiptHandle: string) => Promise<void>;
  insertEventFn: TicketRepo['insertEvent'];
  failTicketFn: TicketRepo['failTicket'];
  enqueueTicketFn: (ticketId: string, delaySeconds?: number) => Promise<void>;
  getEventsByTicketIdFn: TicketRepo['getEventsByTicketId'];
  autoReplay?: boolean;
  maxReplayCount?: number;
  replayDelaySeconds?: number;
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

function isFatalDlqEvent(payload: unknown): boolean {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    (payload as Record<string, unknown>).reason === 'fatal_error'
  );
}

export async function processDlqMessage(
  message: DlqMessage,
  deps: DlqConsumerDeps,
): Promise<void> {
  const parsed = parseMessageBody(message.body);
  const ticketId = typeof parsed.ticketId === 'string' ? parsed.ticketId : undefined;

  if (ticketId) {
    let shouldReplay = deps.autoReplay ?? false;

    if (shouldReplay) {
      const maxReplayCount = deps.maxReplayCount ?? DEFAULT_MAX_REPLAY_COUNT;
      const events = await deps.getEventsByTicketIdFn(ticketId);
      const dlqEvents = events.filter(e => e.event_type === 'dlq_routed');

      if (dlqEvents.length >= maxReplayCount) {
        logger.warn(
          { ticketId, count: dlqEvents.length, maxReplayCount },
          'DLQ: max replay count reached — skipping',
        );
        shouldReplay = false;
      } else if (dlqEvents.some(e => isFatalDlqEvent(e.payload))) {
        logger.warn({ ticketId }, 'DLQ: fatal error in history — skipping replay');
        shouldReplay = false;
      }
    }

    await deps.insertEventFn(ticketId, 'dlq_routed', null, { body: parsed });
    await deps.failTicketFn(ticketId);
    logger.error({ ticketId }, 'DLQ: ticket failed after exhausting retries');

    if (shouldReplay) {
      const replayDelaySeconds = deps.replayDelaySeconds ?? DEFAULT_REPLAY_DELAY_SECONDS;
      try {
        await deps.enqueueTicketFn(ticketId, replayDelaySeconds);
        logger.info({ ticketId, delaySeconds: replayDelaySeconds }, 'DLQ: requeued ticket');
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
