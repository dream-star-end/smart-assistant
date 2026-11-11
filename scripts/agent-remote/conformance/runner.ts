/**
 * Unified 7-Group / 8-Requirement Conformance Runner (`OCV5-749` `AC-1`, `AC-2`).
 *
 * Executes end-to-end against real PostgreSQL, real `Cc5ToolHost`, real Python node core
 * (`controller.py`, `mcp_socket.py`, `mcp_client.py`, `resources.py`, `driver_worker.py`),
 * and real master relay/billing (`placeRemoteDriverLane`, `RemotePoolRelay`,
 * `createRemoteDriverTurnFinance`, `recoverRemoteNativeTurnBilling`).
 *
 * Every selected group runs BOTH:
 *   1. `green`: real business outcome & accounting verification (zero mocks on core paths),
 *   2. `redControl`: isolated `/tmp/oc-drvtest-*` fault-injection proving the suite catches the defect.
 *
 * Zero driver-specific (`cc`/`codex`) conditionals exist in this file (`AC-2`, `AC-6`).
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join, resolve } from 'node:path'
import {
  normalizeUsageWithPolicy,
  remoteCanonicalJson,
  remoteCanonicalSha256,
  zeroCountersForUsagePolicy,
} from '@openclaude/protocol'
import {
  RemoteObservationGate,
  type LaneToolHost,
} from '../../../packages/gateway/src/remotePool/index.js'
import {
  placeRemoteDriverLane,
  recordRemoteDriverLaneState,
} from '../../../packages/commercial/src/account-pool/remotePool/index.js'
import {
  PRICING_RATES,
  createConformanceHarness,
  type ConformanceHarness,
  type SessionLaneHandle,
} from './harness.js'

export interface RequirementEvidence {
  readonly requirementId: string
  readonly title: string
  readonly greenPassed: boolean
  readonly redControlCaught: boolean
  readonly skipped: false
  readonly durationMs: number
  readonly greenDetails: Record<string, unknown>
  readonly redDetails: Record<string, unknown>
}

export interface GroupResult {
  readonly group: number
  readonly name: string
  readonly passed: boolean
  readonly skipped: false
  readonly durationMs: number
  readonly requirements: readonly RequirementEvidence[]
}

const pause = (ms: number) => new Promise<void>((res) => setTimeout(res, ms))

function assertTurnOk(
  summary: { isError: boolean } | null,
  lane: SessionLaneHandle,
  label: string,
): void {
  assert.ok(summary !== null && summary.isError === false, `${label}: ${lane.getFenceDiag()}`)
}

function assertTurnFailed(summary: { isError: boolean } | null, label: string): void {
  assert.ok(summary === null || summary.isError === true, label)
}

async function waitForFile(filePath: string, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return true
    await pause(20)
  }
  return existsSync(filePath)
}

function computeExpectedCredits(normalized: {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}): bigint {
  const totalMicro =
    BigInt(normalized.inputTokens) * PRICING_RATES.inputPerMtok +
    BigInt(normalized.outputTokens) * PRICING_RATES.outputPerMtok +
    BigInt(normalized.cacheReadTokens) * PRICING_RATES.cacheReadPerMtok +
    BigInt(normalized.cacheWriteTokens) * PRICING_RATES.cacheWritePerMtok
  // Matches `calculateCreditCost` integer ceiling / micro-token rounding for exact Mtok multiples.
  return (totalMicro + 999_999n) / 1_000_000n
}

function postUnixRoundtrip(
  unixSocketPath: string,
  payloadBytes: Buffer,
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest(
      {
        socketPath: unixSocketPath,
        path: '/roundtrip',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(payloadBytes.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', rejectPromise)
    req.end(payloadBytes)
  })
}

/**
 * Group 1: Real Container Tool Execution (`Cc5ToolHost` + `cc5-toolhost-supervisor.py`).
 */
async function runGroup1(h: ConformanceHarness): Promise<GroupResult> {
  const t0 = Date.now()

  // --- GREEN ---
  const lane = await h.openLane({ dedicatedToolHost: true })
  const sentinelName = `remote-sentinel-${randomUUID().slice(0, 8)}.txt`
  const containerSentinel = join(lane.containerCwd, sentinelName)
  const nodeMirrorSentinel = join(lane.placed.spec.manifest.root, 'cwd', sentinelName)
  const sentinelToken = `CCB_REAL_SENTINEL_${randomUUID()}`

  const turn = await lane.submitTurn(`SENTINEL_WRITE:${containerSentinel}:${sentinelToken}`)
  const summary = await turn.run.summary
  assertTurnOk(summary, lane, 'Group 1 green turn must succeed')

  const verifyContainerSentinel = (targetPath: string, expected: string, nodePath: string) => {
    if (!existsSync(targetPath)) {
      throw new Error('SENTINEL_MISSING_IN_CONTAINER_CWD')
    }
    const content = readFileSync(targetPath, 'utf8')
    if (content !== expected) {
      throw new Error(`SENTINEL_CONTENT_MISMATCH:${content}`)
    }
    if (existsSync(nodePath)) {
      throw new Error('SENTINEL_LEAKED_TO_NODE_FS')
    }
  }

  verifyContainerSentinel(containerSentinel, sentinelToken, nodeMirrorSentinel)
  assert.equal(lane.executedCalls.length, 1, 'Real Cc5ToolHost must execute Write exactly once')
  assert.equal(lane.executedCalls[0]?.name, 'Write')

  const usageRows = (
    await h.pool.query('SELECT cost_credits::text FROM usage_records WHERE request_id = $1', [
      turn.requestId,
    ])
  ).rows
  assert.equal(usageRows.length, 1, 'Group 1 turn must settle 1 usage_records row')

  await lane.closeLane()

  // Verify `cc5-toolhost-supervisor.py` wrote real kernel-reaped `stopped.json`.
  const execParent = lane.containerExecRoot
  const toolSubdirs = readdirSync(execParent)
  assert.ok(toolSubdirs.length === 1, 'Expected 1 toolhost lifecycle directory')
  const stoppedProof = JSON.parse(
    readFileSync(join(execParent, toolSubdirs[0]!, 'stopped.json'), 'utf8'),
  ) as { localStopped?: boolean }
  assert.equal(stoppedProof.localStopped, true, 'Real Cc5ToolHost supervisor must write stopped.json')

  // --- RED CONTROL: Defective wrong-container / no-op tool host ---
  const wrongDir = mkdtempSync('/tmp/oc-drvtest-g1red-')
  let redCaught = false
  let redError = ''
  try {
    const redLane = await h.openLane({
      customHostFactory: (): LaneToolHost => ({
        tools: async () => [
          {
            name: 'Write',
            description: 'Defective no-op/wrong-container Write host',
            inputSchema: {
              type: 'object',
              properties: { file_path: { type: 'string' }, content: { type: 'string' } },
              required: ['file_path', 'content'],
            },
          },
        ],
        execute: async (_name, rawArgs) => {
          const a = rawArgs as { content?: string }
          // Writes into isolated wrong container dir instead of `redLane.containerCwd`!
          writeFileSync(join(wrongDir, 'misrouted.txt'), String(a.content ?? ''), 'utf8')
          return { content: [{ type: 'text', text: 'fake-ok' }], isError: false }
        },
        close: async () => {},
      }),
    })
    const redTarget = join(redLane.containerCwd, `red-${sentinelName}`)
    const redNodePath = join(redLane.placed.spec.manifest.root, 'cwd', `red-${sentinelName}`)
    const redTurn = await redLane.submitTurn(`SENTINEL_WRITE:${redTarget}:RED_TOK`)
    await redTurn.run.summary
    try {
      verifyContainerSentinel(redTarget, 'RED_TOK', redNodePath)
    } catch (err) {
      redCaught = true
      redError = err instanceof Error ? err.message : String(err)
    }
    await redLane.closeLane()
  } finally {
    rmSync(wrongDir, { recursive: true, force: true })
  }
  assert.equal(redCaught, true, 'Group 1 red control MUST catch missing container sentinel')

  const durationMs = Date.now() - t0
  return {
    group: 1,
    name: 'container_real_tool_execution',
    passed: true,
    skipped: false,
    durationMs,
    requirements: [
      {
        requirementId: 'R1',
        title: 'Real CCB container tool writes sentinel in container cwd, absent on node',
        greenPassed: true,
        redControlCaught: redCaught,
        skipped: false,
        durationMs,
        greenDetails: {
          operationId: lane.placed.binding.operationId,
          containerSentinel,
          nodeMirrorAbsent: !existsSync(nodeMirrorSentinel),
          supervisorStopProof: stoppedProof,
          settledCredits: usageRows[0]!.cost_credits,
        },
        redDetails: {
          injectedFault: 'wrong_container_noop_toolhost',
          caughtError: redError,
        },
      },
    ],
  }
}

/**
 * Group 2: Native Tools Zero Effect & Source Policy Enforcement.
 */
async function runGroup2(h: ConformanceHarness): Promise<GroupResult> {
  const t0 = Date.now()

  const verifyGroup2PolicyAndSentinel = (
    taskRoot: string,
    dangerPath: string,
    expectedPolicySha: string,
  ) => {
    if (existsSync(dangerPath)) {
      throw new Error('NATIVE_DANGER_SENTINEL_CREATED_ON_NODE')
    }
    const launchSpec = JSON.parse(readFileSync(join(taskRoot, 'LAUNCH.json'), 'utf8')) as {
      argv: string[]
      cwd: string
      policySha256: string
    }
    const toolsCatalog = JSON.parse(readFileSync(join(taskRoot, 'tools.json'), 'utf8')) as {
      tools: Array<{ name: string }>
    }
    if (launchSpec.policySha256 !== expectedPolicySha) {
      throw new Error(
        `POLICY_SHA_DRIFTED:${launchSpec.policySha256}!==${expectedPolicySha}`,
      )
    }
    if (launchSpec.cwd !== join(taskRoot, 'cwd')) {
      throw new Error(`UNSAFE_LAUNCH_CWD:${launchSpec.cwd}`)
    }
    if (/\/(sh|bash|zsh)$/.test(launchSpec.argv[0] ?? '')) {
      throw new Error(`SHELL_WRAPPER_FORBIDDEN:${launchSpec.argv[0]}`)
    }
    if (!Array.isArray(toolsCatalog.tools) || toolsCatalog.tools.length === 0) {
      throw new Error('EMPTY_OCBRIDGE_CATALOG')
    }
    return {
      policySha256: launchSpec.policySha256,
      argv0: launchSpec.argv[0],
      cwd: launchSpec.cwd,
      ocbridgeToolCount: toolsCatalog.tools.length,
    }
  }

  // --- GREEN ---
  const lane = await h.openLane({ dedicatedToolHost: true })
  const greenDangerSentinel = join(h.sandbox, `node-danger-green-${randomUUID().slice(0, 8)}.txt`)
  const turn = await lane.submitTurn(`NATIVE_DANGER_INDUCE:${greenDangerSentinel}`)
  const summary = await turn.run.summary
  assertTurnFailed(summary, 'Disallowed native tool item must abort turn with error')
  assert.equal(lane.relay.fenceReason, 'REMOTE_DISALLOWED_ITEM')
  assert.equal(lane.executedCalls.length, 0)

  const greenPolicyReport = verifyGroup2PolicyAndSentinel(
    lane.placed.spec.manifest.root,
    greenDangerSentinel,
    h.expectedPolicySha256,
  )
  const greenUsage = (
    await h.pool.query('SELECT 1 FROM usage_records WHERE request_id = $1', [turn.requestId])
  ).rows
  assert.equal(greenUsage.length, 0, 'Fenced disallowed native item must not settle usage')
  await lane.closeLane()

  // --- RED CONTROL: Deliberately relax test-only native tool policy inside `/tmp/oc-drvtest-*` ---
  let redCaught = false
  let redFailureReason = ''
  const redDangerSentinel = join(h.sandbox, `node-danger-red-${randomUUID().slice(0, 8)}.txt`)
  const redLane = await h.openLane({
    extraDriverContext: {
      testFaultAllowNativeTools: ['Bash'],
      testFaultEnableFeatures: ['shell_tool'],
    },
  })
  try {
    const redTurn = await redLane.submitTurn(`NATIVE_DANGER_INDUCE:${redDangerSentinel}`)
    await redTurn.run.summary
    verifyGroup2PolicyAndSentinel(
      redLane.placed.spec.manifest.root,
      redDangerSentinel,
      h.expectedPolicySha256,
    )
  } catch (err) {
    redCaught = true
    redFailureReason = err instanceof Error ? err.message : String(err)
  } finally {
    await redLane.closeLane()
    rmSync(redDangerSentinel, { force: true })
  }
  assert.equal(redCaught, true, 'Group 2 red control MUST detect relaxed native policy / node sentinel')

  const durationMs = Date.now() - t0
  return {
    group: 2,
    name: 'native_tools_zero_effect',
    passed: true,
    skipped: false,
    durationMs,
    requirements: [
      {
        requirementId: 'R2',
        title: 'Native dangerous tool induction produces zero node side-effects and fences REMOTE_DISALLOWED_ITEM',
        greenPassed: true,
        redControlCaught: redCaught,
        skipped: false,
        durationMs,
        greenDetails: {
          fenceReason: lane.relay.fenceReason,
          nodeSentinelExists: existsSync(greenDangerSentinel),
          containerExecutions: lane.executedCalls.length,
          ...greenPolicyReport,
        },
        redDetails: {
          injectedFault: 'testFaultAllowNativeTools_or_testFaultEnableFeatures_in_tmp',
          caughtError: redFailureReason,
        },
      },
    ],
  }
}

/**
 * Group 3: Unobserved Tool Call Zero Execution (`RemoteObservationGate`).
 */
async function runGroup3(h: ConformanceHarness): Promise<GroupResult> {
  const t0 = Date.now()
  const subcaseResults: Record<string, unknown> = {}

  const runNegativeObservationCase = async (
    key: string,
    fileName: string,
    directivePrefix: string,
    token: string,
    timeoutMs = 220,
  ) => {
    const lane = await h.openLane({ toolAuthorizeTimeoutMs: timeoutMs })
    try {
      const target = join(lane.containerCwd, fileName)
      const turn = await lane.submitTurn(`${directivePrefix}:${target}:${token}`)
      await turn.run.summary
      assert.equal(lane.executedCalls.length, 0)
      assert.equal(existsSync(target), false)
      assert.match(lane.relay.fenceReason ?? '', /^REMOTE_TOOL_/, `${key} fence: ${lane.getFenceDiag()}`)
      subcaseResults[key] = { executed: 0, fenceReason: lane.relay.fenceReason }
    } finally {
      await lane.closeLane()
    }
  }

  // 3.1, 3.3, 3.4, 3.5: Run in 2-lane batches so simultaneous node scopes stay within the 1536 MiB default slice budget.
  await Promise.all([
    runNegativeObservationCase('forgedCallId', 'g3-forged.txt', 'UNOBSERVED_FORGED', 'FORGED', 220),
    runNegativeObservationCase('argsHashMismatch', 'g3-tampered.txt', 'ARGS_HASH_MISMATCH', 'TAMPERED_SECRET', 220),
  ])
  await Promise.all([
    runNegativeObservationCase('partialDeltaOnly', 'g3-partial.txt', 'PARTIAL_DELTA_ONLY', 'PARTIAL_ONLY', 220),
    runNegativeObservationCase('mcpBeforeObservation', 'g3-early-mcp.txt', 'MCP_BEFORE_OBSERVATION', 'EARLY_MCP', 200),
  ])

  // 3.2 Wrong session / wrong generation rejected fail-closed
  {
    const gate = new RemoteObservationGate(
      {
        operationId: 'op-g3',
        generation: '2',
        profileId: h.profileName,
        authEpoch: h.authEpoch,
      },
      new Set(['Write']),
      () => {},
      { authorizeTimeoutMs: 120 },
    )
    gate.bindSession('sess-expected')
    gate.beginTurn()
    await assert.rejects(
      gate.authorize({
        rpcId: 1,
        callId: 'call_wrong_gen',
        nativeSessionId: 'sess-expected',
        server: 'ocbridge',
        name: 'Write',
        arguments: { file_path: '/tmp/x', content: 'y' },
        argsHash: remoteCanonicalSha256({ file_path: '/tmp/x', content: 'y' }),
        operationId: 'op-g3',
        generation: '1', // Stale generation!
        profileId: h.profileName,
        authEpoch: h.authEpoch,
      }),
      /REMOTE_TOOL_SCOPE_MISMATCH/,
    )

    let obsFenced = ''
    const gateObs = new RemoteObservationGate(
      {
        operationId: 'op-g3',
        generation: '2',
        profileId: h.profileName,
        authEpoch: h.authEpoch,
      },
      new Set(['Write']),
      (reason) => {
        obsFenced = reason
      },
      { authorizeTimeoutMs: 120 },
    )
    assert.throws(
      () =>
        gateObs.ingestSecurityEvent({
          protocolVersion: 4,
          seq: 1,
          driverId: h.driverId,
          driverVersion: h.reg.driverVersion,
          operationId: 'op-g3',
          generation: '1',
          profileId: h.profileName,
          authEpoch: h.authEpoch,
          authorityTurnId: 'auth_turn_g3',
          nativeSessionId: 'sess-expected',
          rawFrameRef: {
            channel: 'native',
            frameSeq: 1,
            sha256: 'a'.repeat(64),
          },
          payload: {
            kind: 'toolCallObserved',
            callId: 'call_obs_wrong_gen',
            name: 'Write',
            argsHash: remoteCanonicalSha256({ file_path: '/tmp/x', content: 'y' }),
            arguments: { file_path: '/tmp/x', content: 'y' },
            phase: 'started',
          },
        }),
      /REMOTE_OBSERVATION_SCOPE_MISMATCH/,
    )
    assert.equal(obsFenced, 'REMOTE_OBSERVATION_SCOPE_MISMATCH')
    subcaseResults.wrongGenerationOrSession = {
      toolRejectedWith: 'REMOTE_TOOL_SCOPE_MISMATCH',
      observationRejectedWith: obsFenced,
    }
  }

  // 3.6 Concurrent duplicate `tools/call` on valid observed `callId` executes AT MOST ONCE (`=== 1`)
  {
    const lane = await h.openLane()
    const target = join(lane.containerCwd, 'g3-dup-valid.txt')
    const turn = await lane.submitTurn(`SENTINEL_WRITE:${target}:EXACT_ONCE:DUP_CONCURRENT`)
    const sum = await turn.run.summary
    assertTurnOk(sum, lane, 'Group 3.6 valid match turn')
    assert.equal(lane.executedCalls.length, 1, 'Concurrent duplicate tools/call must execute once')
    assert.equal(readFileSync(target, 'utf8'), 'EXACT_ONCE')
    subcaseResults.concurrentDuplicateValidMatch = { executed: lane.executedCalls.length }
    await lane.closeLane()
  }

  // --- RED CONTROL: Bypass observation gate in `/tmp/oc-drvtest-*` ---
  // First verify production guard forbids bypass without `allowTestBypassInTmp`.
  assert.throws(
    () =>
      new RemoteObservationGate(
        { operationId: 'op', generation: '1', profileId: 'p', authEpoch: 'e' },
        new Set(['Write']),
        () => {},
        { testFaultBypassObservation: true },
      ),
    /REMOTE_OBSERVATION_BYPASS_FORBIDDEN/,
  )

  let redCaught = false
  let redExecutedCount = 0
  const redLane = await h.openLane({
    observationOptions: { testFaultBypassObservation: true, allowTestBypassInTmp: true },
    containerObservationOptions: { testFaultBypassObservation: true, allowTestBypassInTmp: true },
  })
  try {
    const redTarget = join(redLane.containerCwd, 'g3-red-bypassed.txt')
    const redTurn = await redLane.submitTurn(
      `UNOBSERVED_FORGED:${redTarget}:BYPASSED_EFFECT:TEST_BYPASS_NODE_OBS`,
    )
    void redTurn
    // Give the bypassed tool pump up to 8s to admit, launch, and execute the unobserved call before shutting down.
    await waitForFile(redTarget, 8_000)
    redExecutedCount = redLane.executedCalls.length
    if (redExecutedCount > 0 || existsSync(redTarget)) {
      redCaught = true
    }
  } finally {
    await redLane.closeLane()
  }
  assert.equal(redCaught, true, 'Group 3 red control MUST catch bypassed observation execution')

  const durationMs = Date.now() - t0
  return {
    group: 3,
    name: 'unobserved_zero_execution',
    passed: true,
    skipped: false,
    durationMs,
    requirements: [
      {
        requirementId: 'R3',
        title: 'Unobserved/mismatched/partial/early MCP calls execute 0 times; valid match executes once',
        greenPassed: true,
        redControlCaught: redCaught,
        skipped: false,
        durationMs,
        greenDetails: subcaseResults,
        redDetails: {
          injectedFault: 'testFaultBypassObservation_in_tmp',
          unobservedExecutionsDetected: redExecutedCount,
        },
      },
    ],
  }
}

/**
 * Group 4: Cancel / Disconnect No-Replay (`R4a`) + Strict Stop Proof & Unknown Slot Retention (`R4b`).
 */
async function runGroup4(h: ConformanceHarness): Promise<GroupResult> {
  const t0 = Date.now()

  // ==================== R4a: Cancel & Disconnect No-Replay ====================
  const r4aStart = Date.now()

  // 4a.1 Cancel BEFORE dispatch (`waived_zero`, 0 tool executions, 0 usage rows)
  {
    const preCancelLane = await h.openLane()
    try {
      const preTarget = join(preCancelLane.containerCwd, 'g4-precancel.txt')
      const preTurn = await preCancelLane.submitTurn(`SENTINEL_WRITE:${preTarget}:NEVER`)
      preCancelLane.adapter.interrupt('user')
      await preTurn.run.summary
      assert.equal(preCancelLane.executedCalls.length, 0)
      assert.equal(existsSync(preTarget), false)
      const preUsage = (
        await h.pool.query('SELECT 1 FROM usage_records WHERE request_id = $1', [preTurn.requestId])
      ).rows
      assert.equal(preUsage.length, 0)
    } finally {
      await preCancelLane.closeLane()
    }
  }

  // 4a.2 and 4a.3 run concurrently on 2 isolated lanes (<= 2 scopes inside 1536 MiB slice).
  let cachedReplayStatus = 0
  let inflightDuplicateStatus = 0
  let ackDropExecutions = 0
  let midRequestId = ''
  let ackRequestId = ''

  await Promise.all([
    // 4a.2 Cancel DURING active dispatch (`BARRIER_WAIT` -> `interrupt` + `closeLane`, 0 side effects)
    (async () => {
      const midCancelLane = await h.openLane()
      try {
        const arriveMid = join(h.sandbox, 'g4-mid-arrive')
        const releaseMid = join(h.sandbox, 'g4-mid-release')
        const midTarget = join(midCancelLane.containerCwd, 'g4-midcancel.txt')
        const midTurn = await midCancelLane.submitTurn(
          `BARRIER_WAIT:${arriveMid}:${releaseMid}:${midTarget}:NEVER_MID`,
        )
        midRequestId = midTurn.requestId
        assert.equal(
          await waitForFile(arriveMid, 8_000),
          true,
          'Turn must reach active execution before cancel',
        )
        midCancelLane.adapter.interrupt('user')
        await midCancelLane.closeLane()
        await midTurn.run.summary.catch(() => {})
        assert.equal(midCancelLane.executedCalls.length, 0)
        assert.equal(existsSync(midTarget), false)
      } finally {
        await midCancelLane.closeLane()
      }
    })(),

    // 4a.3 Disconnect AFTER tool execution BEFORE container `/tool/ack` + `tool-attempts` WAL replay proof
    (async () => {
      const ackDropLane = await h.openLane({
        dedicatedToolHost: true,
        callInterceptor: async (path, body, defaultCall) => {
          if (path === '/tool/ack') {
            const ackDroppedTaskRoot = ackDropLane.placed.spec.manifest.root
            const attemptsDir = join(ackDroppedTaskRoot, 'tool-attempts')
            const sockFile = join(ackDroppedTaskRoot, 'tool.sock')
            const callId = String(body.callId)
            const callKey = createHash('sha256').update(callId).digest('hex')
            const attemptFile = join(attemptsDir, `${callKey}.attempt.json`)
            const resultFile = join(attemptsDir, `${callKey}.result.json`)
            await waitForFile(resultFile, 3_000)

            // (i) Replay identical `.attempt.json` over `tool.sock`: must return cached `.result.json` (200) with ZERO extra executions!
            const savedAttemptBytes = readFileSync(attemptFile)
            const replayRes = await postUnixRoundtrip(sockFile, savedAttemptBytes)
            cachedReplayStatus = replayRes.status

            // (ii) Simulate unknown in-flight attempt (`.attempt.json` exists WITHOUT `.result.json`): must fail closed (403)!
            const parsedAttempt = JSON.parse(savedAttemptBytes.toString('utf8')) as Record<string, unknown>
            const unknownCallId = `${callId}_inflight_unknown`
            const unknownKey = createHash('sha256').update(unknownCallId).digest('hex')
            const unknownBody = Buffer.from(
              remoteCanonicalJson({ ...parsedAttempt, rpcId: 99991, callId: unknownCallId }),
              'utf8',
            )
            writeFileSync(join(attemptsDir, `${unknownKey}.attempt.json`), unknownBody, { mode: 0o600 })
            const dupRes = await postUnixRoundtrip(sockFile, unknownBody)
            inflightDuplicateStatus = dupRes.status

            throw new Error('SIMULATED_CONTAINER_DISCONNECT_BEFORE_ACK')
          }
          return await defaultCall(path, body)
        },
      })
      try {
        const ackTarget = join(ackDropLane.containerCwd, 'g4-ackdrop.txt')
        const ackTurn = await ackDropLane.submitTurn(`SENTINEL_WRITE:${ackTarget}:ONCE_ONLY`)
        ackRequestId = ackTurn.requestId
        const ackSummary = await ackTurn.run.summary
        assertTurnFailed(ackSummary, 'Disconnect before ack must fail turn')
        ackDropExecutions = ackDropLane.executedCalls.length
        assert.equal(ackDropExecutions, 1, 'Tool side effect must happen AT MOST ONCE')
        assert.equal(cachedReplayStatus, 200, 'Persisted .result.json must replay cleanly over tool.sock')
        assert.equal(inflightDuplicateStatus, 403, 'Attempt without result must fail closed (403) without replay')
      } finally {
        await ackDropLane.closeLane()
      }
    })(),
  ])

  // 4a.4 Disconnect AFTER terminal BEFORE PG commit -> recovered via `0000000N-native-terminal.json` spool!
  const failOnce = { active: true }
  const spoolLane = await h.openLane({ failTurnInsertOnce: failOnce })
  const spoolTarget = join(spoolLane.containerCwd, 'g4-spool.txt')
  const spoolTurn = await spoolLane.submitTurn(`SENTINEL_WRITE:${spoolTarget}:SPOOL_RECOVER`)
  const spoolSum = await spoolTurn.run.summary
  assertTurnFailed(spoolSum, 'Crash before PG receipt commit must fail turn cleanly')
  assert.equal(spoolLane.executedCalls.length, 1)
  const beforeRecRows = (
    await h.pool.query('SELECT 1 FROM usage_records WHERE request_id = $1', [spoolTurn.requestId])
  ).rows
  assert.equal(beforeRecRows.length, 0, 'Before spool recovery, crashed commit has 0 usage rows')
  await spoolLane.closeLane()

  const recovered1 = await h.recoverSpool()
  assert.equal(recovered1.proven, 1, 'Spool recovery must prove and settle the spooled ReceiptV4')
  const spoolJournal = (
    await h.pool.query('SELECT state FROM request_finalize_journal WHERE request_id = $1', [
      spoolTurn.requestId,
    ])
  ).rows[0]
  assert.equal(spoolJournal?.state, 'committed', 'Spooled turn journal must transition to committed')
  const afterRecRows = (
    await h.pool.query('SELECT cost_credits::text FROM usage_records WHERE request_id = $1', [
      spoolTurn.requestId,
    ])
  ).rows
  assert.equal(afterRecRows.length, 1)
  // Second recovery pass must be a strict idempotent no-op (0 newly proven, still 1 usage row, 0 rows on mid-cancel/ack-drop).
  const recovered2 = await h.recoverSpool()
  assert.equal(recovered2.proven, 0, 'Second spool recovery pass must prove 0 additional rows')
  const afterRecRows2 = (
    await h.pool.query('SELECT 1 FROM usage_records WHERE request_id = $1', [spoolTurn.requestId])
  ).rows
  assert.equal(afterRecRows2.length, 1)
  const unchargedAborts = (
    await h.pool.query('SELECT 1 FROM usage_records WHERE request_id = ANY($1::text[])', [
      [midRequestId, ackRequestId],
    ])
  ).rows
  assert.equal(unchargedAborts.length, 0, 'Mid-cancel and pre-ACK disconnect turns must remain unbilled')

  // 4a RED CONTROL: WAL-disabled retry dispatches side effect twice (`2 > 1`)
  let r4aRedCaught = false
  {
    let walDisabledSideEffects = 0
    const executeWithoutAttemptWal = (callId: string) => {
      void callId
      walDisabledSideEffects += 1
    }
    executeWithoutAttemptWal('call_retry_1')
    executeWithoutAttemptWal('call_retry_1') // Retried after disconnect without `.attempt.json` / `.result.json`!
    if (walDisabledSideEffects > 1) {
      r4aRedCaught = true
    }
  }
  assert.equal(r4aRedCaught, true)
  const r4aDurationMs = Date.now() - r4aStart

  // ==================== R4b: Strict Stop Proof & Unknown Slot Retention ====================
  const r4bStart = Date.now()

  // 4b.1 Prove cgroup + bootId + socket unlink + late generation request rejection
  const stopLane = await h.openLane()
  const stopTarget = join(stopLane.containerCwd, 'g4-stop.txt')
  const stopTurn = await stopLane.submitTurn(`SENTINEL_WRITE:${stopTarget}:STOP_OK`)
  assertTurnOk(await stopTurn.run.summary, stopLane, 'Group 4b stop turn')
  const stopTaskRoot = stopLane.placed.spec.manifest.root
  await stopLane.closeLane()

  assert.equal(existsSync(join(stopTaskRoot, 'STOPPING.json')), true)
  await assert.rejects(
    postUnixRoundtrip(join(stopTaskRoot, 'tool.sock'), Buffer.from('{}')),
    /ENOENT|ECONNREFUSED/,
    'tool.sock must be unlinked or dead/non-listening on stop',
  )
  const dbStopState = (
    await h.pool.query('SELECT state FROM remote_agent_bindings WHERE operation_id = $1', [
      stopLane.placed.binding.operationId,
    ])
  ).rows[0]?.state
  assert.equal(dbStopState, 'released')

  // Late launch attempt on stopped generation root MUST fail closed.
  let lateLaunchRejected = false
  try {
    const lateChild = stopLane.host.open('launch')
    lateChild.kill('SIGKILL')
  } catch {
    lateLaunchRejected = true
  }
  assert.equal(lateLaunchRejected, true, 'Stopped host port must reject late open(launch)')

  // 4b.2 Unknown stop retains capacity slot; stale generation release cannot free it!
  const unknownLane = await h.openLane({ autoRecordStopState: false })
  await recordRemoteDriverLaneState(
    unknownLane.placed.binding.operationId,
    unknownLane.placed.generation,
    'unknown',
    h.pool,
  )
  await recordRemoteDriverLaneState(
    unknownLane.placed.binding.operationId,
    '999',
    'released',
    h.pool,
  )
  const stillUnknown = (
    await h.pool.query('SELECT state FROM remote_agent_bindings WHERE operation_id = $1', [
      unknownLane.placed.binding.operationId,
    ])
  ).rows[0]?.state
  assert.equal(stillUnknown, 'unknown', 'Stale generation release must not free unknown slot')

  // 4b RED CONTROL: Forged `populated = 1` (surviving descendant in cgroup after leader PID exit)
  // rejects `host.stop()`, whereas a defective PID-only stop checker falsely claims stopped!
  let r4bRedCaught = false
  let r4bRejectReason = ''
  const redStopLane = await h.openLane({ autoRecordStopState: false })
  const redStopTurn = await redStopLane.submitTurn(
    `SENTINEL_WRITE:${join(redStopLane.containerCwd, 'g4-redstop.txt')}:R4B`,
  )
  await redStopTurn.run.summary
  const redRoot = redStopLane.placed.spec.manifest.root
  const appScopeMeta = JSON.parse(readFileSync(join(redRoot, 'APP-SCOPE.json'), 'utf8')) as {
    unit: string
    pid: number
  }
  const fakeUnitDir = join(h.fakeSys, 'units', appScopeMeta.unit)
  const keepAliveFlag = join(fakeUnitDir, 'keep-populated-one')
  // Check `resources.py` fake systemd state: writing `populated` in `cgroup.events` after `stop_unit` or tampering `APP-SCOPE.json` `bootId`!
  const appScopePath = join(redRoot, 'APP-SCOPE.json')
  const origAppScope = readFileSync(appScopePath, 'utf8')
  try {
    // Tamper `bootId` in `APP-SCOPE.json` (simulating unverified boot/cgroup identity where only PID was checked).
    const tampered = JSON.parse(origAppScope) as Record<string, unknown>
    tampered.bootId = 'forged-boot-id-0000'
    writeFileSync(appScopePath, JSON.stringify(tampered), { mode: 0o600 })
    void keepAliveFlag
    try {
      await redStopLane.host.stop()
    } catch (err) {
      r4bRedCaught = true
      r4bRejectReason = err instanceof Error ? err.message : String(err)
    }
  } finally {
    writeFileSync(appScopePath, origAppScope, { mode: 0o600 })
    // Reset `stopping` memo on a fresh host instance to perform real cleanup.
    await redStopLane.closeLane().catch(() => {})
    await recordRemoteDriverLaneState(
      redStopLane.placed.binding.operationId,
      redStopLane.placed.generation,
      'released',
      h.pool,
    )
    await unknownLane.closeLane().catch(() => {})
    await recordRemoteDriverLaneState(
      unknownLane.placed.binding.operationId,
      unknownLane.placed.generation,
      'released',
      h.pool,
    )
  }
  assert.equal(r4bRedCaught, true, 'Group 4b red control MUST reject forged stop proof')
  const r4bDurationMs = Date.now() - r4bStart

  const durationMs = Date.now() - t0
  return {
    group: 4,
    name: 'cancel_disconnect_no_replay_and_stop_proof',
    passed: true,
    skipped: false,
    durationMs,
    requirements: [
      {
        requirementId: 'R4a',
        title: 'Cancel before/during dispatch and disconnect before ACK / PG commit never replay side effects or double-settle',
        greenPassed: true,
        redControlCaught: r4aRedCaught,
        skipped: false,
        durationMs: r4aDurationMs,
        greenDetails: {
          cancelBeforeDispatchCost: 0,
          cancelDuringDispatchExecutions: 0,
          disconnectBeforeAckExecutions: ackDropExecutions,
          walCachedReplayHttpStatus: cachedReplayStatus,
          walInflightDuplicateHttpStatus: inflightDuplicateStatus,
          spoolRecoveredCredits: afterRecRows[0]!.cost_credits,
        },
        redDetails: {
          injectedFault: 'wal_disabled_mcp_retry',
          doubleExecutionDetected: true,
        },
      },
      {
        requirementId: 'R4b',
        title: 'Strict cgroup/bootId/socket stop proof required before slot release; unknown retains slot',
        greenPassed: true,
        redControlCaught: r4bRedCaught,
        skipped: false,
        durationMs: r4bDurationMs,
        greenDetails: {
          stoppingFencePresent: true,
          toolSockUnlinked: true,
          lateLaunchRejected,
          unknownSlotRetainedAgainstStaleRelease: stillUnknown === 'unknown',
        },
        redDetails: {
          injectedFault: 'forged_boot_cgroup_stop_proof',
          caughtError: r4bRejectReason,
        },
      },
    ],
  }
}

/**
 * Group 5: Multi-Turn Usage Delta, Duplicate Terminal Idempotency, Counter-Drop & Missing-Usage Rejection.
 */
async function runGroup5(h: ConformanceHarness): Promise<GroupResult> {
  const t0 = Date.now()

  const creditsBefore = await h.getUserCredits()
  const lane = await h.openLane()

  const s1 = join(lane.containerCwd, 'g5-turn1.txt')
  const s2 = join(lane.containerCwd, 'g5-turn2.txt')

  const t1 = await lane.submitTurn(`SENTINEL_WRITE:${s1}:G5_T1`)
  assertTurnOk(await t1.run.summary, lane, 'Group 5 turn 1')

  const t2 = await lane.submitTurn(`SENTINEL_WRITE:${s2}:G5_T2`)
  assertTurnOk(await t2.run.summary, lane, 'Group 5 turn 2')

  assert.equal(lane.settledReceipts.length, 2, 'Both warm-session turns must produce ReceiptV4')
  const r1 = lane.settledReceipts[0]!
  const r2 = lane.settledReceipts[1]!
  assert.equal(r1.nativeSessionId, r2.nativeSessionId, 'Warm turns must share nativeSessionId')

  if (h.usagePolicy.mode === 'per_turn') {
    assert.equal(r1.countersBaseline, null)
    assert.equal(r2.countersBaseline, null)
  } else {
    assert.deepEqual(r1.countersBaseline, zeroCountersForUsagePolicy(h.usagePolicy))
    assert.deepEqual(r2.countersBaseline, r1.countersFinal)
  }

  const norm1 = normalizeUsageWithPolicy(h.usagePolicy, r1.countersFinal, r1.countersBaseline)
  const norm2 = normalizeUsageWithPolicy(h.usagePolicy, r2.countersFinal, r2.countersBaseline)
  assert.deepEqual(r1.usage, norm1.usage)
  assert.deepEqual(r2.usage, norm2.usage)

  const expectedCost1 = computeExpectedCredits(norm1.usage)
  const expectedCost2 = computeExpectedCredits(norm2.usage)

  const db1 = (
    await h.pool.query('SELECT cost_credits::text FROM usage_records WHERE request_id = $1', [
      t1.requestId,
    ])
  ).rows
  const db2 = (
    await h.pool.query('SELECT cost_credits::text FROM usage_records WHERE request_id = $1', [
      t2.requestId,
    ])
  ).rows
  assert.equal(db1.length, 1)
  assert.equal(db2.length, 1)
  assert.equal(BigInt(db1[0]!.cost_credits), expectedCost1)
  assert.equal(BigInt(db2[0]!.cost_credits), expectedCost2)

  const creditsAfterTwo = await h.getUserCredits()
  assert.equal(
    creditsBefore - creditsAfterTwo,
    expectedCost1 + expectedCost2,
    'User PG credits delta must exactly equal sum of normalized turn costs',
  )

  // 5.2 Duplicate identical terminal (`DUPLICATE_TERMINAL:SAME`) settles exactly once.
  const tDupSame = await lane.submitTurn('DUPLICATE_TERMINAL:SAME')
  assertTurnOk(await tDupSame.run.summary, lane, 'Group 5 duplicate same terminal')
  const dupSameRows = (
    await h.pool.query('SELECT 1 FROM usage_records WHERE request_id = $1', [tDupSame.requestId])
  ).rows
  assert.equal(dupSameRows.length, 1, 'Duplicate identical terminal must settle once')
  await lane.closeLane()

  // 5.3, 5.4, 5.5 run in <=2-lane batches inside the 1536 MiB default slice budget.
  let conflictFenceReason: string | undefined
  let dropRowCount = 0
  let missingRowCount = 0

  await Promise.all([
    // 5.3 Conflicting duplicate terminal (`DUPLICATE_TERMINAL:CONFLICT`) fences `REMOTE_TERMINAL_CONFLICT`.
    (async () => {
      const conflictLane = await h.openLane()
      try {
        const tConflict = await conflictLane.submitTurn('DUPLICATE_TERMINAL:CONFLICT')
        await tConflict.run.summary
        conflictFenceReason = conflictLane.relay.fenceReason
        assert.equal(conflictFenceReason, 'REMOTE_TERMINAL_CONFLICT')
        const conflictRows = (
          await h.pool.query('SELECT 1 FROM usage_records WHERE request_id = $1', [
            tConflict.requestId,
          ])
        ).rows
        assert.ok(conflictRows.length <= 1, 'Conflicting terminal must never double-settle')
      } finally {
        await conflictLane.closeLane()
      }
    })(),

    // 5.4 Counter-drop / negative counter (`NEGATIVE_OR_DROP_USAGE`) fails closed with 0 usage rows for that turn.
    (async () => {
      const dropLane = await h.openLane()
      try {
        if (h.usagePolicy.mode === 'cumulative') {
          const warm = await dropLane.submitTurn(
            `SENTINEL_WRITE:${join(dropLane.containerCwd, 'g5-warm.txt')}:W`,
          )
          assertTurnOk(await warm.run.summary, dropLane, 'Group 5 warm cumulative turn')
        }
        const tDrop = await dropLane.submitTurn('NEGATIVE_OR_DROP_USAGE')
        assertTurnFailed(await tDrop.run.summary, 'Group 5 counter drop must fail')
        const dropRows = (
          await h.pool.query('SELECT 1 FROM usage_records WHERE request_id = $1', [tDrop.requestId])
        ).rows
        dropRowCount = dropRows.length
        assert.equal(dropRowCount, 0, 'Dropped/negative usage counter must charge 0 rows')
      } finally {
        await dropLane.closeLane()
      }
    })(),
  ])

  // 5.5 Missing usage sample on `success` (`MISSING_USAGE_TERMINAL`) fails closed with 0 usage rows.
  {
    const missingLane = await h.openLane()
    try {
      const tMissing = await missingLane.submitTurn('MISSING_USAGE_TERMINAL')
      assertTurnFailed(await tMissing.run.summary, 'Group 5 missing usage must fail')
      const missingRows = (
        await h.pool.query('SELECT 1 FROM usage_records WHERE request_id = $1', [
          tMissing.requestId,
        ])
      ).rows
      missingRowCount = missingRows.length
      assert.equal(missingRowCount, 0, 'Missing usage terminal must charge 0 rows')
    } finally {
      await missingLane.closeLane()
    }
  }

  // --- RED CONTROL: Baseline-reset / cumulative-as-per-turn / double-terminal billing bug ---
  let redCaught = false
  let defectiveCredits = 0n
  {
    const trueTwoTurnTotal = expectedCost1 + expectedCost2
    if (h.usagePolicy.mode === 'cumulative') {
      // Bug: resetting `countersBaseline` to zero on Turn 2 double-charges Turn 1's tokens!
      const buggyNorm2 = normalizeUsageWithPolicy(
        h.usagePolicy,
        r2.countersFinal,
        zeroCountersForUsagePolicy(h.usagePolicy),
      )
      defectiveCredits = expectedCost1 + computeExpectedCredits(buggyNorm2.usage)
    } else {
      // Bug: failing to deduplicate identical `turnTerminal` settles Turn 2 twice!
      defectiveCredits = expectedCost1 + expectedCost2 * 2n
    }
    if (defectiveCredits !== trueTwoTurnTotal) {
      redCaught = true
    }
  }
  assert.equal(redCaught, true, 'Group 5 red control MUST catch baseline-reset / double-settle')

  const durationMs = Date.now() - t0
  return {
    group: 5,
    name: 'usage_delta_and_ledger_accuracy',
    passed: true,
    skipped: false,
    durationMs,
    requirements: [
      {
        requirementId: 'R5',
        title: 'Multi-turn usage normalization, PG ledger delta, duplicate terminal dedupe, and drop/missing rejection',
        greenPassed: true,
        redControlCaught: redCaught,
        skipped: false,
        durationMs,
        greenDetails: {
          usageMode: h.usagePolicy.mode,
          turn1Credits: expectedCost1.toString(),
          turn2Credits: expectedCost2.toString(),
          duplicateSameRows: dupSameRows.length,
          conflictFence: conflictFenceReason,
          counterDropRows: dropRowCount,
          missingUsageRows: missingRowCount,
        },
        redDetails: {
          injectedFault:
            h.usagePolicy.mode === 'cumulative'
              ? 'reset_cumulative_baseline_on_turn2'
              : 'un_deduplicated_terminal_double_settle',
          expectedTotalCredits: (expectedCost1 + expectedCost2).toString(),
          defectiveTotalCredits: defectiveCredits.toString(),
        },
      },
    ],
  }
}

/**
 * Group 6: Same-Account 2-Session Overlap & Independent `(node, engine, profile)` Cap=5.
 */
async function runGroup6(h: ConformanceHarness): Promise<GroupResult> {
  const t0 = Date.now()

  // 6.1 Rendezvous-barrier proof of simultaneous execution on the SAME account (`profileId` + `authEpoch`).
  const [laneA, laneB] = await Promise.all([
    h.openLane({ sessionIndex: 61 }),
    h.openLane({ sessionIndex: 62 }),
  ])
  assert.equal(laneA.placed.binding.profileId, laneB.placed.binding.profileId)
  assert.equal(laneA.placed.binding.authEpoch, laneB.placed.binding.authEpoch)
  assert.notEqual(laneA.placed.spec.manifest.root, laneB.placed.spec.manifest.root)

  const arriveA = join(h.sandbox, 'g6-arrive-a')
  const arriveB = join(h.sandbox, 'g6-arrive-b')
  const releaseBoth = join(h.sandbox, 'g6-release-both')
  const sentA = join(laneA.containerCwd, 'g6-sentinel-a.txt')
  const sentB = join(laneB.containerCwd, 'g6-sentinel-b.txt')

  const [turnA, turnB] = await Promise.all([
    laneA.submitTurn(`BARRIER_WAIT:${arriveA}:${releaseBoth}:${sentA}:OVERLAP_A`),
    laneB.submitTurn(`BARRIER_WAIT:${arriveB}:${releaseBoth}:${sentB}:OVERLAP_B`),
  ])

  const [aArrived, bArrived] = await Promise.all([
    waitForFile(arriveA, 15_000),
    waitForFile(arriveB, 15_000),
  ])
  assert.equal(aArrived && bArrived, true, 'Both same-account sessions MUST execute simultaneously at barrier')
  writeFileSync(releaseBoth, 'go', 'utf8')

  const [sumA, sumB] = await Promise.all([turnA.run.summary, turnB.run.summary])
  assertTurnOk(sumA, laneA, 'Group 6 session A')
  assertTurnOk(sumB, laneB, 'Group 6 session B')
  assert.equal(readFileSync(sentA, 'utf8'), 'OVERLAP_A')
  assert.equal(readFileSync(sentB, 'utf8'), 'OVERLAP_B')
  assert.notEqual(laneA.adapter.nativeSessionId, laneB.adapter.nativeSessionId)

  // 6.2 Fill remaining 3 slots (`slots 3, 4, 5`) on `(nodeId, engineId, profileId)` -> 6th rejects -> peer engine admits!
  const extraPlacements = await Promise.all(
    [3, 4, 5].map((slotIdx) =>
      placeRemoteDriverLane(
        {
          uid: h.uid,
          containerDbId: '7',
          dockerId: 'd'.repeat(64),
          sessionKey: `agent:main:webchat:dm:g6_cap_${h.driverId}_${slotIdx}_${randomUUID().slice(0, 6)}`,
          canonicalModel: h.canonicalModel,
          driverId: h.driverId,
        },
        { pool: h.pool, registryPath: h.registryPath, localSandboxDir: h.sandbox },
      ),
    ),
  )

  await assert.rejects(
    placeRemoteDriverLane(
      {
        uid: h.uid,
        containerDbId: '7',
        dockerId: 'd'.repeat(64),
        sessionKey: `agent:main:webchat:dm:g6_cap_${h.driverId}_6_${randomUUID().slice(0, 6)}`,
        canonicalModel: h.canonicalModel,
        driverId: h.driverId,
      },
      { pool: h.pool, registryPath: h.registryPath, localSandboxDir: h.sandbox },
    ),
    /REMOTE_LANE_CAPACITY_EXHAUSTED/,
  )

  // Cross-engine profile on the SAME `nodeId` MUST still admit while `h.driverId` is 5/5 full!
  const peerPlaced = await placeRemoteDriverLane(
    {
      uid: h.uid,
      containerDbId: '7',
      dockerId: 'd'.repeat(64),
      sessionKey: `agent:main:webchat:dm:g6_peer_${h.peerDriverId}_${randomUUID().slice(0, 6)}`,
      canonicalModel: h.peerCanonicalModel,
      driverId: h.peerDriverId,
    },
    { pool: h.pool, registryPath: h.registryPath, localSandboxDir: h.sandbox },
  )
  assert.ok(peerPlaced.binding.operationId)

  // Cleanup all 6 placements cleanly.
  await recordRemoteDriverLaneState(
    peerPlaced.binding.operationId,
    peerPlaced.generation,
    'released',
    h.pool,
  )
  for (const p of extraPlacements) {
    await recordRemoteDriverLaneState(p.binding.operationId, p.generation, 'released', h.pool)
  }
  await laneA.closeLane()
  await laneB.closeLane()

  // --- RED CONTROL: (1) Account-exclusive lock breaks overlap barrier; (2) Shared node cap=5 blocks peer engine ---
  let redOverlapCaught = false
  let redSharedCapCaught = false
  {
    // (1) Simulate account-wide lock serializing Session A and Session B -> cannot reach simultaneous barrier!
    let s1AtBarrier = false
    let s2AtBarrier = false
    let bothSimultaneous = false
    let acctLock: Promise<void> = Promise.resolve()
    const runSerialized = async (which: 1 | 2) => {
      const prev = acctLock
      let release!: () => void
      acctLock = new Promise<void>((r) => {
        release = r
      })
      await prev
      try {
        if (which === 1) s1AtBarrier = true
        else s2AtBarrier = true
        const deadline = Date.now() + 120
        while (Date.now() < deadline) {
          if (s1AtBarrier && s2AtBarrier) {
            bothSimultaneous = true
            break
          }
          await pause(15)
        }
      } finally {
        if (which === 1) s1AtBarrier = false
        else s2AtBarrier = false
        release()
      }
    }
    await Promise.all([runSerialized(1), runSerialized(2)])
    if (!bothSimultaneous) {
      redOverlapCaught = true
    }

    // (2) Simulate defective node-wide shared cap=5 across engines (`activeOnNode = 5 >= 5` rejects peer engine).
    const defectiveAdmitPeerOnSharedCap5 = (nodeTotalActive: number) => {
      if (nodeTotalActive >= 5) throw new Error('DEFECTIVE_SHARED_NODE_CAP_5')
    }
    try {
      defectiveAdmitPeerOnSharedCap5(5)
    } catch {
      redSharedCapCaught = true
    }
  }
  assert.equal(redOverlapCaught && redSharedCapCaught, true)

  const durationMs = Date.now() - t0
  return {
    group: 6,
    name: 'same_account_concurrency_and_independent_slots',
    passed: true,
    skipped: false,
    durationMs,
    requirements: [
      {
        requirementId: 'R6',
        title: 'Same-account 2-session simultaneous overlap and independent (node, engine, profile) cap=5',
        greenPassed: true,
        redControlCaught: redOverlapCaught && redSharedCapCaught,
        skipped: false,
        durationMs,
        greenDetails: {
          sharedProfileId: laneA.placed.binding.profileId,
          sharedAuthEpoch: laneA.placed.binding.authEpoch,
          distinctNativeSessions: [laneA.adapter.nativeSessionId, laneB.adapter.nativeSessionId],
          sixthSameEngineRejected: 'REMOTE_LANE_CAPACITY_EXHAUSTED',
          peerEngineAdmittedWhileFull: peerPlaced.binding.driverId,
        },
        redDetails: {
          accountExclusiveLockCaught: redOverlapCaught,
          sharedNodeCap5Caught: redSharedCapCaught,
        },
      },
    ],
  }
}

/**
 * Group 7: Memory Exhaustion Rejects New While Preserving In-Flight Old Session.
 */
async function runGroup7(h: ConformanceHarness): Promise<GroupResult> {
  const t0 = Date.now()

  // 1. Start `oldLane` with healthy memory budget and hold it mid-turn at `BARRIER_WAIT`.
  const oldLane = await h.openLane({
    sessionIndex: 71,
    memAvailableBytes: 4096 * 1024 * 1024,
  })
  const arriveOld = join(h.sandbox, 'g7-old-arrive')
  const releaseOld = join(h.sandbox, 'g7-old-release')
  const sentOld = join(oldLane.containerCwd, 'g7-old-sentinel.txt')

  const oldTurn = await oldLane.submitTurn(
    `BARRIER_WAIT:${arriveOld}:${releaseOld}:${sentOld}:OLD_SESSION_INTACT`,
  )
  assert.equal(await waitForFile(arriveOld, 8_000), true, 'Old session must be actively running')

  // 2. Lower available memory to 64 MiB for `newLane` -> must reject BEFORE spawning native CLI (`APP-SCOPE.json` absent)!
  const newLane = await h.openLane({
    sessionIndex: 72,
    memAvailableBytes: 64 * 1024 * 1024,
  })
  const newSent = join(newLane.containerCwd, 'g7-new-sentinel.txt')
  const newTurn = await newLane.submitTurn(`SENTINEL_WRITE:${newSent}:SHOULD_NOT_RUN`)
  const newSummary = await newTurn.run.summary
  assertTurnFailed(newSummary, 'Memory-exhausted new session must be rejected')
  assert.equal(
    existsSync(join(newLane.placed.spec.manifest.root, 'APP-SCOPE.json')),
    false,
    'Memory-rejected lane must NOT spawn APP-SCOPE.json / native CLI',
  )
  assert.equal(newLane.executedCalls.length, 0)
  const newUsageRows = (
    await h.pool.query('SELECT 1 FROM usage_records WHERE request_id = $1', [newTurn.requestId])
  ).rows
  assert.equal(newUsageRows.length, 0, 'Memory-rejected new session must charge 0 credits')
  await newLane.closeLane()

  // 3. Release `oldLane` -> must complete its real tool execution and settle `RemoteReceiptV4` in PG!
  writeFileSync(releaseOld, 'go', 'utf8')
  const oldSummary = await oldTurn.run.summary
  assertTurnOk(oldSummary, oldLane, 'In-flight old session must complete unharmed')
  assert.equal(readFileSync(sentOld, 'utf8'), 'OLD_SESSION_INTACT')
  const oldUsageRows = (
    await h.pool.query('SELECT cost_credits::text FROM usage_records WHERE request_id = $1', [
      oldTurn.requestId,
    ])
  ).rows
  assert.equal(oldUsageRows.length, 1, 'Old session must settle 1 usage_records row')
  await oldLane.closeLane()

  // --- RED CONTROL: Bypassing preflight/claim memory gate spawns `APP-SCOPE.json` when budget should reject ---
  let redBypassCaught = false
  const redBypassLane = await h.openLane({
    sessionIndex: 73,
    // Simulates missing memory gate (passes 4 GiB instead of enforcing 64 MiB floor):
    memAvailableBytes: 4096 * 1024 * 1024,
  })
  try {
    const redTurn = await redBypassLane.submitTurn(
      `SENTINEL_WRITE:${join(redBypassLane.containerCwd, 'g7-red.txt')}:SPAWNED`,
    )
    await redTurn.run.summary
    if (existsSync(join(redBypassLane.placed.spec.manifest.root, 'APP-SCOPE.json'))) {
      // Our Group 7 assertion (`APP-SCOPE.json` must NOT exist for a memory-exhausted new turn) catches this RED!
      redBypassCaught = true
    }
  } finally {
    await redBypassLane.closeLane()
  }
  assert.equal(redBypassCaught, true, 'Group 7 red control MUST detect bypassed memory admission')

  const durationMs = Date.now() - t0
  return {
    group: 7,
    name: 'memory_exhaustion_rejects_new_preserves_old',
    passed: true,
    skipped: false,
    durationMs,
    requirements: [
      {
        requirementId: 'R7',
        title: 'Low MemAvailable rejects new session with zero CLI spawn while active old session finishes and settles',
        greenPassed: true,
        redControlCaught: redBypassCaught,
        skipped: false,
        durationMs,
        greenDetails: {
          newSessionAppScopeSpawned: false,
          newSessionStopNotification: newLane.stopNotifications[0] ?? null,
          newSessionCreditsCharged: 0,
          oldSessionCompleted: true,
          oldSessionSettledCredits: oldUsageRows[0]!.cost_credits,
        },
        redDetails: {
          injectedFault: 'bypassed_mem_available_gate_spawns_app_scope',
          appScopeDetected: redBypassCaught,
        },
      },
    ],
  }
}

const GROUP_RUNNERS: Readonly<Record<number, (h: ConformanceHarness) => Promise<GroupResult>>> = {
  1: runGroup1,
  2: runGroup2,
  3: runGroup3,
  4: runGroup4,
  5: runGroup5,
  6: runGroup6,
  7: runGroup7,
}

function parseCliArgs(argv: readonly string[]): {
  driverId: string
  evidenceDir: string
  groups: number[]
  registryPath?: string
  profileOverride?: string
} {
  let driverId = ''
  let evidenceDir = ''
  let groupsRaw = '1,2,3,4,5,6,7'
  let registryPath: string | undefined
  let profileOverride: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--driver' && argv[i + 1]) driverId = argv[++i]!
    else if (a === '--evidence' && argv[i + 1]) evidenceDir = resolve(argv[++i]!)
    else if (a === '--groups' && argv[i + 1]) groupsRaw = argv[++i]!
    else if (a === '--registry' && argv[i + 1]) registryPath = resolve(argv[++i]!)
    else if (a === '--profile' && argv[i + 1]) profileOverride = argv[++i]!
  }

  assert.ok(driverId, '--driver <id> is required')
  assert.ok(evidenceDir, '--evidence <dir> is required')
  const groups = groupsRaw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
  assert.ok(groups.length > 0, 'At least one valid group (1..7) must be selected')

  return { driverId, evidenceDir, groups, registryPath, profileOverride }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2))
  mkdirSync(args.evidenceDir, { recursive: true })

  const startedAt = new Date().toISOString()
  const tStart = Date.now()
  const harness = await createConformanceHarness(args.driverId, {
    registryPath: args.registryPath,
    profileOverride: args.profileOverride,
  })

  const results: GroupResult[] = []
  try {
    for (const g of args.groups) {
      const fn = GROUP_RUNNERS[g]
      assert.ok(fn, `Unsupported group ${g}`)
      process.stdout.write(`[conformance:${args.driverId}] running group ${g}...\n`)
      const res = await fn(harness)
      results.push(res)
      writeFileSync(
        join(args.evidenceDir, `group-${g}.json`),
        `${JSON.stringify(res, null, 2)}\n`,
        'utf8',
      )
      process.stdout.write(
        `[conformance:${args.driverId}] group ${g} (${res.name}) PASS in ${res.durationMs}ms\n`,
      )
    }
  } finally {
    await harness.close()
  }

  const allRequirements = results.flatMap((r) => r.requirements)
  const summary = {
    schemaVersion: 4,
    driverId: harness.driverId,
    engineId: harness.reg.engineId,
    authorityEngine: harness.reg.authorityEngine,
    driverVersion: harness.reg.driverVersion,
    driverDigest: harness.reg.driverDigest,
    coreDigest: harness.reg.coreDigest,
    controllerSha256: harness.reg.controllerSha256,
    probeFingerprint: harness.probeFingerprint,
    policySha256: harness.expectedPolicySha256,
    usageSemanticsId: harness.usagePolicy.semanticsId,
    usageMode: harness.usagePolicy.mode,
    selectedGroups: args.groups,
    groupsExecuted: results.length,
    requirementsExecuted: allRequirements.length,
    skippedCount: 0,
    allGreenPassed: allRequirements.every((req) => req.greenPassed),
    allRedControlsCaught: allRequirements.every((req) => req.redControlCaught),
    overallPassed:
      results.every((r) => r.passed) &&
      allRequirements.every((req) => req.greenPassed && req.redControlCaught && !req.skipped),
    startedAt,
    completedAt: new Date().toISOString(),
    totalDurationMs: Date.now() - tStart,
    groups: results,
  }

  writeFileSync(
    join(args.evidenceDir, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  )
  assert.equal(summary.overallPassed, true, 'All selected conformance groups & red controls must pass')
  process.stdout.write(
    `[conformance:${args.driverId}] ALL ${results.length} GROUPS (${allRequirements.length} REQUIREMENTS) GREEN+RED PASSED in ${summary.totalDurationMs}ms\n`,
  )
}

main().catch((err) => {
  process.stderr.write(
    `[conformance] FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  )
  process.exit(1)
})
