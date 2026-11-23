import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.integration.test.ts',
      'tests/integration/e2e-adaptive-chunking.test.ts',
      'tests/integration/e2e-failed-output-settlement.test.ts',
      'tests/integration/real-provider-adaptive-chunking.test.ts',
      'tests/integration/real-provider-short-video.test.ts',
    ],
    maxWorkers: 8,
  },
});
