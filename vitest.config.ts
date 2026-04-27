import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 15000,
    env: {
      NODE_ENV: 'test',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      SQS_ENDPOINT: 'http://localhost:4566',
      SQS_QUEUE_URL: 'http://localhost:4566/000000000000/tickets',
      PORTKEY_API_KEY: 'test',
    },
  },
});
