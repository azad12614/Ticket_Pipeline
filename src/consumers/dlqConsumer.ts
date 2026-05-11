import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { sqsClient } from '../queues/ticketQueue.ts';
import type { TicketRepo } from '../repositories/ticketRepo.ts';
import { config } from '../lib/config.ts';
import logger from '../lib/logger.ts';

export type DlqConsumerDeps = {
  insertEventFn: TicketRepo['insertEvent'];
  failTicketFn: TicketRepo['failTicket'];
  enqueueTicketFn: (ticketId: string) => Promise<void>;
};

export type DlqConsumerHandle = {
  stop: () => void;
  done: Promise<void>;
};

const DLQ_URL = config.sqs.dlqUrl;

function parseMessageBody(msg: Message): { ticketId?: string; raw?: unknown } {
  if (!msg.Body) return { raw: null };
  try {
    const parsed = JSON.parse(msg.Body);
    return { ...(typeof parsed === 'object' ? parsed : { raw: parsed }) };
  } catch {
    return { raw: msg.Body };
  }
}

export function startDlqConsumer(deps: DlqConsumerDeps, pollIntervalMs = 20000): DlqConsumerHandle {
  const controller = new AbortController();

  const done = (async () => {
    const client = sqsClient;
    while (!controller.signal.aborted) {
      try {
        const resp = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: DLQ_URL,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 20,
            VisibilityTimeout: 30,
          }),
        );

        const messages = resp.Messages ?? [];
        for (const m of messages) {
          try {
            const parsed = parseMessageBody(m);
            const ticketId = typeof parsed.ticketId === 'string' ? parsed.ticketId : undefined;

            if (ticketId) {
              await deps.insertEventFn(ticketId, 'dlq_routed', null, { body: parsed });
              await deps.failTicketFn(ticketId);
              logger.error({ ticketId }, 'DLQ: ticket failed after exhausting retries');

              if (config.dlqAutoReplay) {
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

            if (m.ReceiptHandle) {
              await client.send(
                new DeleteMessageCommand({ QueueUrl: DLQ_URL, ReceiptHandle: m.ReceiptHandle }),
              );
            }
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
