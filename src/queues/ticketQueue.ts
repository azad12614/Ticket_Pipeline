const queue: string[] = [];
const waiters: Array<(ticketId: string) => void> = [];

export function enqueueTicket(ticketId: string): void {
  const waiter = waiters.shift();
  if (waiter) {
    waiter(ticketId);
    return;
  }
  queue.push(ticketId);
}

export async function dequeueTicket(signal?: AbortSignal): Promise<string> {
  const next = queue.shift();
  if (next) return next;

  if (signal?.aborted) {
    const abortError = new Error('Queue dequeue aborted');
    abortError.name = 'AbortError';
    throw abortError;
  }

  return new Promise<string>((resolve, reject) => {
    const waiter = (ticketId: string) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(ticketId);
    };

    const onAbort = () => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      const abortError = new Error('Queue dequeue aborted');
      abortError.name = 'AbortError';
      reject(abortError);
    };

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    waiters.push(waiter);
  });
}

export function getQueueDepth(): number {
  return queue.length;
}

export function resetTicketQueueForTests(): void {
  queue.length = 0;
  waiters.length = 0;
}
