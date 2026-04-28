import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  PurgeQueueCommand,
  ChangeMessageVisibilityCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { z } from 'zod';
import { config } from '../lib/config.ts';

const sqsMessageBodySchema = z.object({ ticketId: z.string() });

const QUEUE_URL = config.sqs.queueUrl;

export const sqsClient = new SQSClient({
  region: config.sqs.region,
  ...(config.sqs.endpoint ? { endpoint: config.sqs.endpoint } : {}),
  credentials: {
    accessKeyId: config.sqs.accessKeyId,
    secretAccessKey: config.sqs.secretAccessKey,
  },
});

export async function enqueueTicket(ticketId: string): Promise<void> {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({ ticketId }),
      // DelaySeconds: 30,
    }),
  );
}

export type SQSTicketMessage = { ticketId: string; receiptHandle: string };

function parseMessage(msg: Message): SQSTicketMessage {
  const body = msg.Body;
  if (!body) throw new Error('SQS message missing Body');

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    throw new Error(`SQS message body is not valid JSON: ${body}`, { cause: err });
  }

  const parsed = sqsMessageBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`SQS message body failed validation: ${parsed.error.message}`);
  }

  const receiptHandle = msg.ReceiptHandle;
  if (!receiptHandle) throw new Error('SQS message missing ReceiptHandle');

  return { ticketId: parsed.data.ticketId, receiptHandle };
}

export async function receiveTickets(signal?: AbortSignal): Promise<SQSTicketMessage[]> {
  if (signal?.aborted) return [];
  try {
    const response = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
        VisibilityTimeout: 300,
      }),
      signal ? { abortSignal: signal } : {},
    );
    return (response.Messages ?? []).map(parseMessage);
  } catch (err) {
    if (signal?.aborted) return [];
    throw new Error('SQS receive failed', { cause: err });
  }
}

export async function deleteTicketMessage(receiptHandle: string): Promise<void> {
  await sqsClient.send(
    new DeleteMessageCommand({
      QueueUrl: QUEUE_URL,
      ReceiptHandle: receiptHandle,
    }),
  );
}

export async function changeMessageVisibility(
  receiptHandle: string,
  delaySeconds: number,
): Promise<void> {
  await sqsClient.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: QUEUE_URL,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: delaySeconds,
    }),
  );
}

export async function purgeQueue(): Promise<void> {
  await sqsClient.send(new PurgeQueueCommand({ QueueUrl: QUEUE_URL }));
}
