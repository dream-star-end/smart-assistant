// OCV5-54 candidate-source wiring proof.
//
// These bugs live on the container gateway (/api/agents/:id/delegate), which
// commercial HTTP blocks for users. The live-e2e runner still executes this
// spec (run.sh forbids skip), so it re-runs the candidate tree's gateway
// unit tests that spawn Cursor MCP and hit handleDelegateTask in-process.

import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

function runGatewayTest(file: string, namePattern: string): void {
  const tsx = resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
  expect(existsSync(tsx), `candidate tree missing tsx at ${tsx}`).toBeTruthy();
  const env = { ...process.env };
  delete env.OC_MODEL_AUTHORITY;
  delete env.OC_SELFHOST_ENGINE_LOCAL_TURNS;
  const result = spawnSync(
    process.execPath,
    [tsx, '--test', '--test-concurrency=1', '--test-name-pattern', namePattern, file],
    { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 120_000 },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

test('spawned Cursor MCP config injects delegate-context file mode 0600 and cleans it up', () => {
  runGatewayTest(
    'packages/gateway/src/__tests__/cursorAdapter.test.ts',
    'spawned Cursor MCP config injects delegate-context file mode 0600 and cleans it up',
  );
});

test('explicit unknown slug returns 400 DELEGATE_MODEL_UNKNOWN without a job', () => {
  runGatewayTest(
    'packages/gateway/src/__tests__/delegateAsyncJobs.test.ts',
    'async flag-off explicit unknown model rejects at entry \\(no job\\)',
  );
});
