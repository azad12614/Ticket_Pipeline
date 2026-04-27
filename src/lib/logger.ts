import pino from 'pino';
import { config } from './config.ts';

const PII_FIELDS = new Set(['body', 'email']);

function redactPii(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = PII_FIELDS.has(k) ? '[REDACTED]' : v;
  }
  return result;
}

const transport =
  config.nodeEnv !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined;

const logger = pino({
  level: config.logLevel,
  serializers: {
    ticket: redactPii,
    req: (req: Record<string, unknown>) => redactPii(req),
  },
  ...(transport ? { transport } : {}),
});

export function childLogger(ticketId: string) {
  return logger.child({ ticketId });
}

export default logger;
