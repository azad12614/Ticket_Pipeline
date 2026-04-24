import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  PurgeQueueCommand,
} from '@aws-sdk/client-sqs';

const QUEUE_URL = process.env['SQS_QUEUE_URL']!;

const endpoint = process.env['SQS_ENDPOINT'];

export const sqsClient = new SQSClient({
  region: process.env['AWS_REGION'] ?? 'us-east-1',
  ...(endpoint ? { endpoint } : {}),
  credentials: {
    accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
    secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
  },
});

export async function enqueueTicket(ticketId: string): Promise<void> {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({ ticketId }),
    }),
  );
}

export type SQSTicketMessage = { ticketId: string; receiptHandle: string };

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
    return (response.Messages ?? []).map(msg => ({
      ticketId: (JSON.parse(msg.Body!) as { ticketId: string }).ticketId,
      receiptHandle: msg.ReceiptHandle!,
    }));
  } catch {
    if (signal?.aborted) return [];
    throw new Error('SQS receive failed');
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

export async function purgeQueue(): Promise<void> {
  await sqsClient.send(new PurgeQueueCommand({ QueueUrl: QUEUE_URL }));
}
