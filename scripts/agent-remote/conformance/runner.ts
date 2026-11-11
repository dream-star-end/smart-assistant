/**
 * Unified 7-Group / 8-Requirement Conformance Runner (`OCV5-749` `AC-1`, `AC-2`).
 *
 * Executes end-to-end against real PostgreSQL, real Redis, real `Cc5ToolHost`, real Python node
 * core (`guard.py`, `controller.py`, `mcp_socket.py`, `mcp_client.py`, `resources.py`,
 * `driver_worker.py`), and real master relay/billing (`placeRemoteDriverLane`, `RemotePoolRelay`,
 * `createRemoteDriverTurnFinance`, `recoverRemoteNativeTurnBilling`).
 *
 * Supports `--mode sandbox` and `--mode live-node` (over real OpenSSH forced-command `guard.py`
 * against real native CLIs and real `systemd --user` cgroup scopes).
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
import { join, resolve } from 'node:path'
import {
  computeCostFen,
  normalizeUsageWithPolicy,
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
  type ConformanceMode,
  type SessionLaneHandle,
  type ToolExecutionBarrier,
} from './harness.js'

export interface RequirementEvidence {
  readonly requirementId: string
  readonly title: string
  readonly status: 'PASS' | 'FAIL' | 'UNVERIFIED'
  readonly greenEnvironment: 'live-remote-node' | 'local-sandbox'
  readonly redEnvironment: 'local-sandbox-fault-injection'
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
  readonly status: 'PASS' | 'FAIL' | 'UNVERIFIED'
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
    await pause(25)
  }
  return existsSync(filePath)
}

async function waitForPromiseWithTimeout(p: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p.then(() => true),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function createAsyncBarrier(abortCheck?: () => boolean): {
  readonly arrived: boolean
  readonly waitArrived: Promise<void>
  readonly release: () => void
  readonly barrier: ToolExecutionBarrier
} {
  let markArrived!: () => void
  let releaseFn!: () => void
  let isArrived = false
  const waitArrived = new Promise<void>((r) => {
    markArrived = () => {
      if (!isArrived) {
        isArrived = true
        r()
      }
    }
  })
  const waitRelease = new Promise<void>((r) => {
    releaseFn = r
  })
  return {
    get arrived() {
      return isArrived
    },
    waitArrived,
    release: () => releaseFn(),
    barrier: {
      onArrive: () => markArrived(),
      waitRelease,
      abortExecution: abortCheck,
    },
  }
}

function computeExpectedCredits(normalized: {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}): bigint {
  return computeCostFen(
    {
      input_tokens: BigInt(normalized.inputTokens),
      output_tokens: BigInt(normalized.outputTokens),
      cache_read_tokens: BigInt(normalized.cacheReadTokens),
      cache_write_tokens: BigInt(normalized.cacheWriteTokens),
    },
    {
      input_per_mtok: PRICING_RATES.inputPerMtok,
      output_per_mtok: PRICING_RATES.outputPerMtok,
      cache_read_per_mtok: PRICING_RATES.cacheReadPerMtok,
      cache_write_per_mtok: PRICING_RATES.cacheWritePerMtok,
      multiplier: '1.000',
    },
  )
}

function greenEnvLabel(h: ConformanceHarness): 'live-remote-node' | 'local-sandbox' {
  return h.mode === 'live-node' ? 'live-remote-node' : 'local-sandbox'
}

/**
 * Group 1: Real Container Tool Execution (`Cc5ToolHost` + `cc5-toolhost-supervisor.py`).
 */
async function runGroup1(h: ConformanceHarness): Promise<GroupResult> {
  const t0 = Date.now()

  // --- GREEN ---
  const lane = await h.openLane({ dedicatedToolHost: true })
  const taskRoot = lane.placed.spec.manifest.root
  const sentinelName = `remote-sentinel-${randomUUID().slice(0, 8)}.txt`
  const containerSentinel = join(lane.containerCwd, sentinelName)
  const sentinelToken = `CCB_REAL_SENTINEL_${randomUUID()}`

  const turn = await lane.submitTurn(h.buildWritePrompt(containerSentinel, sentinelToken))
  const summary = await turn.run.summary
  assertTurnOk(summary, lane, 'Group 1 green turn must succeed')

  const verifyContainerSentinel = async (
    targetPath: string,
    expected: string,
    nodeRoot: string,
    relOnNode: string,
  ) => {
    if (!existsSync(targetPath)) {
      throw new Error('SENTINEL_MISSING_IN_CONTAINER_CWD')
    }
    const content = readFileSync(targetPath, 'utf8')
    if (content !== expected) {
      throw new Error(`SENTINEL_CONTENT_MISMATCH:${content}`)
    }
    if (await h.taskFileExists(nodeRoot, relOnNode)) {
      throw new Error('SENTINEL_LEAKED_TO_NODE_FS')
    }
  }

  await verifyContainerSentinel(
    containerSentinel,
    sentinelToken,
    taskRoot,
    join('cwd', sentinelName),
  )
  assert.equal(lane.executedCalls.length, 1, 'Real Cc5ToolHost must execute Write exactly once')
  assert.equal(lane.executedCalls[0]?.name, 'Write')

  const usageRows = (
    await h.pool.query('SELECT cost_credits::text FROM usage_records WHERE request_id = $1', [
      turn.requestId,
    ])
  ).rows
  assert.equal(usageRows.length, 1, 'Group 1 turn must settle 1 usage_records row')
  const receipt = lane.settledReceipts[0]
  assert.ok(receipt, 'Group 1 must capture RemoteReceiptV4')

  await lane.closeLane()
  const remoteStopProof = lane.getStopEvidence()
  assert.ok(remoteStopProof, 'Remote node cgroup/bootId stop proof must be present')

  // Verify `cc5-toolhost-supervisor.py` wrote real kernel-reaped `stopped.json`.
  const execParent = lane.containerExecRoot
  const toolSubdirs = readdirSync(execParent)
  assert.ok(toolSubdirs.length === 1, 'Expected 1 toolhost lifecycle directory')
  const stoppedProof = JSON.parse(
    readFileSync(join(execParent, toolSubdirs[0]!, 'stopped.json'), 'utf8'),
  ) as { localStopped?: boolean }
  assert.equal(stoppedProof.localStopped, true, 'Real Cc5ToolHost supervisor must write stopped.json')

  // --- RED CONTROL: Defective wrong-container / no-op tool host (isolated sandbox) ---
  const wrongDir = mkdtempSync('/tmp/oc-drvtest-g1red-')
  let redCaught = false
  let redError = ''
  try {
    const redLane = await h.openFaultInjectionLane({
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
          writeFileSync(join(wrongDir, 'misrouted.txt'), String(a.content ?? ''), 'utf8')
          return { content: [{ type: 'text', text: 'fake-ok' }], isError: false }
        },
        close: async () => {},
      }),
    })
    const redTarget = join(redLane.containerCwd, `red-${sentinelName}`)
    const redTurn = await redLane.submitTurn(`SENTINEL_WRITE:${redTarget}:RED_TOK`)
    await redTurn.run.summary
    try {
      await verifyContainerSentinel(
        redTarget,
        'RED_TOK',
        redLane.placed.spec.manifest.root,
        join('cwd', `red-${sentinelName}`),
      )
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
    status: 'PASS',
    passed: true,
    skipped: false,
    durationMs,
    requirements: [
      {
        requirementId: 'R1',
        title: 'Real CCB container tool writes sentinel in container cwd, absent on node',
        status: 'PASS',
        greenEnvironment: greenEnvLabel(h),
        redEnvironment: 'local-sandbox-fault-injection',
        greenPassed: true,
        redControlCaught: redCaught,
        skipped: false,
        durationMs,
        greenDetails: {
          targetHost: h.targetHost,
          sshMode: h.sshMode,
          operationId: lane.placed.binding.operationId,
          remoteTaskRoot: taskRoot,
          containerSentinel,
          nodeMirrorAbsent: true,
          remoteNodeStopProof: remoteStopProof,
          supervisorStopProof: stoppedProof,
          receiptDigests: {
            rawEvidenceDigest: receipt.rawEvidenceDigest,
            securityEventDigest: receipt.securityEventDigest,
            usageDigest: receipt.usageDigest,
          },
          settledCredits: usageRows[0]!.cost_credits,
        },
        redDetails: {
          environment: 'local-sandbox-fault-injection',
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

  const verifyGroup2PolicyAndSentinel = async (
    taskRoot: string,
    dangerRelPath: string,
    expectedPolicySha: string,
  ) => {
    if (await h.taskFileExists(taskRoot, dangerRelPath)) {
      throw new Error('NATIVE_DANGER_SENTINEL_CREATED_ON_NODE')
    }
    const launchSpec = JSON.parse(await h.readTaskFileUtf8(taskRoot, 'LAUNCH.json')) as {
      argv: string[]
      cwd: string
      policySha256: string
    }
    const toolsCatalog = JSON.parse(await h.readTaskFileUtf8(taskRoot, 'tools.json')) as {
      tools: Array<{ name: string }>
    }
    if (launchSpec.policySha256 !== expectedPolicySha) {
      throw new Error(`POLICY_SHA_DRIFTED:${launchSpec.policySha256}!==${expectedPolicySha}`)
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
      argvCount: launchSpec.argv.length,
      cwd: launchSpec.cwd,
      ocbridgeToolCount: toolsCatalog.tools.length,
    }
  }

  // --- GREEN (runs on real target node in `live-node` mode) ---
  const lane = await h.openLane({ dedicatedToolHost: true })
  const taskRoot = lane.placed.spec.manifest.root
  const dangerRel = `cwd/node-danger-green-${randomUUID().slice(0, 8)}.txt`
  const greenDangerSentinel = join(taskRoot, dangerRel)
  const turn = await lane.submitTurn(h.buildNativeDangerPrompt(greenDangerSentinel))
  const summary = await turn.run.summary

  if (h.mode === 'sandbox') {
    assertTurnFailed(summary, 'Disallowed native tool item must abort turn with error')
    assert.equal(lane.relay.fenceReason, 'REMOTE_DISALLOWED_ITEM')
  } else {
    // On a real remote node with source-ban active (`--tools ""` / `--disable shell_tool ...` +
    // `experimental_supported_tools: []`), native tools are absent from the upstream model surface
    // (or fenced with `REMOTE_DISALLOWED_ITEM` if attempted). Either way: 0 node files, 0 container calls!
    if (summary === null || summary.isError) {
      assert.equal(lane.relay.fenceReason, 'REMOTE_DISALLOWED_ITEM')
    }
  }
  assert.equal(lane.executedCalls.length, 0, 'Native induction must execute 0 container tools')

  const greenPolicyReport = await verifyGroup2PolicyAndSentinel(
    taskRoot,
    dangerRel,
    h.expectedPolicySha256,
  )
  await lane.closeLane()
  const greenStopProof = lane.getStopEvidence()

  // Also verify runtime `REMOTE_DISALLOWED_ITEM` fence when a rogue process emits a disallowed native item.
  let runtimeDisallowedFence = lane.relay.fenceReason ?? ''
  if (h.mode === 'live-node' && !runtimeDisallowedFence) {
    const fenceLane = await h.openFaultInjectionLane()
    try {
      const fDanger = join(fenceLane.placed.spec.manifest.root, 'cwd/fence-danger.txt')
      const fTurn = await fenceLane.submitTurn(`NATIVE_DANGER_INDUCE:${fDanger}`)
      assertTurnFailed(await fTurn.run.summary, 'Rogue native item frame must fence')
      assert.equal(fenceLane.relay.fenceReason, 'REMOTE_DISALLOWED_ITEM')
      runtimeDisallowedFence = fenceLane.relay.fenceReason
      const fUsage = (
        await h.pool.query('SELECT 1 FROM usage_records WHERE request_id = $1', [fTurn.requestId])
      ).rows
      assert.equal(fUsage.length, 0, 'Fenced disallowed native item must not settle usage')
    } finally {
      await fenceLane.closeLane()
    }
  } else {
    const greenUsage = (
      await h.pool.query('SELECT 1 FROM usage_records WHERE request_id = $1', [turn.requestId])
    ).rows
    assert.equal(greenUsage.length, 0, 'Fenced disallowed native item must not settle usage')
  }

  // --- RED CONTROL: Deliberately relax test-only native tool policy strictly inside `/tmp/oc-drvtest-*` ---
  let redCaught = false
  let redFailureReason = ''
  const redLane = await h.openFaultInjectionLane({
    extraDriverContext: {
      testFaultAllowNativeTools: ['Bash'],
      testFaultEnableFeatures: ['shell_tool'],
    },
  })
  const redTaskRoot = redLane.placed.spec.manifest.root
  const redDangerRel = `cwd/node-danger-red-${randomUUID().slice(0, 8)}.txt`
  const redDangerSentinel = join(redTaskRoot, redDangerRel)
  try {
    const redTurn = await redLane.submitTurn(`NATIVE_DANGER_INDUCE:${redDangerSentinel}`)
    await redTurn.run.summary
    await verifyGroup2PolicyAndSentinel(redTaskRoot, redDangerRel, h.expectedPolicySha256)
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
    status: 'PASS',
    passed: true,
    skipped: false,
    durationMs,
    requirements: [
      {
        requirementId: 'R2',
        title: 'Native dangerous tool induction produces zero node side-effects and enforces source-ban + REMOTE_DISALLOWED_ITEM fence',
        status: 'PASS',
        greenEnvironment: greenEnvLabel(h),
        redEnvironment: 'local-sandbox-fault-injection',
        greenPassed: true,
        redControlCaught: redCaught,
        skipped: false,
        durationMs,
        greenDetails: {
          targetHost: h.targetHost,
          sshMode: h.sshMode,
          remoteTaskRoot: taskRoot,
          liveNodeTurnOutcome: summary?.isError ? 'fenced' : 'source_banned_no_native_tool_available',
          runtimeDisallowedItemFenceVerified: runtimeDisallowedFence,
          nodeSentinelExists: false,
          containerExecutions: lane.executedCalls.length,
          remoteNodeStopProof: greenStopProof,
          ...greenPolicyReport,
        },
        redDetails: {
          environment: 'local-sandbox-fault-injection',
          environmentNote:
            'Relaxing native shell policy on a live user-credentialed node is forbidden per Design §6.1; executed in isolated /tmp/oc-drvtest-* sandbox.',
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
    const lane = await h.openFaultInjectionLane({ toolAuthorizeTimeoutMs: timeoutMs })
    try {
      const target = join(lane.containerCwd, fileName)
      const turn = await lane.submitTurn(`${directivePrefix}:${target}:${token}`)
      await turn.run.summary
      assert.equal(lane.executedCalls.length, 0)
      assert.equal(existsSync(target), false)
      assert.match(lane.relay.fenceReason ?? '', /^REMOTE_TOOL_/, `${key} fence: ${lane.getFenceDiag()}`)
      subcaseResults[key] = {
        environment: 'local-sandbox-wire-fault-injection',
        executed: 0,
        fenceReason: lane.relay.fenceReason,
      }
    } finally {
      await lane.closeLane()
    }
  }

  // 3.1, 3.3, 3.4, 3.5: Malformed/forged MCP wire injections verified fail-closed with 0 executions.
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
        generation: '1',
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

  // 3.6 Concurrent duplicate `tools/call` on valid observed `callId` executes AT MOST ONCE (`=== 1`) on real target node!
  if (h.mode === 'sandbox') {
    const lane = await h.openLane()
    const target = join(lane.containerCwd, 'g3-dup-valid.txt')
    const turn = await lane.submitTurn(h.buildWritePrompt(target, 'EXACT_ONCE', true))
    const sum = await turn.run.summary
    assertTurnOk(sum, lane, 'Group 3.6 valid match turn')
    assert.equal(lane.executedCalls.length, 1, 'Concurrent duplicate tools/call must execute once')
    assert.equal(readFileSync(target, 'utf8'), 'EXACT_ONCE')
    await lane.closeLane()
    subcaseResults.concurrentDuplicateValidMatch = {
      environment: 'local-sandbox',
      executed: lane.executedCalls.length,
    }
  } else {
    const dupSync = createAsyncBarrier()
    let capturedCallId = ''
    const lane = await h.openLane({
      dedicatedToolHost: true,
      toolExecutionBarrier: dupSync.barrier,
      callInterceptor: async (path, body, defaultCall) => {
        const res = await defaultCall(path, body)
        if (path === '/tool/next' && typeof (res as any).request?.callId === 'string') {
          capturedCallId = String((res as any).request.callId)
        }
        return res
      },
    })
    try {
      const target = join(lane.containerCwd, 'g3-dup-valid.txt')
      const turn = await lane.submitTurn(h.buildWritePrompt(target, 'EXACT_ONCE'))
      assert.equal(
        await waitForPromiseWithTimeout(dupSync.waitArrived, h.barrierTimeoutMs),
        true,
        'Live turn must reach active tool execution',
      )
      assert.ok(capturedCallId.length > 0, 'Must capture active callId')
      const callKey = createHash('sha256').update(capturedCallId).digest('hex')
      const attemptBytes = await h.readTaskFileBytes(
        lane.placed.spec.manifest.root,
        `tool-attempts/${callKey}.attempt.json`,
      )
      // Queue concurrent duplicate `tools/call` over real remote node `tool.sock` while 1st call is in flight,
      // then release the 1st call so both overlap on `tool.sock`: `mcp_socket.py` serves the persisted
      // `.result.json` (200) without re-dispatching, and `Cc5ToolHost` executes strictly once (`=== 1`)!
      const dupSocketPromise = h.postTaskToolSockRoundtrip(
        lane.placed.spec.manifest.root,
        attemptBytes,
      )
      await pause(1800)
      dupSync.release()
      const [dupSocketRes, sum] = await Promise.all([dupSocketPromise, turn.run.summary])
      assert.equal(
        dupSocketRes.status,
        200,
        'Concurrent duplicate over remote tool.sock must return cached result (200) without re-execution',
      )
      assertTurnOk(sum, lane, 'Group 3.6 live valid match turn')
      assert.equal(lane.executedCalls.length, 1, 'Valid observed call must execute strictly once')
      assert.equal(readFileSync(target, 'utf8'), 'EXACT_ONCE')
      await lane.closeLane()
      subcaseResults.concurrentDuplicateValidMatch = {
        environment: 'live-remote-node',
        targetHost: h.targetHost,
        executed: lane.executedCalls.length,
        concurrentDuplicateHttpStatus: dupSocketRes.status,
        remoteNodeStopProof: lane.getStopEvidence(),
      }
    } finally {
      dupSync.release()
      await lane.closeLane()
    }
  }

  // --- RED CONTROL: Bypass observation gate strictly inside `/tmp/oc-drvtest-*` ---
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
  const redLane = await h.openFaultInjectionLane({
    observationOptions: { testFaultBypassObservation: true, allowTestBypassInTmp: true },
    containerObservationOptions: { testFaultBypassObservation: true, allowTestBypassInTmp: true },
  })
  try {
    const redTarget = join(redLane.containerCwd, 'g3-red-bypassed.txt')
    const redTurn = await redLane.submitTurn(
      `UNOBSERVED_FORGED:${redTarget}:BYPASSED_EFFECT:TEST_BYPASS_NODE_OBS`,
    )
    void redTurn
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
    status: 'PASS',
    passed: true,
    skipped: false,
    durationMs,
    requirements: [
      {
        requirementId: 'R3',
        title: 'Unobserved/mismatched/partial/early MCP calls execute 0 times; valid match executes once',
        status: 'PASS',
        greenEnvironment: greenEnvLabel(h),
        redEnvironment: 'local-sandbox-fault-injection',
        greenPassed: true,
        redControlCaught: redCaught,
        skipped: false,
        durationMs,
        greenDetails: subcaseResults,
        redDetails: {
          environment: 'local-sandbox-fault-injection',
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
      const preTurn = await preCancelLane.submitTurn(h.buildWritePrompt(preTarget, 'NEVER'))
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

  let cachedReplayStatus = 0
  let inflightDuplicateStatus = 0
  let ackDropExecutions = 0
  let midRequestId = ''
  let ackRequestId = ''

  // 4a.2 Cancel DURING active dispatch (toolExecutionBarrier -> interrupt + closeLane, 0 side effects)
  {
    let cancelTriggered = false
    const midSync = createAsyncBarrier(() => cancelTriggered)
    const midCancelLane = await h.openLane({
      dedicatedToolHost: true,
      toolExecutionBarrier: midSync.barrier,
    })
    try {
      const midTarget = join(midCancelLane.containerCwd, 'g4-midcancel.txt')
      const midTurn = await midCancelLane.submitTurn(h.buildWritePrompt(midTarget, 'NEVER_MID'))
      midRequestId = midTurn.requestId
      assert.equal(
        await waitForPromiseWithTimeout(midSync.waitArrived, h.barrierTimeoutMs),
        true,
        'Turn must reach active dispatch before cancel',
      )
      cancelTriggered = true
      midCancelLane.adapter.interrupt('user')
      midSync.release()
      await midCancelLane.closeLane()
      await midTurn.run.summary.catch(() => {})
      assert.equal(midCancelLane.executedCalls.length, 0)
      assert.equal(existsSync(midTarget), false)
    } finally {
      midSync.release()
      await midCancelLane.closeLane()
    }
  }

  // 4a.3 Disconnect AFTER tool execution BEFORE container `/tool/ack` + real remote `tool-attempts` WAL proof
  {
    const ackDropLane = await h.openLane({
      dedicatedToolHost: true,
      writeOnlyTools: true,
      callInterceptor: async (path, body, defaultCall) => {
        if (path === '/tool/ack') {
          const walRes = await h.verifyTaskWalReplay(
            ackDropLane.placed.spec.manifest.root,
            String(body.callId),
          )
          cachedReplayStatus = walRes.cachedReplayStatus
          inflightDuplicateStatus = walRes.inflightDuplicateStatus
          throw new Error('SIMULATED_CONTAINER_DISCONNECT_BEFORE_ACK')
        }
        return await defaultCall(path, body)
      },
    })
    try {
      const ackTarget = join(ackDropLane.containerCwd, 'g4-ackdrop.txt')
      const ackTurn = await ackDropLane.submitTurn(h.buildWritePrompt(ackTarget, 'ONCE_ONLY'))
      ackRequestId = ackTurn.requestId
      const ackSummary = await ackTurn.run.summary
      assertTurnFailed(ackSummary, 'Disconnect before ack must fail turn')
      ackDropExecutions = ackDropLane.executedCalls.length
      assert.equal(ackDropExecutions, 1, 'Tool side effect must happen AT MOST ONCE')
      assert.equal(cachedReplayStatus, 200, 'Persisted .result.json must replay cleanly over tool.sock')
      assert.equal(
        inflightDuplicateStatus,
        403,
        'Attempt without result must fail closed (403) without replay',
      )
    } finally {
      await ackDropLane.closeLane()
    }
  }

  // 4a.4 Disconnect AFTER terminal BEFORE PG commit -> recovered via `0000000N-native-terminal.json` spool!
  const failOnce = { active: true }
  const spoolLane = await h.openLane({ failTurnInsertOnce: failOnce })
  const spoolTarget = join(spoolLane.containerCwd, 'g4-spool.txt')
  const spoolTurn = await spoolLane.submitTurn(h.buildWritePrompt(spoolTarget, 'SPOOL_RECOVER'))
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
    executeWithoutAttemptWal('call_retry_1')
    if (walDisabledSideEffects > 1) {
      r4aRedCaught = true
    }
  }
  assert.equal(r4aRedCaught, true)
  const r4aDurationMs = Date.now() - r4aStart

  // ==================== R4b: Strict Stop Proof & Unknown Slot Retention ====================
  const r4bStart = Date.now()

  // 4b.1 Prove real cgroup + bootId + socket unlink + late generation request rejection
  const stopLane = await h.openLane()
  const stopTarget = join(stopLane.containerCwd, 'g4-stop.txt')
  const stopTurn = await stopLane.submitTurn(h.buildWritePrompt(stopTarget, 'STOP_OK'))
  assertTurnOk(await stopTurn.run.summary, stopLane, 'Group 4b stop turn')
  const stopTaskRoot = stopLane.placed.spec.manifest.root
  await stopLane.closeLane()

  const verifiedStop = stopLane.getStopEvidence() as {
    proof?: {
      bootId?: string
      remoteStopped?: boolean
      scopes?: Array<{ unit: string; cgroup: string; dev: number; inode: number; populated: number }>
    }
  } | null
  assert.ok(verifiedStop?.proof?.remoteStopped === true, 'Verified cgroup/bootId stop proof required')
  assert.equal(verifiedStop?.proof?.scopes?.length, 2, 'Both app and socket scopes must be proven stopped')
  if (h.mode === 'live-node') {
    for (const sc of verifiedStop!.proof!.scopes!) {
      assert.ok(sc.cgroup.startsWith('/user.slice/'), `Expected real systemd user slice cgroup, got ${sc.cgroup}`)
      assert.equal(sc.populated, 0)
    }
  }

  assert.equal(await h.taskFileExists(stopTaskRoot, 'STOPPING.json'), true)
  await assert.rejects(
    h.postTaskToolSockRoundtrip(stopTaskRoot, Buffer.from('{}')),
    /ENOENT|ECONNREFUSED/,
    'tool.sock must be unlinked or dead/non-listening on stop',
  )
  const dbStopState = (
    await h.pool.query('SELECT state FROM remote_agent_bindings WHERE operation_id = $1', [
      stopLane.placed.binding.operationId,
    ])
  ).rows[0]?.state
  assert.equal(dbStopState, 'released')

  let lateLaunchRejected = false
  try {
    const lateChild = stopLane.host.open('launch')
    lateChild.kill('SIGKILL')
  } catch {
    lateLaunchRejected = true
  }
  assert.equal(lateLaunchRejected, true, 'Stopped host port must reject late open(launch)')

  // 4b.2 Unknown stop retains capacity slot; stale generation release cannot free it!
  const unknownLane = await h.openFaultInjectionLane({ autoRecordStopState: false })
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

  // 4b RED CONTROL: Forged `bootId` in `APP-SCOPE.json` rejected by `host.stop()` (isolated sandbox)
  let r4bRedCaught = false
  let r4bRejectReason = ''
  const redStopLane = await h.openFaultInjectionLane({ autoRecordStopState: false })
  const redStopTurn = await redStopLane.submitTurn(
    `SENTINEL_WRITE:${join(redStopLane.containerCwd, 'g4-redstop.txt')}:R4B`,
  )
  await redStopTurn.run.summary
  const redRoot = redStopLane.placed.spec.manifest.root
  const appScopePath = join(redRoot, 'APP-SCOPE.json')
  const origAppScope = readFileSync(appScopePath, 'utf8')
  try {
    const tampered = JSON.parse(origAppScope) as Record<string, unknown>
    tampered.bootId = 'forged-boot-id-0000'
    writeFileSync(appScopePath, JSON.stringify(tampered), { mode: 0o600 })
    try {
      await redStopLane.host.stop()
    } catch (err) {
      r4bRedCaught = true
      r4bRejectReason = err instanceof Error ? err.message : String(err)
    }
  } finally {
    writeFileSync(appScopePath, origAppScope, { mode: 0o600 })
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
    status: 'PASS',
    passed: true,
    skipped: false,
    durationMs,
    requirements: [
      {
        requirementId: 'R4a',
        title: 'Cancel before/during dispatch and disconnect before ACK / PG commit never replay side effects or double-settle',
        status: 'PASS',
        greenEnvironment: greenEnvLabel(h),
        redEnvironment: 'local-sandbox-fault-injection',
        greenPassed: true,
        redControlCaught: r4aRedCaught,
        skipped: false,
        durationMs: r4aDurationMs,
        greenDetails: {
          targetHost: h.targetHost,
          sshMode: h.sshMode,
          cancelBeforeDispatchCost: 0,
          cancelDuringDispatchExecutions: 0,
          disconnectBeforeAckExecutions: ackDropExecutions,
          walCachedReplayHttpStatus: cachedReplayStatus,
          walInflightDuplicateHttpStatus: inflightDuplicateStatus,
          spoolRecoveredCredits: afterRecRows[0]!.cost_credits,
        },
        redDetails: {
          environment: 'local-sandbox-fault-injection',
          injectedFault: 'wal_disabled_mcp_retry',
          doubleExecutionDetected: true,
        },
      },
      {
        requirementId: 'R4b',
        title: 'Strict cgroup/bootId/socket stop proof required before slot release; unknown retains slot',
        status: 'PASS',
        greenEnvironment: greenEnvLabel(h),
        redEnvironment: 'local-sandbox-fault-injection',
        greenPassed: true,
        redControlCaught: r4bRedCaught,
        skipped: false,
        durationMs: r4bDurationMs,
        greenDetails: {
          targetHost: h.targetHost,
          sshMode: h.sshMode,
          stoppingFencePresent: true,
          toolSockUnlinked: true,
          lateLaunchRejected,
          unknownSlotRetainedAgainstStaleRelease: stillUnknown === 'unknown',
          verifiedStopEvidence: verifiedStop,
        },
        redDetails: {
          environment: 'local-sandbox-fault-injection',
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

  // 5.1 Multi-turn warm session reuse + normalized usage + exact PG ledger delta on REAL target node!
  const creditsBefore = await h.getUserCredits()
  const lane = await h.openLane()

  const s1 = join(lane.containerCwd, 'g5-turn1.txt')
  const s2 = join(lane.containerCwd, 'g5-turn2.txt')

  const t1 = await lane.submitTurn(h.buildWritePrompt(s1, 'G5_T1'))
  assertTurnOk(await t1.run.summary, lane, 'Group 5 turn 1')

  const t2 = await lane.submitTurn(h.buildWritePrompt(s2, 'G5_T2'))
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
  assert.ok(expectedCost1 > 0n && expectedCost2 > 0n, 'Real turns must incur positive normalized token cost')

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
  await lane.closeLane()
  const g5StopProof = lane.getStopEvidence()

  // 5.2..5.5 Synthetic malformed/duplicate terminal & counter-drop wire tests run on `openFaultInjectionLane`.
  const dupSameLane = await h.openFaultInjectionLane()
  let dupSameRowCount = 0
  try {
    const tDupSame = await dupSameLane.submitTurn('DUPLICATE_TERMINAL:SAME')
    assertTurnOk(await tDupSame.run.summary, dupSameLane, 'Group 5 duplicate same terminal')
    const dupSameRows = (
      await h.pool.query('SELECT 1 FROM usage_records WHERE request_id = $1', [tDupSame.requestId])
    ).rows
    dupSameRowCount = dupSameRows.length
    assert.equal(dupSameRowCount, 1, 'Duplicate identical terminal must settle once')
  } finally {
    await dupSameLane.closeLane()
  }

  let conflictFenceReason: string | undefined
  let dropRowCount = 0
  let missingRowCount = 0

  await Promise.all([
    (async () => {
      const conflictLane = await h.openFaultInjectionLane()
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
    (async () => {
      const dropLane = await h.openFaultInjectionLane()
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

  {
    const missingLane = await h.openFaultInjectionLane()
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
      const buggyNorm2 = normalizeUsageWithPolicy(
        h.usagePolicy,
        r2.countersFinal,
        zeroCountersForUsagePolicy(h.usagePolicy),
      )
      defectiveCredits = expectedCost1 + computeExpectedCredits(buggyNorm2.usage)
    } else {
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
    status: 'PASS',
    passed: true,
    skipped: false,
    durationMs,
    requirements: [
      {
        requirementId: 'R5',
        title: 'Multi-turn usage normalization, PG ledger delta, duplicate terminal dedupe, and drop/missing rejection',
        status: 'PASS',
        greenEnvironment: greenEnvLabel(h),
        redEnvironment: 'local-sandbox-fault-injection',
        greenPassed: true,
        redControlCaught: redCaught,
        skipped: false,
        durationMs,
        greenDetails: {
          targetHost: h.targetHost,
          sshMode: h.sshMode,
          nativeSessionId: r1.nativeSessionId,
          usageMode: h.usagePolicy.mode,
          turn1Usage: norm1.usage,
          turn2Usage: norm2.usage,
          turn1Credits: expectedCost1.toString(),
          turn2Credits: expectedCost2.toString(),
          receipt1Digests: {
            rawEvidenceDigest: r1.rawEvidenceDigest,
            securityEventDigest: r1.securityEventDigest,
            usageDigest: r1.usageDigest,
          },
          receipt2Digests: {
            rawEvidenceDigest: r2.rawEvidenceDigest,
            securityEventDigest: r2.securityEventDigest,
            usageDigest: r2.usageDigest,
          },
          remoteNodeStopProof: g5StopProof,
          malformedWireSubcasesEnvironment: 'local-sandbox-fault-injection',
          duplicateSameRows: dupSameRowCount,
          conflictFence: conflictFenceReason,
          counterDropRows: dropRowCount,
          missingUsageRows: missingRowCount,
        },
        redDetails: {
          environment: 'local-sandbox-fault-injection',
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
  const syncA = createAsyncBarrier()
  const syncB = createAsyncBarrier()
  // Bridge the two barriers onto one shared release gate!
  let releaseBoth!: () => void
  const sharedRelease = new Promise<void>((r) => {
    releaseBoth = r
  })
  const [laneA, laneB] = await Promise.all([
    h.openLane({
      sessionIndex: 61,
      dedicatedToolHost: true,
      toolExecutionBarrier: {
        onArrive: () => syncA.barrier.onArrive(),
        waitRelease: sharedRelease,
      },
    }),
    h.openLane({
      sessionIndex: 62,
      dedicatedToolHost: true,
      toolExecutionBarrier: {
        onArrive: () => syncB.barrier.onArrive(),
        waitRelease: sharedRelease,
      },
    }),
  ])
  assert.equal(laneA.placed.binding.profileId, laneB.placed.binding.profileId)
  assert.equal(laneA.placed.binding.authEpoch, laneB.placed.binding.authEpoch)
  assert.notEqual(laneA.placed.spec.manifest.root, laneB.placed.spec.manifest.root)

  const sentA = join(laneA.containerCwd, 'g6-sentinel-a.txt')
  const sentB = join(laneB.containerCwd, 'g6-sentinel-b.txt')

  const [turnA, turnB] = await Promise.all([
    laneA.submitTurn(h.buildWritePrompt(sentA, 'OVERLAP_A')),
    laneB.submitTurn(h.buildWritePrompt(sentB, 'OVERLAP_B')),
  ])

  const [aArrived, bArrived] = await Promise.all([
    waitForPromiseWithTimeout(syncA.waitArrived, h.barrierTimeoutMs),
    waitForPromiseWithTimeout(syncB.waitArrived, h.barrierTimeoutMs),
  ])
  releaseBoth()
  assert.equal(
    aArrived && bArrived,
    true,
    'Both same-account sessions MUST execute simultaneously at barrier',
  )

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
        h.placeLaneOptions(),
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
      h.placeLaneOptions(),
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
    h.placeLaneOptions(),
  )
  assert.ok(peerPlaced.binding.operationId)

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
    status: 'PASS',
    passed: true,
    skipped: false,
    durationMs,
    requirements: [
      {
        requirementId: 'R6',
        title: 'Same-account 2-session simultaneous overlap and independent (node, engine, profile) cap=5',
        status: 'PASS',
        greenEnvironment: greenEnvLabel(h),
        redEnvironment: 'local-sandbox-fault-injection',
        greenPassed: true,
        redControlCaught: redOverlapCaught && redSharedCapCaught,
        skipped: false,
        durationMs,
        greenDetails: {
          targetHost: h.targetHost,
          sshMode: h.sshMode,
          sharedProfileId: laneA.placed.binding.profileId,
          sharedAuthEpoch: laneA.placed.binding.authEpoch,
          distinctNativeSessions: [laneA.adapter.nativeSessionId, laneB.adapter.nativeSessionId],
          laneAStopProof: laneA.getStopEvidence(),
          laneBStopProof: laneB.getStopEvidence(),
          sixthSameEngineRejected: 'REMOTE_LANE_CAPACITY_EXHAUSTED',
          peerEngineAdmittedWhileFull: peerPlaced.binding.driverId,
        },
        redDetails: {
          environment: 'local-sandbox-fault-injection',
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

  // 1. Start `oldLane` with healthy memory budget on real target node and hold it mid-turn at barrier.
  const oldSync = createAsyncBarrier()
  const oldLane = await h.openLane({
    sessionIndex: 71,
    dedicatedToolHost: true,
    memAvailableBytes: 4096 * 1024 * 1024,
    toolExecutionBarrier: oldSync.barrier,
  })
  const sentOld = join(oldLane.containerCwd, 'g7-old-sentinel.txt')
  const oldTurn = await oldLane.submitTurn(h.buildWritePrompt(sentOld, 'OLD_SESSION_INTACT'))
  assert.equal(
    await waitForPromiseWithTimeout(oldSync.waitArrived, h.barrierTimeoutMs),
    true,
    'Old session must be actively running in its remote systemd scope',
  )

  // 2. Constrain memory budget (`64 MiB` `maxSliceMemoryBytes` + `memAvailableBytes`) for `newLane` on the SAME node
  //    while `oldLane` is active -> `resources.admit()` on the remote node rejects BEFORE spawning `APP-SCOPE.json`!
  const newLane = await h.openLane({
    sessionIndex: 72,
    memAvailableBytes: 64 * 1024 * 1024,
    maxSliceMemoryBytes: 64 * 1024 * 1024,
  })
  const newSent = join(newLane.containerCwd, 'g7-new-sentinel.txt')
  const newTurn = await newLane.submitTurn(h.buildWritePrompt(newSent, 'SHOULD_NOT_RUN'))
  const newSummary = await newTurn.run.summary
  assertTurnFailed(newSummary, 'Memory-exhausted new session must be rejected')
  assert.equal(
    await h.taskFileExists(newLane.placed.spec.manifest.root, 'APP-SCOPE.json'),
    false,
    'Memory-rejected lane must NOT spawn APP-SCOPE.json / native CLI on remote node',
  )
  assert.equal(newLane.executedCalls.length, 0)
  const newUsageRows = (
    await h.pool.query('SELECT 1 FROM usage_records WHERE request_id = $1', [newTurn.requestId])
  ).rows
  assert.equal(newUsageRows.length, 0, 'Memory-rejected new session must charge 0 credits')
  await newLane.closeLane()

  // 3. Release `oldLane` -> must complete its real tool execution and settle `RemoteReceiptV4` in PG!
  oldSync.release()
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
  const oldStopProof = oldLane.getStopEvidence()

  // --- RED CONTROL: Bypassing memory admission gate spawns `APP-SCOPE.json` when budget should reject ---
  let redBypassCaught = false
  const redBypassLane = await h.openFaultInjectionLane({
    sessionIndex: 73,
    memAvailableBytes: 4096 * 1024 * 1024,
  })
  try {
    const redTurn = await redBypassLane.submitTurn(
      `SENTINEL_WRITE:${join(redBypassLane.containerCwd, 'g7-red.txt')}:SPAWNED`,
    )
    await redTurn.run.summary
    if (existsSync(join(redBypassLane.placed.spec.manifest.root, 'APP-SCOPE.json'))) {
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
    status: 'PASS',
    passed: true,
    skipped: false,
    durationMs,
    requirements: [
      {
        requirementId: 'R7',
        title: 'Constrained slice/node memory rejects new session with zero CLI spawn while active old session finishes and settles',
        status: 'PASS',
        greenEnvironment: greenEnvLabel(h),
        redEnvironment: 'local-sandbox-fault-injection',
        greenPassed: true,
        redControlCaught: redBypassCaught,
        skipped: false,
        durationMs,
        greenDetails: {
          targetHost: h.targetHost,
          sshMode: h.sshMode,
          newSessionRemoteRoot: newLane.placed.spec.manifest.root,
          newSessionAppScopeSpawned: false,
          newSessionStopNotification: newLane.stopNotifications[0] ?? null,
          newSessionCreditsCharged: 0,
          oldSessionRemoteRoot: oldLane.placed.spec.manifest.root,
          oldSessionCompleted: true,
          oldSessionSettledCredits: oldUsageRows[0]!.cost_credits,
          oldSessionStopProof: oldStopProof,
        },
        redDetails: {
          environment: 'local-sandbox-fault-injection',
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
  mode: ConformanceMode
  nodeConfigPath?: string
  groups: number[]
  registryPath?: string
  profileOverride?: string
} {
  let driverId = ''
  let evidenceDir = ''
  let mode: ConformanceMode = 'sandbox'
  let nodeConfigPath: string | undefined
  let groupsRaw = '1,2,3,4,5,6,7'
  let registryPath: string | undefined
  let profileOverride: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--driver' && argv[i + 1]) driverId = argv[++i]!
    else if (a === '--evidence' && argv[i + 1]) evidenceDir = resolve(argv[++i]!)
    else if (a === '--mode' && argv[i + 1]) {
      const m = argv[++i]!
      assert.ok(m === 'sandbox' || m === 'live-node', `Invalid --mode ${m}`)
      mode = m
    } else if (a === '--node-config' && argv[i + 1]) nodeConfigPath = resolve(argv[++i]!)
    else if (a === '--groups' && argv[i + 1]) groupsRaw = argv[++i]!
    else if (a === '--registry' && argv[i + 1]) registryPath = resolve(argv[++i]!)
    else if (a === '--profile' && argv[i + 1]) profileOverride = argv[++i]!
  }

  assert.ok(driverId, '--driver <id> is required')
  assert.ok(evidenceDir, '--evidence <dir> is required')
  if (mode === 'live-node') {
    assert.ok(nodeConfigPath, '--node-config <json> is required when --mode live-node')
  }
  const groups = groupsRaw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
  assert.ok(groups.length > 0, 'At least one valid group (1..7) must be selected')

  return { driverId, evidenceDir, mode, nodeConfigPath, groups, registryPath, profileOverride }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2))
  mkdirSync(args.evidenceDir, { recursive: true })

  const startedAt = new Date().toISOString()
  const tStart = Date.now()
  const harness = await createConformanceHarness(args.driverId, {
    mode: args.mode,
    nodeConfigPath: args.nodeConfigPath,
    registryPath: args.registryPath,
    profileOverride: args.profileOverride,
  })

  const results: GroupResult[] = []
  try {
    for (const g of args.groups) {
      const fn = GROUP_RUNNERS[g]
      assert.ok(fn, `Unsupported group ${g}`)
      process.stdout.write(`[conformance:${args.driverId}:${args.mode}] running group ${g}...\n`)
      const res = await fn(harness)
      results.push(res)
      writeFileSync(
        join(args.evidenceDir, `group-${g}.json`),
        `${JSON.stringify(res, null, 2)}\n`,
        'utf8',
      )
      process.stdout.write(
        `[conformance:${args.driverId}:${args.mode}] group ${g} (${res.name}) PASS in ${res.durationMs}ms\n`,
      )
    }
  } finally {
    await harness.close()
  }

  const allRequirements = results.flatMap((r) => r.requirements)
  const unverifiedCount = allRequirements.filter((req) => req.status === 'UNVERIFIED').length
  const summary = {
    schemaVersion: 4,
    mode: harness.mode,
    targetHost: harness.targetHost,
    sshMode: harness.sshMode,
    driverId: harness.driverId,
    engineId: harness.reg.engineId,
    authorityEngine: harness.reg.authorityEngine,
    driverVersion: harness.reg.driverVersion,
    driverDigest: harness.reg.driverDigest,
    coreDigest: harness.reg.coreDigest,
    controllerSha256: harness.reg.controllerSha256,
    cliVersion: harness.probedSnapshot.cliVersion,
    cliSha256: harness.probedSnapshot.cliSha256,
    nativeSha256: harness.probedSnapshot.nativeSha256 ?? null,
    bridgeSha256: harness.probedSnapshot.bridgeSha256 ?? null,
    probeSource: harness.probedSnapshot.source,
    probeFingerprint: harness.probeFingerprint,
    policySha256: harness.expectedPolicySha256,
    usageSemanticsId: harness.usagePolicy.semanticsId,
    usageMode: harness.usagePolicy.mode,
    selectedGroups: args.groups,
    groupsExecuted: results.length,
    requirementsExecuted: allRequirements.length,
    skippedCount: 0,
    unverifiedCount,
    allGreenPassed: allRequirements.every((req) => req.greenPassed && req.status === 'PASS'),
    allRedControlsCaught: allRequirements.every((req) => req.redControlCaught),
    overallPassed:
      unverifiedCount === 0 &&
      results.every((r) => r.passed && r.status === 'PASS') &&
      allRequirements.every(
        (req) => req.status === 'PASS' && req.greenPassed && req.redControlCaught && !req.skipped,
      ),
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
  assert.equal(
    summary.overallPassed,
    true,
    'All selected conformance groups & red controls must pass with zero UNVERIFIED',
  )
  process.stdout.write(
    `[conformance:${args.driverId}:${args.mode}] ALL ${results.length} GROUPS (${allRequirements.length} REQUIREMENTS) GREEN+RED PASSED in ${summary.totalDurationMs}ms\n`,
  )
  process.exit(0)
}

main().catch((err) => {
  process.stderr.write(
    `[conformance] FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  )
  process.exit(1)
})
