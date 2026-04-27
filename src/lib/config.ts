import { z } from 'zod';

const schema = z
  .object({
    nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
    port: z.coerce.number().int().positive().default(3000),
    logLevel: z.string().default('info'),
    databaseUrl: z.string().optional(),
    sqs: z.object({
      queueUrl: z.string().min(1),
      endpoint: z.string().optional(),
      region: z.string().default('us-east-1'),
      accessKeyId: z.string().default('test'),
      secretAccessKey: z.string().default('test'),
    }),
    portkey: z.object({
      apiKey: z.string().optional(),
      config: z.string().optional(),
    }),
  })
  .superRefine((data, ctx) => {
    if (data.nodeEnv !== 'test') {
      if (!data.databaseUrl)
        ctx.addIssue({ code: 'custom', message: 'DATABASE_URL is required', path: ['databaseUrl'] });
      if (!data.portkey.apiKey)
        ctx.addIssue({ code: 'custom', message: 'PORTKEY_API_KEY is required', path: ['portkey', 'apiKey'] });
    }
  });

export const config = schema.parse({
  nodeEnv: process.env['NODE_ENV'],
  port: process.env['PORT'],
  logLevel: process.env['LOG_LEVEL'],
  databaseUrl: process.env['DATABASE_URL'],
  sqs: {
    queueUrl: process.env['SQS_QUEUE_URL'],
    endpoint: process.env['SQS_ENDPOINT'],
    region: process.env['AWS_REGION'],
    accessKeyId: process.env['AWS_ACCESS_KEY_ID'],
    secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'],
  },
  portkey: {
    apiKey: process.env['PORTKEY_API_KEY'],
    config: process.env['PORTKEY_CONFIG'],
  },
});
