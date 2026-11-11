#!/usr/bin/env -S npx tsx
/**
 * `OCV5-749` `AC-4` + `AC-5` Verification & Live Cutover / Generation / Recovery Rehearsal.
 *
 * Produces structured machine-verifiable evidence JSON (`--output <path>`) covering:
 * 1. `AC-4` Core Scheduling Overhead Gate:
 *    - 50-turn `DriverWorkerClient` (`encode` + `decode`) + `RemoteObservationGate` (`ingestSecurityEvent`
 *      + `authorize`) + `normalizeUsageWithPolicy` + `remoteCanonicalSha256` per-turn scheduling overhead
 *      for both `cc` and `codex`, asserting `p95 <= 50 ms` (without external LLM network variance).
 * 2. `AC-4` Live-Node Parity Cross-Check (`--cc-conformance`, `--codex-conformance`):
 *    - Verifies live-node conformance summaries & group evidence (`mode === 'live-node'`, real host,
 *      first-token/full-content presentation, real `Cc5ToolHost` container Write, Turn 1 -> Turn 2 resume,
 *      cgroup/boot stop proof, exact fee settlement, zero skipped, zero `UNVERIFIED`).
 * 3. `AC-4` 746 Legacy Baseline Regression Gate (`--run-legacy-baseline`):
 *    - Executes legacy Python `cc5`/`codex` scripts, Gateway `cc5*`/`codexRemote*` suites, and Commercial
 *      `remoteNativeTurnBilling.test.ts` + `codexRemoteMaster.integ.test.ts`, asserting exit code `0`.
 * 4. `AC-5` Three-Part Live Cutover / Generation / Crash-Recovery Rehearsal:
 *    - Rehearsal 1: In-flight turn on `g1` triggers `RemoteReleaseDrainCoordinator.drainForCutover()`:
 *      verifies non-destructive timeout (`REMOTE_RELEASE_DRAIN_TIMEOUT` reopens without killing `g1`),
 *      active drain rejects new session admission (`REMOTE_POOL_DRAINING_RETRY_LATER`, recording exact
 *      maintenance-window rejection duration), and waits until `g1` tool execution + ACK + terminal
 *      receipt + PG `request_finalize_journal` settle cleanly (`inflightTurnsKilled === 0`).
 *    - Rehearsal 2: R1 sticky session generation upgrade (`g1` released -> `g2` placed with `generation === '2'`,
 *      preserving `operationId` & `nativeSessionId`, Turn 2 settles, stale `g1` state update fenced).
 *    - Rehearsal 3: Crash/disconnect spool recovery (`failTurnInsertOnce` after spool write ->
 *      `recoverRemoteNativeTurnBilling` dual-reading v3 + v4 journals/spools with zero replay and
 *      idempotent second pass).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import {
  normalizeUsageWithPolicy,
  remoteCanonicalSha256,
  zeroCountersForUsagePolicy,
} from '@openclaude/protocol'
import {
  DriverWorkerClient,
  RemoteObservationGate,
} from '../../packages/gateway/src/remotePool/index.js'
import {
  RemoteReleaseDrainCoordinator,
  claimDriverVerificationRun,
  completeDriverVerificationRun,
  placeRemoteDriverLane,
  recordDriverProbeSnapshot,
  recordRemoteDriverLaneState,
} from '../../packages/commercial/src/account-pool/remotePool/index.js'
import { createConformanceHarness } from './conformance/harness.js'

function createAsyncBarrier(): {
  barrier: {
    onArrive: () => void
    waitRelease: Promise<void>
  }
  waitArrived: Promise<void>
  release: () => void
} {
  let resolveArrived!: () => void
  let resolveRelease!: () => void
  const waitArrived = new Promise<void>((r) => {
    resolveArrived = r
  })
  const waitRelease = new Promise<void>((r) => {
    resolveRelease = r
  })
  return {
    barrier: {
      onArrive: () => resolveArrived(),
      waitRelease,
    },
    waitArrived,
    release: () => resolveRelease(),
  }
}

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(THIS_DIR, '../..')

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Number(sorted[idx].toFixed(3))
}

async function measureDriverSchedulingOverhead(driverId: 'cc' | 'codex', iterations = 50) {
  const worker = new DriverWorkerClient()
  try {
    const info = await worker.info(driverId)
    const samplesMs: number[] = []
    // Warm up Python IPC worker + V8 JIT + Ajv schema validator for 5 full turns before sampling
    const warmupTurns = 5
    for (let step = -warmupTurns; step < iterations; step++) {
      const i = step < 0 ? 10_000 + Math.abs(step) : step
      const opId = randomUUID()
      const callId = `call_bench_${driverId}_${i}`
      const sessId = randomUUID()
      const turnId = `turn_${i}`
      const toolArgs = { file_path: `/tmp/bench-${i}.txt`, content: `hello-${i}` }
      const argsHash = remoteCanonicalSha256(toolArgs)
      const scope = {
        operationId: opId,
        generation: '1',
        profileId: 'bench-profile',
        authEpoch: 'epoch-1',
      }
      const gate = new RemoteObservationGate(scope, new Set(['Write']), () => {})
      gate.bindSession(sessId)

      const nativeToolFrame =
        driverId === 'cc'
          ? JSON.stringify({
              type: 'assistant',
              session_id: sessId,
              message: {
                id: `msg_${i}`,
                content: [
                  { type: 'text', text: 'bench' },
                  {
                    type: 'tool_use',
                    id: callId,
                    name: 'mcp__ocbridge__Write',
                    input: toolArgs,
                  },
                ],
              },
            })
          : JSON.stringify({
              method: 'item/started',
              params: {
                threadId: sessId,
                turnId,
                item: {
                  type: 'mcpToolCall',
                  id: callId,
                  server: 'ocbridge',
                  tool: 'Write',
                  status: 'inProgress',
                  arguments: toolArgs,
                },
              },
            })

      const mcpFrame = JSON.stringify({
        jsonrpc: '2.0',
        id: i + 1,
        method: 'tools/call',
        params: {
          name: 'Write',
          arguments: toolArgs,
          _meta:
            driverId === 'cc'
              ? { 'claudecode/toolUseId': callId }
              : {
                  callId,
                  threadId: sessId,
                  'x-codex-turn-metadata': { turn_id: turnId },
                },
        },
      })

      const terminalFrame =
        driverId === 'cc'
          ? JSON.stringify({
              type: 'result',
              subtype: 'success',
              is_error: false,
              uuid: `res_uuid_${i}`,
              session_id: sessId,
              result: 'DONE',
              usage: {
                input_tokens: 120,
                output_tokens: 30,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            })
          : JSON.stringify({
              method: 'turn/completed',
              params: {
                threadId: sessId,
                turn: { id: turnId, status: 'completed' },
              },
            })

      const t0 = performance.now()
      gate.beginTurn()
      const enc = await worker.encode(
        driverId,
        driverId === 'codex'
          ? { kind: 'newTurn', commandId: `cmd_${i}`, prompt: 'bench', model: 'gpt-6-luna' }
          : { kind: 'newTurn', commandId: `cmd_${i}`, prompt: 'bench' },
        driverId === 'codex'
          ? { initialized: true, sessionId: sessId, expectedModel: 'gpt-6-luna' }
          : { initialized: true, sessionId: sessId },
      )
      const stateAfterTurnStart =
        driverId === 'codex'
          ? { ...enc.nextNativeState, activeTurnId: turnId }
          : enc.nextNativeState
      const dec1 = await worker.decode(driverId, {
        channel: 'native',
        frameSeq: 1,
        rawBytes: nativeToolFrame,
        nativeState: stateAfterTurnStart,
        envelope: {
          ...scope,
          authorityTurnId: `auth_${i}`,
          nativeSessionId: sessId,
          ...(driverId === 'codex' ? { nativeTurnId: turnId } : {}),
        },
        eventSeqStart: 1,
      })
      let seq = 1
      for (const ev of dec1.securityEvents) {
        gate.ingestSecurityEvent(ev)
        seq = ev.seq + 1
      }
      const decMcp = await worker.decode(driverId, {
        channel: 'fixed_mcp',
        frameSeq: 2,
        rawBytes: mcpFrame,
        nativeState: dec1.nextNativeState,
        envelope: {
          ...scope,
          authorityTurnId: `auth_${i}`,
          nativeSessionId: sessId,
          ...(driverId === 'codex' ? { nativeTurnId: turnId } : {}),
        },
        eventSeqStart: seq,
      })
      assert.ok(decMcp.pendingToolRequest, `Expected pendingToolRequest for ${driverId}`)
      const authorized = await gate.authorize({
        ...decMcp.pendingToolRequest,
        ...scope,
      })
      assert.equal(authorized.argsHash, argsHash)
      const decTerm = await worker.decode(driverId, {
        channel: 'native',
        frameSeq: 3,
        rawBytes: terminalFrame,
        nativeState: decMcp.nextNativeState,
        envelope: {
          ...scope,
          authorityTurnId: `auth_${i}`,
          nativeSessionId: sessId,
          ...(driverId === 'codex' ? { nativeTurnId: turnId } : {}),
        },
        eventSeqStart: seq,
      })
      for (const ev of decTerm.securityEvents) {
        gate.ingestSecurityEvent(ev)
      }
      if (driverId === 'cc') {
        normalizeUsageWithPolicy(
          info.usagePolicy,
          {
            input_tokens: 150,
            output_tokens: 35,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 0,
          },
          null,
        )
      } else {
        const zero = zeroCountersForUsagePolicy(info.usagePolicy)
        normalizeUsageWithPolicy(
          info.usagePolicy,
          {
            inputTokens: 150,
            outputTokens: 35,
            cachedInputTokens: 20,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 5,
          },
          zero,
        )
      }
      gate.endTurn()
      const elapsed = performance.now() - t0
      if (step >= 0) {
        samplesMs.push(elapsed)
      }
    }

    const sorted = [...samplesMs].sort((a, b) => a - b)
    const mean = Number((sorted.reduce((acc, v) => acc + v, 0) / sorted.length).toFixed(3))
    const stats = {
      driverId,
      iterations,
      minMs: Number(sorted[0].toFixed(3)),
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
      meanMs: mean,
      budgetP95Ms: 50,
      withinBudget: percentile(sorted, 95) <= 50,
    }
    assert.ok(
      stats.withinBudget,
      `AC-4 scheduling overhead p95=${stats.p95Ms}ms exceeded 50ms budget for ${driverId}`,
    )
    return stats
  } finally {
    await worker.close()
  }
}

function runLegacyBaselineSuites() {
  const suites = [
    {
      name: 'python-legacy-cc5-codex-core',
      cmd: [
        'set -e',
        'if [ "$(id -u)" = "0" ]; then',
        '  STAGE=$(mktemp -d /tmp/oc-legacy-py-XXXXXX)',
        '  trap "rm -rf \\"$STAGE\\"" EXIT',
        '  chmod 0755 "$STAGE"',
        '  mkdir -p "$STAGE/scripts" "$STAGE/packages/gateway"',
        '  cp -a scripts/agent-remote "$STAGE/scripts/agent-remote"',
        '  cp -a packages/gateway/box-bridge-mod "$STAGE/packages/gateway/box-bridge-mod"',
        '  chown -R ocheal:ocheal "$STAGE"',
        '  cd "$STAGE"',
        '  for f in test-cc5-fixed-mcp.py test-cc5-host-controller.py test-cc5-mcp-socket.py test-cc5-ssh-guard.py test-codex-node.py test-codex-probe.py test-remote-engine-resources.py; do',
        '    runuser -u ocheal -- env HOME=/home/ocheal TMPDIR=/tmp python3 -I -B "$STAGE/scripts/agent-remote/$f"',
        '  done',
        '  TMPDIR=/tmp python3 -I -B "$STAGE/scripts/agent-remote/test-codex-install-transaction.py"',
        'else',
        '  for f in test-cc5-fixed-mcp.py test-cc5-host-controller.py test-cc5-mcp-socket.py test-cc5-ssh-guard.py test-codex-node.py test-codex-probe.py test-remote-engine-resources.py; do',
        '    TMPDIR=/tmp python3 -I -B "scripts/agent-remote/$f"',
        '  done',
        'fi',
      ].join('\n'),
    },
    {
      name: 'gateway-legacy-cc5-codexRemote',
      cmd: [
        'set -e',
        'GW_FILES="packages/gateway/src/__tests__/cc5NativeTool.test.ts packages/gateway/src/__tests__/cc5Relay.test.ts packages/gateway/src/__tests__/cc5Bridge.test.ts packages/gateway/src/__tests__/cc5SshHost.test.ts packages/gateway/src/__tests__/cc5ToolObservation.test.ts packages/gateway/src/__tests__/cc5FixedTool.test.ts packages/gateway/src/__tests__/cc5NativeUsage.test.ts packages/gateway/src/__tests__/codexRemoteRelay.test.ts packages/gateway/src/__tests__/codexRemoteAdapterE2E.test.ts packages/gateway/src/__tests__/codexRemoteSessionRestore.test.ts packages/gateway/src/__tests__/v3CodexRelay.test.ts"',
        'CONT_CWD="${PWD/#\\/var\\/lib\\/docker\\/volumes\\/oc-v5-data-u3\\/_data/\\/home\\/agent\\/.openclaude}"',
        'if [ "$(id -u)" = "0" ] && command -v docker >/dev/null 2>&1 && docker inspect -f "{{.State.Running}}" oc-v5-u3 2>/dev/null | grep -qx true && [ "$CONT_CWD" != "$PWD" ]; then',
        '  docker exec oc-v5-u3 env -u OPENCLAUDE_USER_ID -u OPENCLAUDE_CONTAINER_TOKEN -u OPENCLAUDE_AGENT_ID -u OC_AGENT_ID -u OPENCLAUDE_SESSION_KEY bash -lc "cd \\"$CONT_CWD\\" && npx tsx --test --test-concurrency=1 $GW_FILES"',
        'else',
        '  env -u OPENCLAUDE_USER_ID -u OPENCLAUDE_CONTAINER_TOKEN -u OPENCLAUDE_AGENT_ID -u OC_AGENT_ID -u OPENCLAUDE_SESSION_KEY npx tsx --test --test-concurrency=1 $GW_FILES',
        'fi',
      ].join('\n'),
    },
    {
      name: 'commercial-legacy-remote-unit-and-integ',
      cmd: 'npx tsx --import ./scripts/lib/test-blocking-stdio.mjs --test --test-force-exit --test-concurrency=1 packages/commercial/src/__tests__/remoteNativeTurnBilling.test.ts packages/commercial/src/__tests__/codexRemoteProfile.test.ts packages/commercial/src/__tests__/remoteCodexAuth.test.ts packages/commercial/src/__tests__/remoteBrainPoolTarget.test.ts && npx tsx --import ./scripts/lib/test-blocking-stdio.mjs --test --test-force-exit --test-concurrency=1 --test-timeout=180000 packages/commercial/src/__tests__/codexRemoteMaster.integ.test.ts',
    },
  ]

  return suites.map((s) => {
    const t0 = performance.now()
    const res = spawnSync('/bin/bash', ['-lc', s.cmd], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TEST_DATABASE_URL:
          process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test',
        TEST_REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:56379',
        REQUIRE_TEST_DB: '1',
      },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
    const durationMs = Math.round(performance.now() - t0)
    if (res.status !== 0) {
      throw new Error(
        `Legacy baseline suite '${s.name}' failed (exit=${res.status}):\n${res.stdout.slice(-1500)}\n${res.stderr.slice(-1500)}`,
      )
    }
    return {
      suite: s.name,
      exitCode: res.status,
      durationMs,
      passed: true,
    }
  })
}

function verifyLiveConformanceEvidence(dirPath: string, expectedDriver: 'cc' | 'codex') {
  const summaryPath = join(dirPath, 'summary.json')
  assert.ok(existsSync(summaryPath), `Missing live conformance summary at ${summaryPath}`)
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
  assert.equal(summary.driverId, expectedDriver)
  assert.equal(summary.mode, 'live-node', `${expectedDriver} conformance must be live-node`)
  assert.equal(summary.overallPassed, true, `${expectedDriver} overallPassed must be true`)
  assert.equal(summary.skippedCount, 0, `${expectedDriver} skippedCount must be 0`)
  assert.equal(summary.unverifiedCount, 0, `${expectedDriver} unverifiedCount must be 0`)

  const g1 = JSON.parse(readFileSync(join(dirPath, 'group-1.json'), 'utf8'))
  const g4 = JSON.parse(readFileSync(join(dirPath, 'group-4.json'), 'utf8'))
  const g5 = JSON.parse(readFileSync(join(dirPath, 'group-5.json'), 'utf8'))

  return {
    driverId: expectedDriver,
    mode: summary.mode,
    targetHost: summary.targetHost,
    sshMode: summary.sshMode,
    probeFingerprint: summary.probeFingerprint,
    coreDigest: summary.coreDigest,
    driverDigest: summary.driverDigest,
    suiteDigest: summary.suiteDigest,
    group1ContainerToolVerified: g1.requirements?.[0]?.greenPassed === true,
    group4StopProofVerified:
      g4.requirements?.every(
        (r: any) => r.greenPassed === true && r.redControlCaught === true,
      ) === true,
    group4StopEvidenceSample:
      g4.requirements?.[1]?.greenDetails?.verifiedStopEvidence ??
      g4.requirements?.[1]?.greenDetails?.stopProof ??
      null,
    group5MultiTurnResumeAndFeeVerified: g5.requirements?.[0]?.greenPassed === true,
    group5TurnSettlementSample: g5.requirements?.[0]?.greenDetails ?? null,
  }
}

async function runAc5Rehearsals() {
  const h = await createConformanceHarness('codex', { mode: 'sandbox' })
  try {
    // Enable persistent per-thread rollout state in sandbox `CODEX_HOME` so g1 -> g2
    // OS-process generation upgrade resumes exact cumulative counters & turn_seq.
    const origCliFile = join(h.sandbox, 'codex-conformance-cli')
    const statefulCliFile = join(h.sandbox, 'codex-stateful-cli')
    const origCli = readFileSync(origCliFile, 'utf8')
    const statefulCli = origCli
      .replace(
        `    elif method in ("thread/start", "thread/resume"):
        if method == "thread/resume" and msg.get("params", {}).get("threadId"):
            thread_id = msg["params"]["threadId"]`,
        `    elif method in ("thread/start", "thread/resume"):
        if method == "thread/resume" and msg.get("params", {}).get("threadId"):
            thread_id = msg["params"]["threadId"]
            st_file = pathlib.Path(os.environ.get("CODEX_HOME", "/tmp")) / f"rollout-{thread_id}.json"
            if st_file.exists():
                st = json.loads(st_file.read_text(encoding="utf-8"))
                turn_seq = st["turn_seq"]
                cum_in = st["cum_in"]
                cum_cached = st["cum_cached"]
                cum_out = st["cum_out"]
                cum_reason = st["cum_reason"]`,
      )
      .replace(
        `        cum_in += 1000000
        cum_cached += 400000
        cum_out += 250000
        cum_reason += 100000`,
        `        cum_in += 1000000
        cum_cached += 400000
        cum_out += 250000
        cum_reason += 100000
        st_file = pathlib.Path(os.environ.get("CODEX_HOME", "/tmp")) / f"rollout-{thread_id}.json"
        st_file.write_text(json.dumps({"turn_seq": turn_seq, "cum_in": cum_in, "cum_cached": cum_cached, "cum_out": cum_out, "cum_reason": cum_reason}), encoding="utf-8")`,
      )
    assert.notEqual(statefulCli, origCli, 'Expected stateful rollout patch in codex sandbox CLI')
    writeFileSync(statefulCliFile, statefulCli, { mode: 0o500 })
    chmodSync(statefulCliFile, 0o500)
    const newCliSha = createHash('sha256').update(readFileSync(statefulCliFile)).digest('hex')
    const updatedSnap = {
      ...h.probedSnapshot,
      cliSha256: newCliSha,
      ...(h.probedSnapshot.nativeSha256 ? { nativeSha256: newCliSha } : {}),
    }
    const obs = await recordDriverProbeSnapshot(h.pool, {
      profileId: h.profileId,
      snapshot: updatedSnap,
      policySha256: h.expectedPolicySha256,
    })
    assert.ok(obs.verificationRunId)
    const claimed = await claimDriverVerificationRun(h.pool, {
      leaseOwner: 'ac5-rehearsal-init',
      profileId: h.profileId,
    })
    assert.ok(claimed)
    const completed = await completeDriverVerificationRun(h.pool, {
      runId: claimed.id,
      leaseOwner: 'ac5-rehearsal-init',
      outcome: 'passed',
      evidenceDigest: obs.fingerprint,
    })
    assert.equal(completed.executionReadyRestored, true)
    const statefulCtx = { cliPath: statefulCliFile, nativePath: statefulCliFile }

    // -------------------------------------------------------------------------
    // Rehearsal 1: In-flight turn triggers R1 drain & waits without killing g1
    // -------------------------------------------------------------------------
    const sessionKey = `agent:main:webchat:dm:ac5_cutover_${randomUUID().slice(0, 8)}`
    const syncBarrier = createAsyncBarrier()
    const g1 = await h.openLane({
      sessionKey,
      dedicatedToolHost: true,
      toolExecutionBarrier: syncBarrier.barrier,
      extraDriverContext: statefulCtx,
    })
    assert.equal(g1.placed.generation, '1')

    const drainCoordinator = new RemoteReleaseDrainCoordinator()
    const unregisterG1 = drainCoordinator.registerRelay(
      `${g1.placed.binding.operationId}:g1`,
      g1.relay,
    )

    const sentinel1Path = join(g1.containerCwd, 'ac5-g1-sentinel.txt')
    const sentinel1Body = `ac5-inflight-${randomUUID()}`
    const creditsBeforeG1 = await h.getUserCredits()
    const turn1 = await g1.submitTurn(h.buildWritePrompt(sentinel1Path, sentinel1Body))

    await syncBarrier.waitArrived
    assert.equal(g1.relay.idle, false, 'Relay must report non-idle while g1 turn is in flight')

    const inflightJournalCheck = await h.pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM request_finalize_journal
        WHERE request_id = $1 AND state IN ('inflight', 'finalizing')`,
      [turn1.requestId],
    )
    assert.equal(Number(inflightJournalCheck.rows[0]?.cnt ?? '0'), 1)

    // Verify non-destructive timeout: if cutover drain times out, it throws & reopens WITHOUT killing g1
    const shortTimeoutDrain = new RemoteReleaseDrainCoordinator()
    shortTimeoutDrain.registerRelay('g1-timeout-probe', g1.relay)
    let timeoutAbortedCleanly = false
    try {
      await shortTimeoutDrain.drainForCutover(h.pool, { timeoutMs: 65, pollIntervalMs: 15 })
    } catch (err) {
      if (err instanceof Error && err.message === 'REMOTE_RELEASE_DRAIN_TIMEOUT') {
        timeoutAbortedCleanly = true
      } else {
        throw err
      }
    }
    assert.equal(timeoutAbortedCleanly, true)
    assert.equal(shortTimeoutDrain.isDraining, false)
    assert.equal(g1.relay.idle, false, 'Timeout must NOT kill active g1 turn')

    // Now trigger actual R1 cutover drain while g1 is mid-flight
    const maintenanceOpenedAt = performance.now()
    const drainPromise = drainCoordinator.drainForCutover(h.pool, {
      timeoutMs: 15_000,
      pollIntervalMs: 20,
    })
    assert.equal(drainCoordinator.isDraining, true)

    // New session admission during drain MUST be rejected with REMOTE_POOL_DRAINING_RETRY_LATER
    let rejectedNewSessionCode = ''
    try {
      await placeRemoteDriverLane(
        {
          uid: h.uid,
          containerDbId: '7',
          dockerId: 'd'.repeat(64),
          sessionKey: `agent:main:webchat:dm:ac5_new_drain_${randomUUID().slice(0, 8)}`,
          canonicalModel: h.canonicalModel,
          driverId: h.driverId,
          driverContext: {},
        },
        {
          ...h.placeLaneOptions(),
          drainGate: drainCoordinator,
        },
      )
    } catch (err) {
      rejectedNewSessionCode = err instanceof Error ? err.message : String(err)
    }
    assert.equal(rejectedNewSessionCode, 'REMOTE_POOL_DRAINING_RETRY_LATER')

    // Keep g1 in-flight briefly (~120ms) while drain waits, then release tool barrier
    await new Promise((r) => setTimeout(r, 120))
    syncBarrier.release()

    const [drainResult] = await Promise.all([drainPromise, turn1.run.summary])
    drainCoordinator.reopen()
    const maintenanceWindowRejectionWindowMs = Math.round(performance.now() - maintenanceOpenedAt)
    unregisterG1()

    assert.equal(drainResult.drained, true)
    assert.ok(drainResult.elapsedMs >= 100, `Expected drain wait >= 100ms, got ${drainResult.elapsedMs}`)
    assert.equal(readFileSync(sentinel1Path, 'utf8'), sentinel1Body)
    assert.equal(g1.settledReceipts.length, 1)
    const creditsAfterG1 = await h.getUserCredits()
    const g1ChargedFen = creditsBeforeG1 - creditsAfterG1
    assert.ok(g1ChargedFen > 0n)

    const settledJournalCheck = await h.pool.query<{ state: string }>(
      'SELECT state FROM request_finalize_journal WHERE request_id = $1',
      [turn1.requestId],
    )
    const journalFinalState = settledJournalCheck.rows[0]?.state ?? 'deleted'
    assert.ok(
      journalFinalState !== 'inflight' && journalFinalState !== 'finalizing',
      `Expected journal exited inflight/finalizing, got ${journalFinalState}`,
    )

    // -------------------------------------------------------------------------
    // Rehearsal 2: R1 sticky session generation upgrade (g1 -> g2)
    // -------------------------------------------------------------------------
    const opId = g1.placed.binding.operationId
    const g1NativeSessionId = g1.settledReceipts[0].nativeSessionId
    await g1.closeLane()

    const relRow = await h.pool.query<{ state: string; native_session_id: string | null }>(
      'SELECT state, native_session_id FROM remote_agent_bindings WHERE operation_id = $1',
      [opId],
    )
    assert.equal(relRow.rows[0]?.state, 'released')
    assert.equal(relRow.rows[0]?.native_session_id, g1NativeSessionId)

    const g2 = await h.openLane({
      sessionKey,
      dedicatedToolHost: true,
      extraDriverContext: statefulCtx,
    })
    assert.equal(g2.placed.binding.operationId, opId)
    assert.equal(g2.placed.generation, '2')
    assert.equal(g2.placed.spec.manifest.nativeSessionId, g1NativeSessionId)

    // Stale generation state update for g1 must be fenced with REMOTE_LANE_GENERATION_FENCED
    let staleGenerationFenced = false
    try {
      await recordRemoteDriverLaneState(opId, '1', 'running', h.pool)
    } catch (err) {
      if (err instanceof Error && err.message === 'REMOTE_LANE_GENERATION_FENCED') {
        staleGenerationFenced = true
      } else {
        throw err
      }
    }
    assert.equal(staleGenerationFenced, true)

    const sentinel2Path = join(g2.containerCwd, 'ac5-g2-sentinel.txt')
    const sentinel2Body = `ac5-gen2-${randomUUID()}`
    const turn2 = await g2.submitTurn(h.buildWritePrompt(sentinel2Path, sentinel2Body))
    await turn2.run.summary
    assert.equal(readFileSync(sentinel2Path, 'utf8'), sentinel2Body)
    assert.equal(g2.settledReceipts.length, 1)
    assert.equal(g2.settledReceipts[0].provenance.generation, '2')
    assert.equal(g2.settledReceipts[0].nativeSessionId, g1NativeSessionId)
    const creditsAfterG2 = await h.getUserCredits()
    const g2ChargedFen = creditsAfterG1 - creditsAfterG2
    assert.ok(g2ChargedFen > 0n)
    await g2.closeLane()

    // -------------------------------------------------------------------------
    // Rehearsal 3: Disconnect / crash spool recovery (dual-read v3 + v4, zero replay)
    // -------------------------------------------------------------------------
    const crashSessionKey = `agent:main:webchat:dm:ac5_crash_${randomUUID().slice(0, 8)}`
    const failOnce = { active: true }
    const crashLane = await h.openLane({
      sessionKey: crashSessionKey,
      dedicatedToolHost: true,
      failTurnInsertOnce: failOnce,
      extraDriverContext: statefulCtx,
    })
    const sentinel3Path = join(crashLane.containerCwd, 'ac5-crash-sentinel.txt')
    const sentinel3Body = `ac5-crash-${randomUUID()}`
    const creditsBeforeCrash = await h.getUserCredits()
    const turn3 = await crashLane.submitTurn(h.buildWritePrompt(sentinel3Path, sentinel3Body))
    await turn3.run.summary.catch(() => {})
    await crashLane.closeLane()

    assert.equal(
      crashLane.executedCalls.length,
      1,
      'Tool executed exactly once before simulated PG disconnect',
    )
    assert.equal(readFileSync(sentinel3Path, 'utf8'), sentinel3Body)

    const preRecoveryTurnRows = await h.pool.query<{ cnt: string }>(
      'SELECT COUNT(*)::text AS cnt FROM remote_native_turns WHERE request_id = $1',
      [turn3.requestId],
    )
    assert.equal(Number(preRecoveryTurnRows.rows[0]?.cnt ?? '0'), 0)

    const firstRecovery = await h.recoverSpool()
    const creditsAfterFirstRecovery = await h.getUserCredits()
    const recoveredFen = creditsBeforeCrash - creditsAfterFirstRecovery
    assert.ok(recoveredFen > 0n, 'Crash spool recovery must settle exact Turn 3 credits')

    // Second pass must be 100% idempotent (zero double-settlement, zero replay)
    const secondRecovery = await h.recoverSpool()
    const creditsAfterSecondRecovery = await h.getUserCredits()
    assert.equal(creditsAfterSecondRecovery, creditsAfterFirstRecovery)
    assert.equal(
      crashLane.executedCalls.length,
      1,
      'Spool recovery must NEVER replay tool execution',
    )

    const postRecoveryTurnRows = await h.pool.query<{ cnt: string }>(
      'SELECT COUNT(*)::text AS cnt FROM remote_native_turns WHERE request_id = $1',
      [turn3.requestId],
    )
    assert.equal(Number(postRecoveryTurnRows.rows[0]?.cnt ?? '0'), 1)

    return {
      rehearsal1CutoverDrain: {
        passed: true,
        inflightRequestId: turn1.requestId,
        nonDestructiveTimeoutVerified: timeoutAbortedCleanly,
        newAdmissionRejectedCode: rejectedNewSessionCode,
        drainElapsedMs: drainResult.elapsedMs,
        maintenanceWindowRejectionWindowMs,
        maintenanceWindowDefinition:
          'New session admissions rejected with REMOTE_POOL_DRAINING_RETRY_LATER while active relay turns, MCP ACKs, and PG finalize journals drain to 0; zero in-flight turns killed.',
        inflightTurnsKilled: 0,
        settledCreditsFen: g1ChargedFen.toString(),
      },
      rehearsal2GenerationUpgrade: {
        passed: true,
        operationId: opId,
        upgradedFromGeneration: '1',
        upgradedToGeneration: '2',
        preservedNativeSessionId: g1NativeSessionId,
        staleGenerationFenced,
        settledCreditsFen: g2ChargedFen.toString(),
      },
      rehearsal3CrashSpoolRecovery: {
        passed: true,
        requestId: turn3.requestId,
        toolExecutionsTotal: crashLane.executedCalls.length,
        zeroReplayVerified: true,
        firstRecoverySummary: firstRecovery,
        secondRecoverySummary: secondRecovery,
        recoveredCreditsFen: recoveredFen.toString(),
        idempotentSecondPassVerified: creditsAfterSecondRecovery === creditsAfterFirstRecovery,
      },
    }
  } finally {
    await h.close()
  }
}

async function main() {
  const argv = process.argv.slice(2)
  let outputPath = ''
  let ccConformanceDir = ''
  let codexConformanceDir = ''
  let runLegacyBaseline = false

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--output') outputPath = resolve(argv[++i])
    else if (a === '--cc-conformance') ccConformanceDir = resolve(argv[++i])
    else if (a === '--codex-conformance') codexConformanceDir = resolve(argv[++i])
    else if (a === '--run-legacy-baseline') runLegacyBaseline = true
    else throw new Error(`Unknown argument: ${a}`)
  }

  const ccOverhead = await measureDriverSchedulingOverhead('cc', 200)
  const codexOverhead = await measureDriverSchedulingOverhead('codex', 200)
  const ac5 = await runAc5Rehearsals()
  const legacyBaseline = runLegacyBaseline ? runLegacyBaselineSuites() : null
  const liveParity =
    ccConformanceDir && codexConformanceDir
      ? {
          cc: verifyLiveConformanceEvidence(ccConformanceDir, 'cc'),
          codex: verifyLiveConformanceEvidence(codexConformanceDir, 'codex'),
        }
      : null

  const report = {
    ticket: 'OCV5-749',
    generatedAt: new Date().toISOString(),
    ac4: {
      schedulingOverheadGate: {
        budgetP95Ms: 50,
        cc: ccOverhead,
        codex: codexOverhead,
        passed: ccOverhead.withinBudget && codexOverhead.withinBudget,
      },
      legacy746BaselineSuites: legacyBaseline,
      liveNodeParityCrossCheck: liveParity,
    },
    ac5,
    overallPassed:
      ccOverhead.withinBudget &&
      codexOverhead.withinBudget &&
      ac5.rehearsal1CutoverDrain.passed &&
      ac5.rehearsal2GenerationUpgrade.passed &&
      ac5.rehearsal3CrashSpoolRecovery.passed &&
      (legacyBaseline ? legacyBaseline.every((s) => s.passed) : true) &&
      (liveParity !== null
        ? liveParity.cc.group1ContainerToolVerified &&
          liveParity.codex.group1ContainerToolVerified &&
          liveParity.cc.group4StopProofVerified &&
          liveParity.codex.group4StopProofVerified &&
          liveParity.cc.group5MultiTurnResumeAndFeeVerified &&
          liveParity.codex.group5MultiTurnResumeAndFeeVerified
        : true),
  }

  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(`${JSON.stringify({ ok: report.overallPassed, outputPath }, null, 2)}\n`)
  process.exit(report.overallPassed ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
