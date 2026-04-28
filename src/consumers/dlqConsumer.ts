import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { sqsClient } from '../queues/ticketQueue.ts';
import { enqueueTicket } from '../queues/ticketQueue.ts';
import { postgresTicketRepo } from '../repositories/ticketRepo.ts';
import logger from '../lib/logger.ts';

export type DlqConsumerHandle = {
  stop: () => void;
  done: Promise<void>;
};

const DLQ_URL = process.env['SQS_DLQ_URL'];
if (!DLQ_URL) {
  logger.warn('SQS_DLQ_URL is not set — DLQ consumer disabled');
}

function parseMessageBody(msg: Message): { ticketId?: string; raw?: unknown } {
  if (!msg.Body) return { raw: null };
  try {
    const parsed = JSON.parse(msg.Body);
    return { ...(typeof parsed === 'object' ? parsed : { raw: parsed }) };
  } catch {
    return { raw: msg.Body };
  }
}

export function startDlqConsumer(pollIntervalMs = 20000): DlqConsumerHandle {
  const controller = new AbortController();

  const done = (async () => {
    if (!DLQ_URL) return;
    const client: SQSClient = sqsClient as unknown as SQSClient;
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
              await postgresTicketRepo.insertEvent(ticketId, 'dlq_routed', null, { body: parsed });
              logger.info({ ticketId }, 'DLQ: recorded dlq_routed event');
            } else {
              logger.warn({ body: parsed }, 'DLQ: message without ticketId');
            }

            // Optional automatic replay if env variable set
            if (process.env['DLQ_AUTO_REPLAY'] === 'true' && ticketId) {
              try {
                await enqueueTicket(ticketId);
                await postgresTicketRepo.insertEvent(ticketId, 'dlq_routed', null, {
                  by: 'dlqConsumer',
                });
                logger.info({ ticketId }, 'DLQ: requeued ticket');
              } catch (err) {
                logger.error({ err, ticketId }, 'DLQ: failed to requeue');
              }
            }

            // delete message from DLQ after processing
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
