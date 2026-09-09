import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const root = process.cwd()
const relay = readFileSync(resolve(root, 'packages/gateway/src/engine/cursorSandRelay.ts'), 'utf8')
const inferenceProto = readFileSync(resolve(root, 'packages/gateway/src/engine/cursorSandInference.proto'), 'utf8')
const adapter = readFileSync(resolve(root, 'packages/gateway/src/engine/cursorSandAdapter.ts'), 'utf8')
const routing = readFileSync(resolve(root, 'packages/gateway/src/engine/cursorRoutingAdapter.ts'), 'utf8')
const selection = readFileSync(resolve(root, 'packages/gateway/src/engine/cursorCredentialSelection.ts'), 'utf8')
const registry = readFileSync(resolve(root, 'packages/gateway/src/engine/cursorAdapter.ts'), 'utf8')
const wrapper = readFileSync(resolve(root, 'packages/commercial/agent-sandbox/platform-runtime/bin/oc-cursor.sh'), 'utf8')
const tests = readFileSync(resolve(root, 'packages/gateway/src/__tests__/cursorSandRelay.test.ts'), 'utf8')
const resumeTests = readFileSync(resolve(root, 'packages/gateway/src/__tests__/sessionManagerResumeMap.test.ts'), 'utf8')
const wrapperTests = readFileSync(resolve(root, 'packages/commercial/src/__tests__/cursorCliWrapper.test.ts'), 'utf8')
const materializer = readFileSync(resolve(root, 'packages/commercial/src/account-pool/cursorMaterializer.ts'), 'utf8')
const quota = readFileSync(resolve(root, 'packages/commercial/src/account-pool/cursorQuota.ts'), 'utf8')
const bridge = readFileSync(resolve(root, 'packages/commercial/src/ws/userChatBridge.ts'), 'utf8')
const frames = readFileSync(resolve(root, 'packages/protocol/src/frames.ts'), 'utf8')
const commercialDeploy = readFileSync(resolve(root, 'scripts/deploy-v5.sh'), 'utf8')
const selfhostRelease = readFileSync(resolve(root, 'scripts/v5-selfhost-master-release-lib.sh'), 'utf8')

assert.match(relay, /\/aiserver\.v1\.InferenceService\/Stream/)
assert.match(relay, /'x-cursor-client-type': 'sand'/)
assert.doesNotMatch(relay, /agent\.v1\.AgentService\/Run/)
assert.doesNotMatch(relay, /startsWith\('claude-fable-5'\)/)
assert.match(inferenceProto, /Struct parameters = 3;/)
assert.doesNotMatch(inferenceProto, /parameters_json_schema/)
assert.match(relay, /jsonSchema: protoValue\(schema\)/)
assert.match(relay, /rawToolCallArgs: JSON\.stringify/)
assert.match(relay, /toolContent:/)
assert.match(relay, /mergeToolPart\(state\.tools, part\)/)
assert.match(relay, /pipeNativeStreaming\(/)
assert.match(adapter, /await this\.prepareRelay\(generation\)/)
assert.match(adapter, /this\.emit\('external_billing'/)
assert.match(adapter, /cursorSlotResults:/)
assert.match(adapter, /supportsNativeCompact: false/)
assert.match(registry, /CURSOR_SAND_RESUME_PREFIX = 'sand-ccb:'/)
assert.match(registry, /CURSOR_SAND_OFFICIAL_CC_RESUME_PREFIX = 'sand-official-cc:'/)
assert.match(routing, /resumeForVariant\(this\.opts\.resumeSessionId, variant\)/)
assert.match(routing, /variant !== 'native'/)
assert.match(routing, /variant === 'sand-official-cc'/)
assert.match(routing, /harness: variant === 'sand-official-cc' \? 'official-cc'/)
assert.match(routing, /new CursorSandAdapter\(innerOpts\)/)
assert.match(routing, /new CursorAdapter\(innerOpts\)/)
assert.match(routing, /CURSOR_SAND_RESUME_PREFIX/)
assert.match(routing, /cursorSandResumeInnerId/)
assert.match(routing, /await this\.ensureVariant\(generation\)/)
assert.match(routing, /opts\.cursorCredentialSelection \?\? selector\(/)
assert.match(routing, /cursorCredentialSelection: this\.credentialSelection/)
assert.doesNotMatch(routing, /compactForHandoff/)
assert.match(selection, /OPENCLAUDE_CURSOR_SELECT_ONLY/)
assert.match(selection, /OPENCLAUDE_CURSOR_SELECTED_KEY/)
assert.match(selection, /OPENCLAUDE_CURSOR_POOL_GENERATION/)
assert.match(wrapper, /oc-cursor: selected_slot/)
assert.doesNotMatch(wrapper, /set -- -H "x-cursor-client-type: sand"/)
assert.match(registry, /new CursorRoutingAdapter\(opts\)/)
assert.match(registry, /env\.OPENCLAUDE_CURSOR_SELECTED_KEY/)
assert.match(tests, /tool recovery accepts XML and bounded compact control but rejects unknown tools/)
assert.match(tests, /downstream abort cancels the Cursor stream and relay close does not hang/)
assert.match(tests, /ordinary tool examples remain text and do not trigger a correction request/)
assert.match(tests, /mixed tool JSON and fabricated result is corrected to structured tool_use without leaking raw text/)
assert.match(tests, /Grok Sand encodes native tool schemas and structured tool-result history/)
assert.match(tests, /Fable Sand encodes native tool schemas and structured tool-result history/)
assert.match(tests, /native Fable forwards thinking before the upstream stream ends/)
assert.match(resumeTests, /Cursor Sand resume ids validate against CCB JSONL instead of Cursor workspace store/)
assert.match(tests, /interrupt before cold Sand preparation prevents submission/)
assert.match(tests, /shutdown during cold Sand preparation waits and prevents resurrection/)
assert.match(tests, /shutdown during Sand preheat waits and leaves no revived runner/)
assert.match(tests, /routing shutdown during deferred preparation prevents resurrection/)
assert.match(tests, /every concrete catalog Cursor model maps to its Sand InferenceService id/)
assert.match(tests, /credential selector parses a high-numbered Sand slot and records the same binding/)
assert.match(tests, /failed credential rebinds within the same transport but refuses a native-to-Sand failover/)
assert.match(tests, /concrete model quota-family changes reselect an eligible key before the next turn/)
assert.match(wrapper, /\/usr\/bin\/sort -n/)
assert.match(wrapperTests, /ten-key selection stays numeric and resolves billing to the tenth account/)
assert.match(wrapperTests, /an immutable generation keeps a bound Sand account stable after pool compaction/)
assert.match(tests, /pool generation changes rebind stable account identity before reading a reused slot/)
assert.match(materializer, /CURSOR_POOL_GENERATIONS_DIR/)
assert.match(materializer, /CURSOR_POOL_IDENTITIES_FILE/)
assert.match(wrapper, /printf 'v2 %s %s %s\\n'/)
assert.match(quota, /planStableCursorQuotaUpdate/)
assert.match(bridge, /stableAccountId: stableIdentityProvided \? cursorAccountId : undefined/)
assert.match(bridge, /stableIdentityProvided && !stableIdentityComplete/)
assert.match(frames, /CursorStablePoolIdentity/)
assert.match(commercialDeploy, /check-v5-cursor-sand-inference\.ts/)
assert.match(selfhostRelease, /check-v5-cursor-sand-inference\.ts/)

// INC-20260903-CURSOR-CLI-ERROR-WASH: finish() must keep sanitized Cursor CLI error text on tape.
// The washed literal 'Cursor CLI failed' must not come back as the ENGINE_ERROR detail; the
// redacted first-line summary goes through cursorCliErrorSanitize and the raw is only warn-logged.
const sanitizer = readFileSync(resolve(root, 'packages/gateway/src/engine/cursorCliErrorSanitize.ts'), 'utf8')
const sanitizerTests = readFileSync(resolve(root, 'packages/gateway/src/__tests__/cursorCliErrorSanitize.test.ts'), 'utf8')
assert.match(registry, /formatCursorCliFailureDetail\(detail\)/)
assert.match(registry, /error: formatCursorCliFailureLog\(detail\)/)
assert.doesNotMatch(registry, /: 'Cursor CLI failed'/)
assert.match(sanitizer, /export const CURSOR_CLI_FAILURE_DETAIL_MAX = 200/)
assert.match(sanitizer, /export const CURSOR_CLI_FAILURE_LOG_MAX = 2000/)
assert.match(sanitizerTests, /keeps the first-line Sand root cause under the tape cap/)

// INC-20260904-OFFICIAL-CC-STOP-STALE-PROCESS: official Claude Code answers Stop with an
// `aborted_streaming` result and exits 1 a few seconds later. The runner must retire that
// process generation on the result frame (never keep writing the next user turn into the
// dying CLI, never surface its trailing exit(1) as RUNNER_CRASHED) and log who asked for
// every shutdown so recover-loop triggers are attributable.
const runner = readFileSync(resolve(root, 'packages/gateway/src/subprocessRunner.ts'), 'utf8')
const runnerAbortTests = readFileSync(
  resolve(root, 'packages/gateway/src/__tests__/subprocessRunnerOfficialAbortRecycle.test.ts'),
  'utf8',
)
assert.match(runner, /this\.opts\.harness === 'official-cc' && _isOfficialClaudeAbortResult\(msg\)/)
assert.match(runner, /this\.retireOfficialAbortedProcess\(\)/)
assert.match(runner, /private retireOfficialAbortedProcess\(\): void/)
assert.match(runner, /official-cc abort result observed; retiring process generation/)
assert.match(runner, /official-cc did not exit after abort result; killing process group/)
assert.match(runner, /origin: _shutdownOriginFrames\(new Error\(\)\.stack\)/)
assert.match(runnerAbortTests, /detaches proc, reports not running, and swallows the trailing exit\(1\)/)
assert.match(runnerAbortTests, /retired generation stdout close does not settle a newer generation barrier/)

console.log('[cursor-sand-inference] PASS — Sand keys use InferenceService with native tool schemas; native Cursor stays isolated to native keys and Auto')

// INC-20260909-CURSOR-SAND-BOX-TRANSPORT: execute synthetic loopback contracts,
// not merely their source anchors. This is NOT a live provider/paid CCB smoke.
const sandbox = mkdtempSync(resolve(tmpdir(), 'oc-sand-box-gate-'))
try {
  for (const dir of ['home', 'oc', 'tmp', 'snapshots', 'intents']) mkdirSync(resolve(sandbox, dir))
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, LANG: process.env.LANG, TZ: process.env.TZ,
    HOME: resolve(sandbox, 'home'), OPENCLAUDE_HOME: resolve(sandbox, 'oc'),
    TMPDIR: resolve(sandbox, 'tmp'), NODE_ENV: 'test', OC_MODEL_AUTHORITY: '0',
    OC_DELEGATE_SM: '0', OC_DELEGATE_DURABLE: '0',
    OC_DELEGATE_NOTIFIER: '0', OC_DELEGATE_CUTOVER: '0',
    OPENCLAUDE_DELEGATE_JOBS_DB: resolve(sandbox, 'jobs.db'),
    OPENCLAUDE_DELEGATE_INFLIGHT_DB: resolve(sandbox, 'inflight.db'),
    OPENCLAUDE_DELEGATE_JOB_SNAPSHOT_DIR: resolve(sandbox, 'snapshots'),
    OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR: resolve(sandbox, 'intents'),
  }
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1',
    'packages/gateway/src/__tests__/cursorSandBox.test.ts',
    'packages/gateway/src/__tests__/cursorSandBoxPolicy.test.ts',
    'packages/gateway/src/__tests__/cursorSandRelay.test.ts',
    'scripts/cursor-sand-box-relay/relay.test.cjs',
    'scripts/cursor-sand-box-relay/smoke-final-text.test.mjs',
  ], { cwd: root, env, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL',
    maxBuffer: 8 * 1024 * 1024, detached: true })
  // A killed test-runner may leave workers; they share only our detached group.
  if ((result.error || result.signal) && result.pid > 0) {
    try { process.kill(-result.pid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  assert.ifError(result.error)
  assert.equal(result.signal, null, 'Box contract runner terminated by signal')
  assert.equal(result.status, 0, 'Box contract runner failed')
  const tap = result.stdout
  const plans = [...tap.matchAll(/^1\.\.(\d+)$/gm)]
  assert.equal(plans.length, 1, 'missing or ambiguous complete TAP plan')
  const count = Number(plans[0][1])
  assert.ok(count >= 84, `Box contract execution count too low: ${count}`)
  const outcomes = [...tap.matchAll(/^(not )?ok (\d+) - (.+)$/gm)]
  assert.equal(outcomes.length, count, 'incomplete TAP results')
  for (const [index, outcome] of outcomes.entries()) {
    assert.equal(outcome[1], undefined, 'failed TAP result')
    assert.equal(Number(outcome[2]), index + 1, 'noncontiguous TAP results')
    assert.doesNotMatch(outcome[3], /#\s*(SKIP|TODO)\b/i)
  }
  for (const [label, expected] of [['tests', count], ['pass', count], ['fail', 0], ['cancelled', 0], ['skipped', 0], ['todo', 0]] as const) {
    const summaries = [...tap.matchAll(new RegExp(`^# ${label} (\\d+)$`, 'gm'))]
    assert.equal(summaries.length, 1, `missing or ambiguous ${label} summary`)
    assert.equal(Number(summaries[0][1]), expected, `${label} summary mismatch`)
  }
  for (const name of [
    'Box HTTP failures keep no-retry transport scope, descriptor cache, and true account/quota distinctions',
    'Box Connect unauthenticated trailers preserve transport identity in both response modes',
    'actual Relay rejection feeds actual Adapter billing chain without poisoning the account',
    'terminal Box ticket error never enters tool correction: cursor-fable-5-high',
    'terminal Box ticket error never enters tool correction: cursor-grok-4.6-high',
  ]) assert.ok(outcomes.some((outcome) => outcome[3] === name), `required contract did not execute: ${name}`)
  console.log('[cursor-sand-box] PASS — isolated Box transport, account health, and terminal no-retry contracts executed')

  // INC-20260909-CURSOR-SAND-BOX-NOT-RUNNING: the relay's `400 invalid_request_error
  // CURSOR_SAND_BOX_* [non-retryable]` envelope only stops CCB's in-request loop; the
  // gateway must still classify it as transient infrastructure so the turn enters
  // automatic recovery instead of a "请调整内容后重试" bad_request card. Execute the
  // classifier and the throw/resolved surface matrix, which pins both gateway retry
  // seams to the same taxonomy code for every declared classification.
  const classifyResult = spawnSync(process.execPath, [
    '--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1',
    'packages/gateway/src/__tests__/errorClassify.test.ts',
    'packages/gateway/src/__tests__/terminalErrorSurfaceMatrix.test.ts',
  ], { cwd: root, env, encoding: 'utf8', timeout: 180_000, killSignal: 'SIGKILL',
    maxBuffer: 8 * 1024 * 1024, detached: true })
  if ((classifyResult.error || classifyResult.signal) && classifyResult.pid > 0) {
    try { process.kill(-classifyResult.pid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  process.stdout.write(classifyResult.stdout ?? '')
  process.stderr.write(classifyResult.stderr ?? '')
  assert.ifError(classifyResult.error)
  assert.equal(classifyResult.signal, null, 'Box classification contract runner terminated by signal')
  assert.equal(classifyResult.status, 0, 'Box classification contract runner failed')
  const classifyTap = classifyResult.stdout
  for (const label of ['fail', 'cancelled', 'todo']) assert.match(classifyTap, new RegExp(`^# ${label} 0$`, 'm'))
  const classifyOutcomes = [...classifyTap.matchAll(/^ +ok \d+ - (.+)$/gm)]
    .map((match) => match[1]).filter((name) => !/#\s*(SKIP|TODO)\b/i.test(name))
  for (const name of [
    'Cursor Sand Box transport fault is an upstream outage, not a bad request (INC-20260909-CURSOR-SAND-BOX-NOT-RUNNING)',
    'Cursor Sand Box BUSY is model capacity (retry later or switch), not a bad request',
    'Cursor Sand Box INFERENCE_TICKET_REJECTED keeps its terminal classification (INC-20260909-CURSOR-SAND-BOX-TRANSPORT)',
    'generic 400 invalid request without a Box marker still stays bad_request',
    'upstream_failed: 两种投递形态都恰好 11 次尝试',
    'bad_request: 两种投递形态都恰好 1 次尝试',
  ]) assert.ok(classifyOutcomes.includes(name), `required classification contract did not execute: ${name}`)
  console.log('[cursor-sand-box-classify] PASS — Box transport faults classify as recoverable upstream outage in both gateway retry seams')

  // INC-20260909-CURSOR-EMPTY-POOL-MOUNT: execute the real root-filesystem
  // transitions and production provision path. Docker/PG are substituted here;
  // diagnostics/cursor-auth-mount-smoke.ts separately tests an actual Docker bind.
  const mountResult = spawnSync(process.execPath, [
    '--import', 'tsx', '--test', '--test-reporter=tap',
    '--test-name-pattern=resolveV5CursorAuthMount|v5 empty managed Cursor',
    'packages/commercial/src/__tests__/v3Supervisor.test.ts',
  ], { cwd: root, env, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL',
    maxBuffer: 8 * 1024 * 1024, detached: true })
  if ((mountResult.error || mountResult.signal) && mountResult.pid > 0) {
    try { process.kill(-mountResult.pid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  process.stdout.write(mountResult.stdout ?? '')
  process.stderr.write(mountResult.stderr ?? '')
  assert.ifError(mountResult.error)
  assert.equal(mountResult.signal, null, 'Cursor mount contract runner terminated by signal')
  assert.equal(mountResult.status, 0, 'Cursor mount contract runner failed')
  const mountTap = mountResult.stdout
  assert.match(mountTap, /^# pass 12$/m, 'all twelve selected mount contracts must execute')
  for (const label of ['fail', 'cancelled', 'todo']) assert.match(mountTap, new RegExp(`^# ${label} 0$`, 'm'))
  const mountOutcomes = [...mountTap.matchAll(/^ +ok \d+ - (.+)$/gm)]
    .map((match) => match[1]).filter((name) => !/#\s*(SKIP|TODO)\b/i.test(name))
  for (const name of [
    'empty managed pool keeps the directory mount across 0→1→0→1 atomic publication',
    ...['symlink', 'dangling-symlink', 'directory', 'fifo', 'public', 'non-root', 'wrong-content']
      .map((variant) => `empty managed pool rejects ${variant} ownership marker`),
    'valid managed marker cannot excuse an existing unsafe or dangling key',
    'v5 empty managed Cursor pool provisions the same read-only bind before a key is ready',
  ]) assert.ok(mountOutcomes.includes(name), `required mount contract did not execute: ${name}`)
  console.log('[cursor-auth-mount] PASS — real FS empty-pool transitions and production read-only bind configuration verified (Docker/PG substituted)')
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
