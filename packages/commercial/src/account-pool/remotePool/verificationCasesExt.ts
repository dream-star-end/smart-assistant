/**
 * Verification cases G5..G7 for `remote-driver-v4` production commissioning (`OCV5-749`, R12).
 * Separated from `verificationCases.ts` to keep modules concise (`< 450` lines).
 */
import { isDeepStrictEqual } from 'node:util'
import { computeCostFen, normalizeUsageWithPolicy, validateUsagePolicy } from '@openclaude/protocol'
import type { RemoteDriverVerificationCaseLane } from './driftCoordinator.js'
import { recordRemoteDriverLaneState } from './placement.js'
import type { VerificationCaseContext } from './verificationCases.js'

function need(condition: unknown, code = 'REMOTE_VERIFICATION_CASE_FAILED'): asserts condition {
  if (!condition) throw new Error(code)
}

export async function runCasesG5ToG7(
  ctx: VerificationCaseContext,
  helpers: {
    readonly buildWritePrompt: (filePath: string, content: string, tag: string) => string
    readonly countUsageRowsForRequest: (requestId: string) => Promise<number>
    readonly assertRemoteStopProof: (proof: unknown) => { scopes: unknown[]; populated: number }
    readonly trackLane: (l: RemoteDriverVerificationCaseLane) => void
    readonly trackReq: (id: string) => void
    readonly items: Record<string, unknown>
  },
): Promise<void> {
  const {
    buildWritePrompt,
    countUsageRowsForRequest,
    assertRemoteStopProof,
    trackLane,
    trackReq,
    items,
  } = helpers

  // Item 5 (G5): 2-turn warm accounting parity against model_pricing, usage_records, journal & remote_native_turns
  {
    ctx.checkCancelled()
    trackLane('g5')
    const g5 = await ctx.openSubLane('g5')
    const t1 = await ctx.submitSubLaneTurn(
      g5,
      1,
      buildWritePrompt(`${g5.laneCwd}/g5-t1.txt`, `G5_1_${ctx.run.id}`, 'g5-1'),
    )
    trackReq(t1.requestId)
    const t2 = await ctx.submitSubLaneTurn(
      g5,
      2,
      buildWritePrompt(`${g5.laneCwd}/g5-t2.txt`, `G5_2_${ctx.run.id}`, 'g5-2'),
    )
    trackReq(t2.requestId)
    need(g5.receipts.length === 2, 'G5_EXPECTED_TWO_RECEIPTS')
    need(
      g5.receipts[0]!.nativeSessionId === g5.receipts[1]!.nativeSessionId,
      'G5_WARM_SESSION_NOT_REUSED',
    )

    const priceRow = (
      await ctx.pool.query<Record<string, any>>(
        `SELECT input_per_mtok::text, output_per_mtok::text, cache_read_per_mtok::text,
                cache_write_per_mtok::text, multiplier::text
           FROM model_pricing
          WHERE model_id = $1`,
        [ctx.canonicalModel],
      )
    ).rows[0]
    need(priceRow !== undefined, 'G5_PRICING_MISSING')
    need(g5.usagePolicy !== undefined, 'G5_USAGE_POLICY_MISSING')
    const policy = validateUsagePolicy(g5.usagePolicy)

    for (const [idx, rcpt] of g5.receipts.entries()) {
      if (idx === 1 && policy.mode === 'cumulative') {
        need(
          isDeepStrictEqual(rcpt.countersBaseline, g5.receipts[0]!.countersFinal),
          'G5_CUMULATIVE_BASELINE_MISMATCH',
        )
      }
      const normalized = normalizeUsageWithPolicy(policy, rcpt.countersFinal, rcpt.countersBaseline)
      need(isDeepStrictEqual(normalized.usage, rcpt.usage), `G5_USAGE_MISMATCH_T${idx + 1}`)
      const expectedFen = computeCostFen(
        {
          input_tokens: normalized.usage.inputTokens,
          output_tokens: normalized.usage.outputTokens,
          cache_read_tokens: normalized.usage.cacheReadTokens,
          cache_write_tokens: normalized.usage.cacheWriteTokens,
        },
        {
          input_per_mtok: BigInt(priceRow.input_per_mtok),
          output_per_mtok: BigInt(priceRow.output_per_mtok),
          cache_read_per_mtok: BigInt(priceRow.cache_read_per_mtok),
          cache_write_per_mtok: BigInt(priceRow.cache_write_per_mtok),
          multiplier: String(priceRow.multiplier),
        },
      )
      const uRes = await ctx.pool.query<{ cost_credits: string }>(
        'SELECT cost_credits::text FROM usage_records WHERE request_id = $1',
        [rcpt.requestId],
      )
      need(uRes.rows.length === 1, `G5_USAGE_RECORD_MISSING_T${idx + 1}`)
      need(BigInt(uRes.rows[0]!.cost_credits) === expectedFen, `G5_COST_MISMATCH_T${idx + 1}`)
      const jRes = await ctx.pool.query<{ state: string }>(
        'SELECT state FROM request_finalize_journal WHERE request_id = $1',
        [rcpt.requestId],
      )
      need(jRes.rows[0]?.state === 'committed', `G5_JOURNAL_NOT_COMMITTED_T${idx + 1}`)
      const ntRes = await ctx.pool.query<{ request_id: string }>(
        'SELECT request_id FROM remote_native_turns WHERE request_id = $1',
        [rcpt.requestId],
      )
      need(ntRes.rows.length === 1, `G5_NATIVE_TURN_MISSING_T${idx + 1}`)
    }

    const g5Closed = await ctx.closeSubLane(g5)
    assertRemoteStopProof(g5Closed.remoteStopProof)
    items.g5 = {
      passed: true,
      requestIds: [t1.requestId, t2.requestId],
      nativeSessionId: g5.receipts[0]!.nativeSessionId,
    }
  }

  // Item 6 (G6a + G6b): Concurrent barrier rendezvous on same profile -> distinct sessions & taskRoots
  {
    ctx.checkCancelled()
    trackLane('g6a')
    trackLane('g6b')
    const [g6a, g6b] = await Promise.all([
      ctx.openSubLane('g6a', { barrierMode: 'hold_until_release' }),
      ctx.openSubLane('g6b', { barrierMode: 'hold_until_release' }),
    ])
    need(g6a.taskRoot !== g6b.taskRoot, 'G6_TASK_ROOTS_NOT_DISTINCT')
    const fileA = `${g6a.laneCwd}/g6a.txt`
    const fileB = `${g6b.laneCwd}/g6b.txt`
    const [turnA, turnB] = await Promise.all([
      ctx.startSubLaneTurn(g6a, 1, buildWritePrompt(fileA, `G6A_${ctx.run.id}`, 'g6a'), {
        barrierMode: 'hold_until_release',
      }),
      ctx.startSubLaneTurn(g6b, 1, buildWritePrompt(fileB, `G6B_${ctx.run.id}`, 'g6b'), {
        barrierMode: 'hold_until_release',
      }),
    ])
    trackReq(turnA.requestId)
    trackReq(turnB.requestId)
    await Promise.all([ctx.waitBarrierArrived('g6a'), ctx.waitBarrierArrived('g6b')])
    await Promise.all([ctx.releaseBarrier('g6a', false), ctx.releaseBarrier('g6b', false)])
    const [resA, resB] = await Promise.all([turnA.waitDone(), turnB.waitDone()])
    need(
      Boolean(resA.nativeSessionId && resB.nativeSessionId) &&
        resA.nativeSessionId !== resB.nativeSessionId,
      'G6_SESSIONS_NOT_DISTINCT',
    )
    const [closedA, closedB] = await Promise.all([
      ctx.closeSubLane(g6a, { expectedFiles: [{ path: fileA, content: `G6A_${ctx.run.id}` }] }),
      ctx.closeSubLane(g6b, { expectedFiles: [{ path: fileB, content: `G6B_${ctx.run.id}` }] }),
    ])
    assertRemoteStopProof(closedA.remoteStopProof)
    assertRemoteStopProof(closedB.remoteStopProof)
    items.g6 = {
      passed: true,
      sessions: [resA.nativeSessionId, resB.nativeSessionId],
      taskRoots: [g6a.taskRoot, g6b.taskRoot],
    }
  }

  // Item 7 (G7old + G7new): Memory admission rejects 64MiB new lane while preserving active g7old
  {
    ctx.checkCancelled()
    trackLane('g7old')
    trackLane('g7new')
    const g7old = await ctx.openSubLane('g7old', { barrierMode: 'hold_until_release' })
    const oldFile = `${g7old.laneCwd}/g7old.txt`
    const oldTurn = await ctx.startSubLaneTurn(
      g7old,
      1,
      buildWritePrompt(oldFile, `G7OLD_${ctx.run.id}`, 'g7old'),
      { barrierMode: 'hold_until_release' },
    )
    trackReq(oldTurn.requestId)
    await ctx.waitBarrierArrived('g7old')

    const g7new = await ctx.openSubLane('g7new', {
      maxSliceMemoryBytes: 64 * 1024 * 1024,
      skipPreflight: true,
    })
    let g7newRejected = false
    let newTurnReqId: string | null = null
    try {
      const pre = await g7new.host.preflight()
      if (!pre.memoryOk) {
        g7newRejected = true
      } else {
        const resNew = await ctx.submitSubLaneTurn(
          g7new,
          1,
          buildWritePrompt(`${g7new.laneCwd}/g7new.txt`, 'SHOULD_FAIL', 'g7new'),
        )
        newTurnReqId = resNew.requestId
        trackReq(resNew.requestId)
        if (resNew.summary?.isError || resNew.calls.length === 0) {
          g7newRejected = true
        }
      }
    } catch {
      g7newRejected = true
    }
    need(g7newRejected, 'G7NEW_DID_NOT_REJECT_UNDER_MEMORY_CAP')
    need(!(await ctx.checkRemoteTaskFileExists(g7new, 'APP-SCOPE.json')), 'G7NEW_SPAWNED_APP_SCOPE')
    if (newTurnReqId) {
      need((await countUsageRowsForRequest(newTurnReqId)) === 0, 'G7NEW_CHARGED_CREDITS')
    }
    await recordRemoteDriverLaneState(g7new.operationId, g7new.generation, 'released', ctx.pool)
    await ctx.closeSubLane(g7new, {
      absentFiles: [`${g7new.laneCwd}/g7new.txt`],
      keepState: true,
    })

    await ctx.releaseBarrier('g7old', false)
    const oldRes = await oldTurn.waitDone()
    need(oldRes.calls.length === 1, 'G7OLD_CALL_FAILED')
    need((await countUsageRowsForRequest(oldTurn.requestId)) === 1, 'G7OLD_USAGE_MISSING')
    const oldClosed = await ctx.closeSubLane(g7old, {
      expectedFiles: [{ path: oldFile, content: `G7OLD_${ctx.run.id}` }],
    })
    assertRemoteStopProof(oldClosed.remoteStopProof)
    items.g7 = { passed: true, g7oldRequestId: oldTurn.requestId, g7newRejected: true }
  }
}
