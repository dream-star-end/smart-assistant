import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs';
const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { chromium } = require('playwright-core');
const { CcbAdapter } = await tsImport('../../gateway/src/engine/ccbAdapter.ts', import.meta.url);
const { shouldTripIdleWatchdog, IDLE_TIMEOUT_TOOL_MS } = await tsImport('../../gateway/src/sessionManager.ts', import.meta.url);

// No model/network or real user session: only the subprocess is faked. The
// permission parser, adapter, question component and watchdog are production
// implementations. Age the activity timestamp instead of sleeping 20 minutes.
class Runner extends EventEmitter {
  lastActivityAt = Date.now();
  model = 'claude-opus-4-6';
  responses = [];
  async submit() {}
  sendPermissionResponse(requestId, response) {
    this.responses.push({ requestId, response });
    return true;
  }
}

test('Human wait: real PermissionCard click resumes the CCB adapter after twenty minutes', { timeout: 120_000 }, async t => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./human-wait-resume-harness.tsx', import.meta.url))],
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    loader: { '.css': 'empty' },
    alias: { 'node:crypto': fileURLToPath(new URL('./stubs/node-crypto.js', import.meta.url)) },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"MODE":"production","PROD":true,"DEV":false}' },
    logLevel: 'error',
  });
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox'] });
  try {
    for (const width of [1280, 390]) for (const behavior of ['allow', 'deny']) {
      await t.test(`${width}px / ${behavior}`, async () => {
        const runner = new Runner();
        const adapter = new CcbAdapter({}, runner);
        const events = [];
        const turn = adapter.submitTurn({
          input: 'Choose a plan', onEvent: event => events.push(event),
          sessionTotals: { totalCostUSD: 0, turns: 0, _lastCcbCumulativeCost: 0 },
          toolUseIdToName: new Map(),
        });
        await turn.submitted;
        const requestId = `human-wait-${width}-${behavior}`;
        const question = '选择方案';
        runner.emit('message', {
          type: 'control_request', request_id: requestId,
          request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'ask',
            input: { questions: [{ question, header: '方案', options: [{ label: '继续', description: '按方案执行' }] }] } },
        });
        const permission = events.find(event => event.kind === 'permission_request').request;
        runner.lastActivityAt = Date.now() - 20 * 60_000;
        const trips = () => shouldTripIdleWatchdog({ waitingForUserInput: adapter.waitingForUserInput,
          idleMs: Date.now() - adapter.lastActivityAt, thresholdMs: IDLE_TIMEOUT_TOOL_MS });
        assert.equal(trips(), false, 'human wait is exempt before answering');
        let activity = 0;
        adapter.on('activity', () => activity++);
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        try {
          const page = await context.newPage();
          page.setDefaultTimeout(10_000);
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.exposeFunction('answerHumanWait', response => ({
            accepted: adapter.sendPermissionResponse(response.requestId, response),
            trips: trips(), activity,
          }));
          await page.setContent('<!doctype html><meta charset="utf-8"><div id="root"></div>');
          await page.evaluate(msg => { window.humanWaitMessage = msg; }, {
            id: 'permission', role: 'permission', text: '', ts: runner.lastActivityAt,
            requestId, toolName: permission.toolName, inputJson: permission.input,
          });
          await page.addScriptTag({ content: bundle.outputFiles[0].text });
          await page.getByRole('dialog').waitFor();
          if (behavior === 'allow') {
            await page.getByRole('radio', { name: /继续/ }).click();
            await page.getByRole('button', { name: '提交', exact: true }).click();
          } else await page.getByRole('button', { name: '跳过', exact: true }).click();
          await page.waitForFunction(() => document.querySelector('[data-testid="human-wait-result"]').textContent !== '等待作答');
          assert.equal(await page.getByTestId('human-wait-result').textContent(), '继续执行');
          assert.equal(adapter.waitingForUserInput, false);
          assert.equal(runner.responses.length, 1);
          assert.equal(runner.responses[0].response.behavior, behavior);
          if (behavior === 'allow') assert.equal(runner.responses[0].response.updatedInput.answers[question], '继续');
          assert.equal(activity, 1, 'human answer rearms the separate 30min timer');
          assert.deepEqual(errors, []);
          runner.lastActivityAt -= IDLE_TIMEOUT_TOOL_MS + 1;
          assert.equal(trips(), true, 'real post-answer silence is still bounded');
        } finally {
          await context.close();
          runner.emit('message', { type: 'result', subtype: 'success', result: 'done',
            session_id: 'human-wait-fixture', total_cost_usd: 0, num_turns: 1 });
          await turn.summary;
        }
      });
    }
  } finally { await browser.close(); }
});
