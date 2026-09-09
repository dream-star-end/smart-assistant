/** Explicit live smoke. Never run by unit tests or by a reviewer.
 * Run from the repository root after code approval and policy installation:
 * node --import tsx scripts/cursor-sand-box-relay/real-ccb-smoke.mjs --run
 * Uses the real root selector, product Adapter, CCB process and Box resolver.
 */
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { readConfig } from '@openclaude/storage';
import { CursorSandAdapter } from '../../packages/gateway/src/engine/cursorSandAdapter.js';
import { selectCursorCredential } from '../../packages/gateway/src/engine/cursorCredentialSelection.js';
import { readCursorSandBoxPolicy } from '../../packages/gateway/src/engine/cursorSandBox.js';

if (process.argv.length !== 3 || process.argv[2] !== '--run') throw new Error('Explicit --run is required; this uses Sand quota');
const directory = resolve(process.env.OPENCLAUDE_HOME || '/home/agent/.openclaude', 'generated/ocv5-198-live-ccb');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const report = join(directory, 'result.json');
if (existsSync(report)) throw new Error('A live attempt already exists; inspect its receipt before another run');
const expected = `CCB_LOCAL_${randomBytes(16).toString('hex')}`;
const inputPath = join(directory, 'input.txt');
writeFileSync(inputPath, expected + '\n', { mode: 0o600, flag: 'wx' });
const sessionKey = `agent:main:webchat:dm:ocv5-198-smoke-${randomBytes(6).toString('hex')}`;
const model = 'cursor-grok-4.6-high';
const selection = selectCursorCredential({ agentId: 'main', sessionKey, agentBaseDir: directory, model });
assert.equal(selection.accountId, '19');
assert.equal(selection.sandEnabled, true);
assert.equal(selection.credentialKind, 'session');
assert.ok(readCursorSandBoxPolicy()?.accounts.some(a => a.accountId === selection.accountId));
const config = await readConfig();
assert.ok(config, 'normal platform config required');
const result = {
  at: new Date().toISOString(), model, sessionKey, accountId: selection.accountId,
  generation: selection.poolGeneration, harness: 'real CursorSandAdapter + CCB',
  expected, phase: 'starting', toolNames: [], toolResults: 0, slotResults: [],
  sourceHashes: Object.fromEntries(['cursorSandBox.ts', 'cursorSandRelay.ts', 'cursorSandAdapter.ts'].map(name => [name,
    createHash('sha256').update(readFileSync(resolve('packages/gateway/src/engine', name))).digest('hex')])),
};
writeFileSync(report, JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
const adapter = new CursorSandAdapter({
  sessionKey, agentId: 'main', agentBaseDir: directory, config: { ...config, terminal: { ...config.terminal, type: 'local' } },
  model, cursorCredentialSelection: selection, harness: 'ccb', executionTarget: { kind: 'local' },
  agentMcpServers: [], agentToolsets: [], permissionMode: 'default',
}, undefined, undefined, verdict => result.slotResults.push(verdict));
let run;
const timer = setTimeout(() => { result.phase = 'timeout'; result.timedOut = true; run?.end(); void adapter.shutdown(); }, 180000);
adapter.on('error', () => { result.runnerError = true; });
try {
  run = adapter.submitTurn({
    input: `Use the native Read tool to read exactly this local file: ${inputPath}. Then reply with only its single-line contents. You MUST use Read first. Do not call any other tool, contact the network, delegate, or modify files.`,
    requestId: randomBytes(16).toString('hex'), sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map(),
    onEvent(event) {
      if (event.kind === 'tool_use_detected') result.toolNames.push(event.tool?.name || 'unknown');
      if (event.kind === 'tool_result_detected') result.toolResults++;
      if (event.kind === 'permission_request') { result.permissionRequested = true; run?.end(); }
    },
  });
  await run.submitted;
  const summary = await run.summary;
  result.isError = summary?.isError ?? true;
  result.exactMatch = summary?.assistantText?.trim() === expected;
  result.textCharacters = summary?.assistantText?.length ?? 0;
  result.nativeResumeId = adapter.currentSessionId ?? null;
  result.phase = 'completed';
  assert.equal(result.isError, false);
  assert.equal(result.exactMatch, true);
  assert.ok(result.toolNames.includes('Read'));
  assert.ok(result.toolResults >= 1);
  assert.equal(result.permissionRequested, undefined);
} catch (error) {
  result.phase = 'failed';
  // Error content can originate upstream. Keep a digest, never dump credentials
  // or arbitrary upstream text into a public report.
  result.errorType = error?.name || 'Error';
  result.errorHash = createHash('sha256').update(String(error)).digest('hex');
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await adapter.shutdown();
  result.transport = adapter.getRequestStats();
  result.noSdkReplayOrPassthrough = result.transport.messages === 2
    && result.transport.inferenceAttempts === 2 + result.transport.toolCorrections
    && result.transport.passthroughAttempts === 0;
  if (!result.noSdkReplayOrPassthrough) { result.phase = 'failed'; process.exitCode = 1; }
  writeFileSync(report, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
}
