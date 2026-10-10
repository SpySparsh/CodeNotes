#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');

// 1. Force deterministic mock Supabase environment for E2E build and execution
const e2eEnv = {
  ...process.env,
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'mock-anon-key',
};

// 2. Perform Next.js production build with deterministic mock environment
console.log('[e2e-runner] Building Next.js application with mock environment...');
const isWindows = process.platform === 'win32';
const npxCmd = isWindows ? 'npx.cmd' : 'npx';

const buildResult = spawnSync(npxCmd, ['next', 'build'], {
  env: e2eEnv,
  stdio: 'inherit',
  shell: true,
  cwd: path.resolve(__dirname, '..'),
});

if (buildResult.status !== 0) {
  console.error('[e2e-runner] Build failed with status:', buildResult.status);
  process.exit(buildResult.status || 1);
}

// 3. Execute Playwright tests with mock environment
console.log('[e2e-runner] Running Playwright deterministic test suite...');
const playwrightArgs = [
  'playwright',
  'test',
  'e2e/auth.spec.ts',
  'e2e/generate.spec.ts',
  'e2e/library.spec.ts',
  ...process.argv.slice(2),
];

const testResult = spawnSync(npxCmd, playwrightArgs, {
  env: e2eEnv,
  stdio: 'inherit',
  shell: true,
  cwd: path.resolve(__dirname, '..'),
});

process.exit(testResult.status ?? 0);
