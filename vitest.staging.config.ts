import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: 'node',
    globals: true,
    include: [
      'tests/integration/e2e-adaptive-chunking.test.ts',
      'tests/integration/e2e-failed-output-settlement.test.ts',
      'tests/integration/real-provider-adaptive-chunking.test.ts',
      'tests/integration/real-provider-short-video.test.ts',
    ],
    fileParallelism: false,
  },
});
