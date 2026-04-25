import { FatalPhaseError } from '../lib/errors.ts';
import logger from '../lib/logger.ts';
import { receiveTickets, deleteTicketMessage, changeMessageVisibility } from '../queues/ticketQueue.ts';
import { runPhase } from '../services/aiService.ts';
import {
  claimPhaseForProcessing,
  completePhaseSuccess,
  failPhaseAttempt,
  getTicketById,
  getTicketPhasesByTicketId,
  transitionTicketStatus,
  updateTicketStatus,
} from '../repositories/ticketRepo.ts';
import type { Ticket } from '../schemas/ticketSchema.ts';
import type { TicketPhase } from '../schemas/phaseSchema.ts';

type TicketStatus = Ticket['status'];
type PhaseName = TicketPhase['phase'];

type WorkerDeps = {
  getTicketByIdFn?: typeof getTicketById;
  getTicketPhasesByTicketIdFn?: typeof getTicketPhasesByTicketId;
  transitionTicketStatusFn?: typeof transitionTicketStatus;
  updateTicketStatusFn?: typeof updateTicketStatus;
  claimPhaseForProcessingFn?: typeof claimPhaseForProcessing;
  completePhaseSuccessFn?: typeof completePhaseSuccess;
  failPhaseAttemptFn?: typeof failPhaseAttempt;
  processPhaseFn?: (ticketId: string, phase: PhaseName) => Promise<unknown>;
  changeMessageVisibilityFn?: (receiptHandle: string, delaySeconds: number) => Promise<void>;
  deleteMessageFn?: (receiptHandle: string) => Promise<void>;
};

function isTerminalStatus(status: TicketStatus): boolean {
  return status === 'completed' || status === 'failed';
}

function findNextPhase(phases: TicketPhase[]): PhaseName | null {
  const triage = phases.find(phase => phase.phase === 'triage');
  const draft = phases.find(phase => phase.phase === 'draft');

  if (!triage || !draft) return null;

  if (triage.status !== 'success') return 'triage';
  if (draft.status !== 'success') return 'draft';
  return null;
}

function backoffSeconds(attempts: number): number {
  return Math.ceil((Math.pow(2, attempts) * 1000 + Math.random() * 500) / 1000);
}

export async function processTicketLifecycle(
  ticketId: string,
  receiptHandle: string,
  deps: WorkerDeps = {},
): Promise<void> {
  const getTicketByIdFn = deps.getTicketByIdFn ?? getTicketById;
  const getTicketPhasesByTicketIdFn = deps.getTicketPhasesByTicketIdFn ?? getTicketPhasesByTicketId;
  const transitionTicketStatusFn = deps.transitionTicketStatusFn ?? transitionTicketStatus;
  const updateTicketStatusFn = deps.updateTicketStatusFn ?? updateTicketStatus;
  const claimPhaseForProcessingFn = deps.claimPhaseForProcessingFn ?? claimPhaseForProcessing;
  const completePhaseSuccessFn = deps.completePhaseSuccessFn ?? completePhaseSuccess;
  const failPhaseAttemptFn = deps.failPhaseAttemptFn ?? failPhaseAttempt;
  const processPhaseFn = deps.processPhaseFn ?? runPhase;
  const changeMessageVisibilityFn = deps.changeMessageVisibilityFn ?? changeMessageVisibility;
  const deleteMessageFn = deps.deleteMessageFn ?? deleteTicketMessage;

  const existing = await getTicketByIdFn(ticketId);
  if (!existing) {
    logger.warn({ ticketId }, 'Skipping unknown ticket from queue');
    await deleteMessageFn(receiptHandle);
    return;
  }

  if (isTerminalStatus(existing.status)) {
    logger.info({ ticketId, status: existing.status }, 'Skipping terminal ticket');
    await deleteMessageFn(receiptHandle);
    return;
  }

  const claimed = await transitionTicketStatusFn(ticketId, ['queued'], 'processing');
  if (!claimed) {
    const current = await getTicketByIdFn(ticketId);
    if (current && !isTerminalStatus(current.status)) {
      logger.warn({ ticketId, status: current.status }, 'Ticket not claimable for processing');
    }
    return;
  }

  logger.info({ ticketId }, 'Ticket claimed — processing started');

  try {
    while (true) {
      const phases = await getTicketPhasesByTicketIdFn(ticketId);
      const nextPhase = findNextPhase(phases);

      if (!nextPhase) {
        await transitionTicketStatusFn(ticketId, ['processing'], 'completed');
        await deleteMessageFn(receiptHandle);
        logger.info({ ticketId }, 'Ticket completed — all phases done');
        return;
      }

      const phaseClaim = await claimPhaseForProcessingFn(ticketId, nextPhase);
      if (!phaseClaim) {
        logger.warn({ ticketId, phase: nextPhase }, 'Phase not claimable for processing');
        return;
      }

      logger.info({ ticketId, phase: nextPhase, attempt: phaseClaim.attempts }, 'Phase started');

      try {
        const output = await processPhaseFn(ticketId, nextPhase);
        await completePhaseSuccessFn(ticketId, nextPhase, output);
        logger.info({ ticketId, phase: nextPhase }, 'Phase completed');
      } catch (phaseError) {
        if (phaseError instanceof FatalPhaseError) {
          logger.error({ err: phaseError, ticketId, phase: nextPhase }, 'Fatal phase error — skipping retry');
          await failPhaseAttemptFn(ticketId, nextPhase);
          await transitionTicketStatusFn(ticketId, ['queued', 'processing'], 'failed');
          await changeMessageVisibilityFn(receiptHandle, 0);
          return;
        }

        logger.error({ err: phaseError, ticketId, phase: nextPhase }, 'Phase processing failed');
        const failedPhase = await failPhaseAttemptFn(ticketId, nextPhase);

        if (!failedPhase) {
          await updateTicketStatusFn(ticketId, 'failed');
          await changeMessageVisibilityFn(receiptHandle, 0);
          return;
        }

        if (failedPhase.attempts >= 3) {
          await transitionTicketStatusFn(ticketId, ['queued', 'processing'], 'failed');
          await changeMessageVisibilityFn(receiptHandle, 0);
        } else {
          await transitionTicketStatusFn(ticketId, ['processing'], 'queued');
          await changeMessageVisibilityFn(receiptHandle, backoffSeconds(failedPhase.attempts));
        }

        return;
      }
    }
  } catch (error) {
    logger.error({ err: error, ticketId }, 'Ticket processing failed');
    const failed = await transitionTicketStatusFn(ticketId, ['queued', 'processing'], 'failed');
    if (!failed) {
      await updateTicketStatusFn(ticketId, 'failed');
    }
    await changeMessageVisibilityFn(receiptHandle, 0);
  }
}

export type WorkerHandle = {
  stop: () => void;
  done: Promise<void>;
};

export function startTicketWorker(deps: WorkerDeps = {}): WorkerHandle {
  const controller = new AbortController();

  const done = (async () => {
    while (!controller.signal.aborted) {
      try {
        const messages = await receiveTickets(controller.signal);
        for (const { ticketId, receiptHandle } of messages) {
          await processTicketLifecycle(ticketId, receiptHandle, deps);
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        logger.error({ err: error }, 'Worker loop error');
      }
    }
  })();

  return {
    stop: () => controller.abort(),
    done,
  };
}
