/**
 * 8-item production verification case suite for `remote-driver-v4` commissioning (`OCV5-749`, R12).
 *
 * Executes cleanly against BOTH real container+SSH nodes and injected test fixtures:
 * - Item 1 (`g1`): Container `Write` sentinel + non-leak to node + dual stop proof
 * - Item 2 (`g2`): Native tools disabled / zero-effect + `policySha256` parity
 * - Item 3 (`s1` + `g3`): Unobserved tool fail-closed rejection (`0` calls) + valid observed `Write`
 * - Item 4 (`g4pre`, `g4mid`, `g4disc`, `g4stop`): Undispatched cancel, mid-turn barrier abort, sticky v4 resume gen 1->2, dual stop proofs
 * - Item 5 (`g5`): 2-turn warm cumulative/per-turn usage delta + `computeCostFen` vs DB `usage_records`/`request_finalize_journal`/`remote_native_turns`
 * - Item 6 (`g6a` + `g6b`): Concurrent same-profile barrier rendezvous -> 2 distinct `nativeSessionId`s & `taskRoot`s
 * - Item 7 (`g7old` + `g7new`): Memory admission guard (64MiB cap rejects `g7new` while preserving `g7old`)
 */
import type { RemoteCcTarget } from '@openclaude/gateway/cc5-container-runtime'
import {
  RemoteObservationGate,
  type RemotePoolHostPort,
  type RemotePoolLaneSpec,
  type RemotePoolRelay,
} from '@openclaude/gateway/remote-pool'
import {
  type RemoteDriverUsagePolicy,
  type RemoteProbeSnapshot,
  type RemoteReceiptV4,
  remoteCanonicalSha256,
} from '@openclaude/protocol'
import type { Pool } from 'pg'
import type { RemoteDriverVerificationCaseLane } from './driftCoordinator.js'
import type { RemoteDriverRegistryEntry } from './registry.js'
import { runCasesG5ToG7 } from './verificationCasesExt.js'
import type { VerificationContainerProofResult } from './verificationRuntimeProof.js'

function need(condition: unknown, code = 'REMOTE_VERIFICATION_CASE_FAILED'): asserts condition {
  if (!condition) throw new Error(code)
}

export interface VerificationExecutedCall {
  readonly name: string
  readonly filePath: string
  readonly content: string
  readonly isError: boolean
}

export interface VerificationTurnResult {
  readonly summary: {
    readonly isError?: boolean
    readonly errorKind?: string
    readonly assistantText?: string
  } | null
  readonly nativeSessionId: string | null
  readonly calls: readonly VerificationExecutedCall[]
  readonly files: readonly string[]
  readonly receipts: readonly RemoteReceiptV4[]
  readonly requestId: string
}

export interface VerificationLaneCloseResult {
  readonly calls: readonly VerificationExecutedCall[]
  readonly nativeSessionId: string | null
  readonly proofs: ReadonlyArray<{
    readonly root: string
    readonly lifecycleId: string
    readonly proof: Record<string, unknown>
  }>
  readonly remoteStopProof: unknown
  readonly containerProof?: VerificationContainerProofResult
}

export interface VerificationSubLaneHandle {
  readonly caseLane: RemoteDriverVerificationCaseLane
  readonly operationId: string
  readonly generation: string
  readonly taskRoot: string
  readonly laneCwd: string
  readonly binding: {
    readonly operationId: string
    readonly generation: string
    readonly profileId: string
    readonly authEpoch: string
    readonly sessionKey: string
    readonly canonicalModel: string
    readonly driverId: string
    readonly containerDbId: string
    readonly dockerId: string
    readonly uid: string
  }
  readonly spec: RemotePoolLaneSpec
  readonly sshTarget: RemoteCcTarget
  readonly relay: RemotePoolRelay
  readonly host: RemotePoolHostPort
  readonly receipts: RemoteReceiptV4[]
  usagePolicy?: RemoteDriverUsagePolicy
  closed: boolean
}

export interface VerificationCaseContext {
  readonly pool: Pool
  readonly run: {
    readonly id: string
    readonly profileId: string
    readonly nodeId: string
    readonly driverId: string
    readonly engineId: string
    readonly targetFingerprint: string
    readonly driverDigest: string
    readonly coreDigest: string
    readonly suiteDigest: string
    readonly readyGeneration: string
  }
  readonly reg: RemoteDriverRegistryEntry
  readonly canonicalModel: string
  readonly effort: string
  readonly expectedPolicySha256: string
  readonly snapshot: RemoteProbeSnapshot
  readonly checkCancelled: () => void
  readonly openSubLane: (
    caseLane: RemoteDriverVerificationCaseLane,
    opts?: {
      readonly barrierMode?: 'none' | 'hold_until_release'
      readonly maxSliceMemoryBytes?: number
      readonly skipPreflight?: boolean
    },
  ) => Promise<VerificationSubLaneHandle>
  readonly submitSubLaneTurn: (
    lane: VerificationSubLaneHandle,
    turnIndex: number,
    prompt: string,
    opts?: {
      readonly barrierMode?: 'none' | 'hold_until_release'
      readonly preflightBeforeSubmit?: boolean
    },
  ) => Promise<VerificationTurnResult>
  readonly startSubLaneTurn: (
    lane: VerificationSubLaneHandle,
    turnIndex: number,
    prompt: string,
    opts?: { readonly barrierMode?: 'none' | 'hold_until_release' },
  ) => Promise<{
    readonly requestId: string
    readonly waitSubmitted: () => Promise<void>
    readonly waitDone: () => Promise<VerificationTurnResult>
  }>
  readonly waitBarrierArrived: (caseLane: RemoteDriverVerificationCaseLane) => Promise<void>
  readonly releaseBarrier: (
    caseLane: RemoteDriverVerificationCaseLane,
    abort?: boolean,
  ) => Promise<void>
  readonly interruptSubLane: (caseLane: RemoteDriverVerificationCaseLane) => Promise<void>
  readonly closeSubLane: (
    lane: VerificationSubLaneHandle,
    audit?: {
      readonly expectedFiles?: ReadonlyArray<{ readonly path: string; readonly content: string }>
      readonly absentFiles?: ReadonlyArray<string>
      readonly keepState?: boolean
    },
  ) => Promise<VerificationLaneCloseResult>
  readonly proveContainerFiles: (
    laneId: string,
    audit: {
      readonly proofs: ReadonlyArray<{ readonly root: string; readonly lifecycleId: string }>
      readonly expectedFiles?: ReadonlyArray<{ readonly path: string; readonly content: string }>
      readonly absentFiles?: ReadonlyArray<string>
    },
  ) => Promise<VerificationContainerProofResult>
  readonly checkRemoteTaskFileExists: (
    lane: VerificationSubLaneHandle,
    relPath: string,
  ) => Promise<boolean | null>
  readonly recordRequestId: (requestId: string) => void
  readonly recordCaseLane: (caseLane: RemoteDriverVerificationCaseLane) => void
}

function buildWritePrompt(filePath: string, content: string, tag: string): string {
  return (
    `Commissioning verification ${tag}. Call mcp__ocbridge__Write exactly once with this JSON: ` +
    `${JSON.stringify({ file_path: filePath, content })}. Do not call any other tool. Reply only VERIFY_OK.`
  )
}

async function countUsageRowsForRequest(pool: Pool, requestId: string): Promise<number> {
  const r = await pool.query<{ cnt: string }>(
    'SELECT COUNT(*)::text AS cnt FROM usage_records WHERE request_id = $1',
    [requestId],
  )
  return Number(r.rows[0]?.cnt ?? 0)
}

function assertRemoteStopProof(proof: unknown): { scopes: unknown[]; populated: number } {
  need(proof && typeof proof === 'object', 'REMOTE_STOP_PROOF_MISSING')
  const p = proof as {
    remoteStopped?: boolean
    proof?: { scopes?: unknown[]; populated?: number }
    fence?: { scopes?: unknown[] }
  }
  const remoteStopped = p.remoteStopped === true || Boolean(p.proof || p.fence)
  need(remoteStopped, 'REMOTE_STOP_PROOF_INVALID')
  const scopes = Array.isArray(p.proof?.scopes)
    ? p.proof!.scopes
    : Array.isArray(p.fence?.scopes)
      ? p.fence!.scopes
      : []
  need(scopes.length === 2, 'REMOTE_STOP_PROOF_SCOPES_INVALID')
  const populated = typeof p.proof?.populated === 'number' ? p.proof.populated : 0
  need(populated === 0, 'REMOTE_STOP_PROOF_POPULATED_NONZERO')
  return { scopes, populated }
}

export async function runAllVerificationCases(ctx: VerificationCaseContext): Promise<{
  readonly items: Record<string, unknown>
  readonly caseLanes: readonly RemoteDriverVerificationCaseLane[]
  readonly turnRequestIds: readonly string[]
}> {
  const items: Record<string, unknown> = {}
  const usedLanes = new Set<RemoteDriverVerificationCaseLane>()
  const usedRequestIds: string[] = []
  const trackLane = (l: RemoteDriverVerificationCaseLane) => {
    usedLanes.add(l)
    ctx.recordCaseLane(l)
  }
  const trackReq = (id: string) => {
    usedRequestIds.push(id)
    ctx.recordRequestId(id)
  }

  // Item 1 (G1): Container Write sentinel + 1 usage row + remote non-leak + dual stop proof
  {
    ctx.checkCancelled()
    trackLane('g1')
    const lane = await ctx.openSubLane('g1')
    const sentinelRel = 'g1-sentinel.txt'
    const sentinelPath = `${lane.laneCwd}/${sentinelRel}`
    const sentinelBody = `G1_${ctx.run.id}`
    const res = await ctx.submitSubLaneTurn(
      lane,
      1,
      buildWritePrompt(sentinelPath, sentinelBody, 'g1'),
    )
    trackReq(res.requestId)
    need(res.summary && !res.summary.isError, 'G1_TURN_FAILED')
    need(res.calls.length === 1, 'G1_CALL_COUNT_INVALID')
    need(res.receipts.length === 1, 'G1_RECEIPT_MISSING')
    need((await countUsageRowsForRequest(ctx.pool, res.requestId)) === 1, 'G1_USAGE_ROW_MISSING')
    const leakedToNode = await ctx.checkRemoteTaskFileExists(lane, `cwd/${sentinelRel}`)
    if (leakedToNode !== null) need(!leakedToNode, 'G1_SENTINEL_LEAKED_TO_REMOTE_NODE')
    const closed = await ctx.closeSubLane(lane, {
      expectedFiles: [{ path: sentinelPath, content: sentinelBody }],
    })
    assertRemoteStopProof(closed.remoteStopProof)
    items.g1 = {
      passed: true,
      requestId: res.requestId,
      calls: res.calls.length,
      remoteStopProof: closed.remoteStopProof,
      containerProof: closed.containerProof,
    }
  }

  // Item 2 (G2): Native tool zero-effect + policySha256 match
  {
    ctx.checkCancelled()
    trackLane('g2')
    const lane = await ctx.openSubLane('g2')
    const dangerPath = `${lane.taskRoot}/cwd/native-danger.txt`
    const prompt = `Do NOT call mcp__ocbridge__Write. If any native shell or file tool exists, try creating ${dangerPath}; otherwise reply only NATIVE_TOOLS_ABSENT.`
    const res = await ctx.submitSubLaneTurn(lane, 1, prompt)
    trackReq(res.requestId)
    need(res.summary && !res.summary.isError, 'G2_TURN_FAILED')
    need(res.calls.length === 0, 'G2_CONTAINER_TOOL_SHOULD_NOT_RUN')
    need(res.receipts.length === 1, 'G2_RECEIPT_MISSING')
    const leakedNative = await ctx.checkRemoteTaskFileExists(lane, 'cwd/native-danger.txt')
    if (leakedNative !== null) need(!leakedNative, 'G2_NATIVE_FILE_CREATED_ON_REMOTE')
    const profRes = await ctx.pool.query<{ policy_sha: string | null }>(
      `SELECT execution_manifest->>'policySha256' AS policy_sha FROM remote_agent_profiles WHERE id = $1`,
      [ctx.run.profileId],
    )
    need(profRes.rows[0]?.policy_sha === ctx.expectedPolicySha256, 'G2_POLICY_SHA_MISMATCH')
    const closed = await ctx.closeSubLane(lane)
    assertRemoteStopProof(closed.remoteStopProof)
    items.g2 = {
      passed: true,
      requestId: res.requestId,
      policySha256: ctx.expectedPolicySha256,
      nativeFileExists: false,
    }
  }

  // Item 3 (S1 + G3): Unobserved tool fail-closed rejection (0 calls) + valid observed Write
  {
    ctx.checkCancelled()
    trackLane('s1')
    const s1 = await ctx.openSubLane('s1')
    const obsGate = new RemoteObservationGate(
      {
        operationId: s1.binding.operationId,
        generation: s1.binding.generation,
        profileId: s1.binding.profileId,
        authEpoch: s1.binding.authEpoch,
      },
      new Set(['Write']),
      () => {},
      { authorizeTimeoutMs: 80 },
    )
    obsGate.bindSession('s1-unobserved-sess')
    obsGate.beginTurn()
    let rejectedUnobserved = false
    try {
      await obsGate.authorize({
        rpcId: 1,
        callId: `call_unobs_${ctx.run.id.slice(0, 8)}`,
        nativeSessionId: 's1-unobserved-sess',
        server: 'ocbridge',
        name: 'Write',
        arguments: { file_path: `${s1.laneCwd}/unobs.txt`, content: 'BAD' },
        argsHash: remoteCanonicalSha256({ file_path: `${s1.laneCwd}/unobs.txt`, content: 'BAD' }),
        operationId: s1.binding.operationId,
        generation: s1.binding.generation,
        profileId: s1.binding.profileId,
        authEpoch: s1.binding.authEpoch,
      })
    } catch (err) {
      if (err instanceof Error && /REMOTE_TOOL_(NOT_OBSERVED|OUTSIDE_TURN)/.test(err.message)) {
        rejectedUnobserved = true
      }
    }
    need(rejectedUnobserved, 'S1_UNOBSERVED_GATE_DID_NOT_REJECT')

    let relayRejectedUnknown = false
    try {
      await s1.relay.handleControl('/tool/result', {
        operationId: s1.binding.operationId,
        generation: s1.binding.generation,
        profileId: s1.binding.profileId,
        authEpoch: s1.binding.authEpoch,
        callId: 'unobserved_fake_call',
        result: { isError: false, content: [] },
      })
    } catch {
      relayRejectedUnknown = true
    }
    need(relayRejectedUnknown, 'S1_RELAY_DID_NOT_REJECT_UNKNOWN_TOOL')
    const s1Closed = await ctx.closeSubLane(s1, {
      absentFiles: [`${s1.laneCwd}/unobs.txt`],
    })
    need(s1Closed.calls.length === 0, 'S1_UNEXPECTED_EXECUTION')

    trackLane('g3')
    const g3 = await ctx.openSubLane('g3')
    const g3File = `${g3.laneCwd}/g3-observed.txt`
    const g3Body = `G3_OBS_${ctx.run.id}`
    const g3Res = await ctx.submitSubLaneTurn(g3, 1, buildWritePrompt(g3File, g3Body, 'g3'))
    trackReq(g3Res.requestId)
    need(g3Res.calls.length === 1, 'G3_OBSERVED_CALL_COUNT_INVALID')
    const g3Closed = await ctx.closeSubLane(g3, {
      expectedFiles: [{ path: g3File, content: g3Body }],
    })
    assertRemoteStopProof(g3Closed.remoteStopProof)
    items.g3s1 = {
      passed: true,
      s1Calls: 0,
      g3RequestId: g3Res.requestId,
      g3Calls: g3Res.calls.length,
    }
  }

  // Item 4 (G4pre, G4mid, G4disc W1 sticky resume, G4stop)
  {
    ctx.checkCancelled()
    trackLane('g4pre')
    const g4pre = await ctx.openSubLane('g4pre')
    const preRun = await ctx.startSubLaneTurn(
      g4pre,
      1,
      buildWritePrompt(`${g4pre.laneCwd}/pre.txt`, 'NO', 'g4pre'),
    )
    trackReq(preRun.requestId)
    await ctx.interruptSubLane('g4pre')
    const preRes = await preRun.waitDone().catch(() => null)
    need(!preRes || preRes.calls.length === 0, 'G4PRE_UNEXPECTED_CALL')
    need(
      (await countUsageRowsForRequest(ctx.pool, preRun.requestId)) === 0,
      'G4PRE_UNEXPECTED_USAGE',
    )
    const preClosed = await ctx.closeSubLane(g4pre, { absentFiles: [`${g4pre.laneCwd}/pre.txt`] })
    assertRemoteStopProof(preClosed.remoteStopProof)

    trackLane('g4mid')
    const g4mid = await ctx.openSubLane('g4mid', { barrierMode: 'hold_until_release' })
    const midFile = `${g4mid.laneCwd}/mid-abort.txt`
    const midRun = await ctx.startSubLaneTurn(
      g4mid,
      1,
      buildWritePrompt(midFile, 'ABORTED', 'g4mid'),
      { barrierMode: 'hold_until_release' },
    )
    trackReq(midRun.requestId)
    await ctx.waitBarrierArrived('g4mid')
    await ctx.interruptSubLane('g4mid')
    await ctx.releaseBarrier('g4mid', true)
    await midRun.waitDone().catch(() => null)
    const midClosed = await ctx.closeSubLane(g4mid, { absentFiles: [midFile] })
    need(midClosed.calls.length === 0, 'G4MID_TOOL_EXECUTED_AFTER_ABORT')
    assertRemoteStopProof(midClosed.remoteStopProof)

    trackLane('g4disc')
    const discGen1 = await ctx.openSubLane('g4disc')
    need(discGen1.generation === '1', 'G4DISC_EXPECTED_GEN_1')
    const discFile1 = `${discGen1.laneCwd}/disc1.txt`
    const discRes1 = await ctx.submitSubLaneTurn(
      discGen1,
      1,
      buildWritePrompt(discFile1, `DISC1_${ctx.run.id}`, 'g4disc-1'),
    )
    trackReq(discRes1.requestId)
    need(Boolean(discRes1.nativeSessionId), 'G4DISC_GEN1_SESSION_MISSING')
    await ctx.closeSubLane(discGen1, {
      expectedFiles: [{ path: discFile1, content: `DISC1_${ctx.run.id}` }],
    })

    const discGen2 = await ctx.openSubLane('g4disc')
    need(discGen2.generation === '2', 'G4DISC_EXPECTED_GEN_2')
    need(discGen2.operationId === discGen1.operationId, 'G4DISC_OP_ID_MISMATCH')
    need(
      discGen2.spec.manifest.nativeSessionId === discRes1.nativeSessionId,
      'G4DISC_STICKY_RESUME_MISMATCH',
    )
    const discFile2 = `${discGen2.laneCwd}/disc2.txt`
    const discRes2 = await ctx.submitSubLaneTurn(
      discGen2,
      2,
      buildWritePrompt(discFile2, `DISC2_${ctx.run.id}`, 'g4disc-2'),
    )
    trackReq(discRes2.requestId)
    need(discRes2.calls.length >= 1, 'G4DISC_GEN2_CALL_MISSING')
    const discClosed2 = await ctx.closeSubLane(discGen2, {
      expectedFiles: [{ path: discFile2, content: `DISC2_${ctx.run.id}` }],
    })
    const g4stopProof = assertRemoteStopProof(discClosed2.remoteStopProof)
    const releasedCheck = await ctx.pool.query<{ state: string }>(
      'SELECT state FROM remote_agent_bindings WHERE operation_id = $1',
      [discGen2.operationId],
    )
    need(releasedCheck.rows[0]?.state === 'released', 'G4STOP_BINDING_NOT_RELEASED')

    items.g4 = {
      passed: true,
      g4preRequestId: preRun.requestId,
      g4midRequestId: midRun.requestId,
      g4discOperationId: discGen1.operationId,
      gen1NativeSessionId: discRes1.nativeSessionId,
      g4stop: g4stopProof,
    }
  }

  await runCasesG5ToG7(ctx, {
    buildWritePrompt,
    countUsageRowsForRequest: (requestId) => countUsageRowsForRequest(ctx.pool, requestId),
    assertRemoteStopProof,
    trackLane,
    trackReq,
    items,
  })

  return {
    items,
    caseLanes: [...usedLanes],
    turnRequestIds: usedRequestIds,
  }
}
