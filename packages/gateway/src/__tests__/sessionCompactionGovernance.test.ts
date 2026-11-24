import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, it } from 'node:test'
import { WebSocket } from 'ws'
import { Value } from '@sinclair/typebox/value'
import {
  AnyFrame,
  ContextCompaction,
  ContextPressure,
  ControlCompact,
  OutboundSessionCompactResult,
  modelHistoryReservedTokens,
  projectModelHistoryForReplay,
  resolveEffectiveModelHistoryContextWindow,
  resolveModelHistoryContextWindow,
} from '@openclaude/protocol'
import {
  matchBridgeApiAllowlist,
  matchCommercialContainerApiProxy,
} from '../bridgeApiAllowlist.js'
import {
  handleAgentContextHealth,
  handleAgentContextHygieneHistory,
  handleAgentContextHygieneRun,
  handleAgentMemoryArchive,
  handleAgentMemoryArchiveRestore,
  handleSkillArchiveItem,
  handleSkillsArchiveList,
  handleSkillsArchiveRestore,
} from '../contextHealthApi.js'
import { boundSyncDelegateOutput, SYNC_DELEGATE_INLINE_MAX_CHARS } from '../delegateRuntime.js'
import { prepareBoundedPrompt } from '../engine/boundedPrompt.js'
import { writeContextReference } from '../engine/contextReference.js'
import { formatJobTerminalMarkdown, RESULT_REF_MAX, resultRefFromSnapshot } from '../jobTerminal.js'
import { DEFAULT_MAX_OUTPUT_CHARS, MAX_OUTPUT_CHARS, parseFile } from '../mcpWebContextServer.js'
import { serializeMetrics } from '../metrics.js'
import {
  cleanupSessionArtifacts,
  offloadPayloadIfOversized,
  truncateUtf8Safe,
} from '../payloadOffloadGate.js'
import {
  DEFAULT_READ_BOARD_MAX_BYTES,
  MAX_SWARM_POST_CHARS,
  RemoteSwarmRuntime,
} from '../remoteSwarmRuntime.js'
import { parseCcbContextObservation } from '../ccbContextObservation.js'
import { CodexNativeContext } from '../engine/codexNativeContext.js'
import {
  ackPendingCheckpoint,
  checkpointFilePath,
  clearPendingCheckpoint,
  isSessionCompacting,
  markCheckpointTurnOutcome,
  peekPendingCheckpoint,
} from '../sessionCheckpointStore.js'
import {
  buildLegacyRollingCheckpointSummary,
  buildRollingCheckpointSummary,
  compactSession,
  consumePendingCheckpointSummary,
  destroySession,
  peekPendingCheckpointSummary,
  type SessionLifecycleHost,
} from '../sessionLifecycle.js'
import {
  buildHistoricalContextPrompt,
  buildRollingCheckpointPayload,
  type AgentSession,
} from '../sessionManager.js'
import { submit, type SessionSubmitHost } from '../sessionSubmit.js'
import { enrichContextPressure } from '../sessionTurnRunner.js'
import { handleControlSessionCompactFrame } from '../wsConnection.js'

const tempDirs: string[] = []
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

function mockReq(method: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : []) as unknown as IncomingMessage
  ;(stream as { method: string }).method = method
  return stream
}

function mockRes(): {
  res: ServerResponse
  statusCode: () => number
  json: () => any
} {
  let code = 200
  let raw = ''
  const res = {
    writeHead(status: number) {
      code = status
      return res
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
      return res
    },
  } as unknown as ServerResponse
  return {
    res,
    statusCode: () => code,
    json: () => JSON.parse(raw),
  }
}

function makeFakeHost(overrides?: Partial<SessionLifecycleHost>): SessionLifecycleHost {
  return {
    sessions: new Map(),
    _resumeMap: new Map(),
    _resumeMapTimestamps: new Map(),
    _resumeMapProvider: new Map(),
    _resumeMapLastCost: new Map(),
    _resumeMapCostImprecise: new Map(),
    _resumeMapHistory: new Map(),
    _saveResumeMap: () => {},
    submit: async () => {},
    ...overrides,
  } as unknown as SessionLifecycleHost
}

function makeFakeSession(overrides?: Partial<AgentSession>): AgentSession {
  const runner = Object.assign(new EventEmitter(), {
    engineId: 'antigravity',
    isRunning: true,
    capabilities: {
      billingMode: 'external' as const,
      supportsEffort: true,
      resumeKind: 'antigravity-session' as const,
      needsServerRequestId: true,
      historyMode: 'native-resume' as const,
      permissionModel: 'forced-unattended' as const,
      emitsCallUsage: false,
      emitsToolInputDeltas: false,
      supportsNativeCompact: false,
      multimodalInput: 'text-only' as const,
    },
    shutdown: async () => {},
    clearSessionId: () => {},
  })
  return {
    sessionKey: 'agent:main:webchat:dm:sess-1',
    agentId: 'main',
    channel: 'webchat',
    peerId: 'sess-1',
    userId: 'u1',
    providerTag: 'antigravity',
    runner: runner as unknown as AgentSession['runner'],
    ccbSessionId: 'native-123',
    totalInputTokens: 42_000,
    totalOutputTokens: 4_000,
    turns: 0,
    lock: Promise.resolve(),
    toolUseIdToName: new Map(),
    _activeTurnCount: 0,
    _activeClientTurnCount: 0,
    _idleInternalTurns: 0,
    ...overrides,
  } as unknown as AgentSession
}

describe('OCV5-840 Protocol extensions & backward compatibility', () => {
  it('validates extended ContextPressure, ContextCompaction, ControlCompact, OutboundSessionCompactResult', () => {
    assert.equal(
      Value.Check(ContextPressure, {
        engine: 'codex',
        scope: 'native_context',
        dimension: 'tokens',
        level: 'warning',
        usedRatio: 0.82,
        usedTokens: 210_000,
        windowTokens: 258_400,
        breakdown: { systemBytes: 4096, memoryBytes: 8192, skillsBytes: 2048, historyBytes: 40_000, toolsBytes: 12_000 },
      }),
      true,
    )
    assert.equal(
      Value.Check(ContextCompaction, {
        engine: 'antigravity',
        scope: 'native_context',
        strategy: 'checkpoint_reset',
        beforeBytes: 80_000,
        afterBytes: 4_500,
        droppedEntries: 14,
        beforeTokens: 25_000,
        afterTokens: 1_500,
        summaryPreview: '## Rolling Context Checkpoint',
        sessionId: 'sess-1',
        requestId: 'req-12345678',
      }),
      true,
    )
    assert.equal(
      Value.Check(ControlCompact, {
        type: 'control.session.compact',
        sessionId: 'sess-1',
        requestId: 'req-12345678',
        instructions: 'keep decisions',
      }),
      true,
    )
    const resultFrame = {
      type: 'outbound.session_compact_result',
      sessionKey: 'agent:main:webchat:dm:sess-1',
      requestId: 'req-12345678',
      ok: true,
      supported: true,
      strategy: 'checkpoint_reset',
      beforeBytes: 50_000,
      afterBytes: 3_000,
    }
    assert.equal(Value.Check(OutboundSessionCompactResult, resultFrame), true)
    assert.equal(Value.Check(AnyFrame, resultFrame), true)
  })
})

describe('OCV5-840 Cross-engine compactSession & concurrency guard', () => {
  it('routes Codex Local directly to compactForHandoff() without calling submit()', async () => {
    let compactCalls = 0
    let submitCalls = 0
    const session = makeFakeSession({
      providerTag: 'codex',
      runner: Object.assign(new EventEmitter(), {
        engineId: 'codex',
        isRunning: true,
        capabilities: {
          billingMode: 'engine-reported',
          supportsEffort: true,
          resumeKind: 'codex-thread',
          needsServerRequestId: true,
          historyMode: 'native-resume',
          permissionModel: 'native',
          emitsCallUsage: true,
          emitsToolInputDeltas: true,
          supportsNativeCompact: true,
          multimodalInput: 'native',
        },
        compactForHandoff: async () => {
          compactCalls += 1
          return { summaryText: 'Compacted Codex state summary', source: 'codex', compactStartedAt: Date.now() }
        },
        shutdown: async () => {},
      }) as unknown as AgentSession['runner'],
    })
    const host = makeFakeHost({
      submit: async () => {
        submitCalls += 1
      },
    })
    const res = await compactSession.call(host, session)
    assert.equal(res.ok, true)
    assert.equal(res.strategy, 'native_summary')
    assert.equal(compactCalls, 1)
    assert.equal(submitCalls, 0)
    assert.match(res.summaryPreview ?? '', /Compacted Codex state/)
  })

  it('executes Rolling Checkpoint Reset for Antigravity, resets native handle, and enforces re-entry lock', async () => {
    let shutdownCalled = false
    let clearedId = false
    const session = makeFakeSession({ providerTag: 'antigravity' })
    ;(session.runner as any).shutdown = async () => {
      shutdownCalled = true
    }
    ;(session.runner as any).clearSessionId = () => {
      clearedId = true
    }
    const host = makeFakeHost()
    host._resumeMap.set(session.sessionKey, 'conv-old-uuid')

    let releaseLoad!: () => void
    const loadGate = new Promise<void>((r) => {
      releaseLoad = r
    })
    const history = [
      { role: 'user', text: 'Investigate context bloat across all engines' },
      { role: 'tool', toolName: 'Bash', output: 'X'.repeat(20_000) },
      { role: 'assistant', text: 'Found 5 concrete leaks.' },
      { role: 'user', text: 'Now implement phase 2 governance' },
      { role: 'assistant', text: 'Implementing offload gate and checkpoint reset.' },
      { role: 'user', text: 'Verify tests' },
    ]
    const first = compactSession.call(host, session, {
      loadHistoryMessages: async () => {
        await loadGate
        return history
      },
    })
    // Concurrent call must fail fast with SESSION_COMPACT_IN_PROGRESS
    const second = await compactSession.call(host, session)
    assert.equal(second.ok, false)
    assert.equal(second.error, 'SESSION_COMPACT_IN_PROGRESS')

    releaseLoad()
    const outcome = await first
    assert.equal(outcome.ok, true)
    assert.equal(outcome.strategy, 'checkpoint_reset')
    assert.equal(shutdownCalled, true)
    assert.equal(clearedId, true)
    assert.equal(host._resumeMap.has(session.sessionKey), false)
    assert.ok((outcome.beforeBytes ?? 0) > (outcome.afterBytes ?? 0))
    assert.ok((outcome.afterBytes ?? 0) <= 8_500)

    // Lock must be released after completion; B6 forbids faking ok:true on empty history
    const third = await compactSession.call(host, session, {
      loadHistoryMessages: async () => [],
    })
    assert.equal(third.ok, false)
    assert.equal(third.error, 'NO_HISTORY_TO_COMPACT')
    clearPendingCheckpoint(session.sessionKey)
  })

  it('bounds buildRollingCheckpointSummary strictly <= 8000 chars', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `Turn ${i}: ${'你好世界'.repeat(1500)}`,
    }))
    const cp = buildRollingCheckpointSummary(msgs, 'preserve architecture decisions')
    assert.ok(cp.summary.length <= 8_000)
    assert.ok(cp.beforeBytes > cp.afterBytes)
  })

  it('OCV5-885 anchored_v2 preserves mid-session negative redlines, tail constraints, and factual anchors lost by legacy_head_tail', () => {
    const longTailFirstUser =
      `帮我排查网关性能问题，下面是背景日志说明：${'背景细节补充。'.repeat(130)}最后强调红线：切勿上传原始数据到公网，也不要改动 /opt/openclaude/harness-gate 目录。`
    const messages = [
      { role: 'user', text: longTailFirstUser },
      { role: 'assistant', text: '收到，开始采集指标。' },
      { role: 'tool', toolName: 'Bash', output: 'LOG_NOISE_'.repeat(1200) },
      {
        role: 'user',
        text: '中段纠偏（OCV5-885）：关联基线提交 a8f3c91d4e72，分支 feat/ctx-anchor-v2，端口 port=8443，预算 budget <= 44000 bytes。严禁修改生产库，也不要 git push 到远端。',
      },
      { role: 'assistant', text: '明白，改为只读分析 packages/gateway/src/sessionLifecycle.ts。' },
      { role: 'tool', toolName: 'Bash', output: 'TRACE_LINE_'.repeat(1200) },
      { role: 'user', text: '继续查看第 2 批指标' },
      { role: 'assistant', text: '第 2 批指标采集完成。' },
      { role: 'tool', toolName: 'Bash', output: 'METRICS_DUMP_'.repeat(1000) },
      { role: 'user', text: '查看最近日志' },
      { role: 'assistant', text: '最近日志无报错。' },
      { role: 'user', text: '准备汇总' },
      { role: 'assistant', text: '正在整理最终报告。' },
    ]

    const legacy = buildLegacyRollingCheckpointSummary(messages, 'keep constraints')
    const v2 = buildRollingCheckpointSummary(messages, 'keep constraints', { mode: 'anchored_v2' })

    assert.ok(v2.summary.length <= 8_000, `anchored_v2 must stay <= 8000 chars, got ${v2.summary.length}`)
    assert.ok(v2.beforeBytes > v2.afterBytes)
    assert.match(v2.summary, /### Mid-Session Constraints & Key Anchors/)

    // Legacy head+tail drops mid-session redlines, tail constraints, and factual anchors
    assert.equal(legacy.summary.includes('严禁修改生产库'), false)
    assert.equal(legacy.summary.includes('a8f3c91d4e72'), false)
    assert.equal(legacy.summary.includes('切勿上传原始数据到公网'), false)

    // anchored_v2 preserves full polarity clauses (negation + constrained action together) and anchors
    assert.ok(v2.summary.includes('严禁修改生产库'), 'mid-session DB redline must survive')
    assert.ok(v2.summary.includes('不要 git push'), 'mid-session git push redline must survive')
    assert.ok(v2.summary.includes('切勿上传原始数据到公网'), 'truncated Turn 1 tail redline must survive')
    assert.ok(v2.summary.includes('/opt/openclaude/harness-gate'), 'truncated tail path must survive')
    assert.ok(v2.summary.includes('OCV5-885'), 'ticket anchor must survive')
    assert.ok(v2.summary.includes('a8f3c91d4e72'), 'short SHA anchor must survive')
    assert.ok(v2.summary.includes('feat/ctx-anchor-v2'), 'branch anchor must survive')
    assert.ok(v2.summary.includes('packages/gateway/src/sessionLifecycle.ts'), 'code path anchor must survive')

    // Neutral checkpoint payload wrapper wording
    const payload = buildRollingCheckpointPayload(v2.summary, '继续下一步') as string
    assert.ok(payload.includes('Earlier session context was compacted into this bounded checkpoint summary'))
    assert.equal(payload.includes('The user compacted this session context'), false)
  })

  it('OCV5-885 Blocker #10: preserves ultra-short Chinese negative redlines (不要发布。 / 严禁push / 只读模式)', () => {
    const messages = [
      { role: 'user', text: '帮我准备本次版本构建脚本和检查清单。' },
      { role: 'assistant', text: '收到，开始准备。' },
      { role: 'user', text: '不要发布。' },
      { role: 'assistant', text: '明白，仅做本地构建，不执行发布。' },
      { role: 'user', text: '严禁push' },
      { role: 'assistant', text: '收到。' },
      { role: 'user', text: '只读模式' },
      { role: 'assistant', text: '已确认只读模式。' },
      { role: 'tool', toolName: 'Bash', output: 'BUILD_LOG_LINE_'.repeat(300) },
      { role: 'user', text: '核对第 1 项产物' },
      { role: 'assistant', text: '第 1 项产物正常。' },
      { role: 'user', text: '核对第 2 项产物' },
      { role: 'assistant', text: '第 2 项产物正常。' },
      { role: 'user', text: '核对第 3 项产物' },
      { role: 'assistant', text: '第 3 项产物正常。' },
    ]
    const cp = buildRollingCheckpointSummary(messages, 'keep short redlines', { mode: 'anchored_v2' })
    assert.ok(cp.summary.includes('不要发布'), `short redline "不要发布。" must survive, got:\n${cp.summary}`)
    assert.ok(cp.summary.includes('严禁push'), 'short redline "严禁push" must survive')
    assert.ok(cp.summary.includes('只读模式'), 'short redline "只读模式" must survive')
  })

  it('requires real compaction confirmation for CCB /compact and rejects busy sessions', async () => {
    const busySession = makeFakeSession({ providerTag: 'ccb', _activeTurnCount: 1 })
    const busyRes = await compactSession.call(makeFakeHost(), busySession)
    assert.equal(busyRes.ok, false)
    assert.equal(busyRes.error, 'SESSION_BUSY')

    const ccbSession = makeFakeSession({ providerTag: 'ccb' })
    ;(ccbSession.runner.capabilities as any).supportsNativeCompact = true
    const unconfirmedHost = makeFakeHost({
      submit: async () => {
        // Runner returns without emitting context_compacted or setting summary
      },
    })
    const unconfirmed = await compactSession.call(unconfirmedHost, ccbSession)
    assert.equal(unconfirmed.ok, false)
    assert.equal(unconfirmed.error, 'COMPACTION_NOT_CONFIRMED')

    const confirmedHost = makeFakeHost({
      submit: async (_s, _text, onEvent) => {
        onEvent?.({ kind: 'context_compacted', strategy: 'native_summary' } as any)
        ccbSession._lastNativeCompactionSummary = 'Preserved decisions and next steps.'
      },
    })
    const confirmed = await compactSession.call(confirmedHost, ccbSession, { instructions: 'keep decisions' })
    assert.equal(confirmed.ok, true)
    assert.equal(confirmed.strategy, 'native_summary')
    assert.match(confirmed.summaryPreview ?? '', /Preserved decisions/)
  })
})

describe('OCV5-840 Large Payload Offload Gate & 5 leakage points', () => {
  it('offloads oversized payloads with 0600 perms, UTF-8 safe truncation, and cleans up artifacts + context refs', async () => {
    const ws = makeTempDir('oc-offload-')
    const big = `HEAD-🚀-${'中文测试数据'.repeat(3000)}-TAIL-✅`
    const res = offloadPayloadIfOversized({
      workspaceDir: ws,
      sessionId: 'sess-1',
      category: 'attachment',
      content: big,
      inlineMaxChars: 2000,
    })
    assert.equal(res.offloaded, true)
    assert.ok(res.artifactPath && existsSync(res.artifactPath))
    assert.equal(statSync(res.artifactPath).mode & 0o777, 0o600)
    assert.equal(readFileSync(res.artifactPath, 'utf8'), big)
    assert.match(res.text, /Full content offloaded to/)

    // UTF-8 safe byte truncation must never emit replacement chars
    const clipped = truncateUtf8Safe('你好世界🚀测试', 7)
    assert.equal(clipped.truncated, true)
    assert.equal(clipped.text.includes('\uFFFD'), false)
    assert.ok(Buffer.byteLength(clipped.text, 'utf8') <= 7)

    // Also create a .openclaude-context-* dir and verify cleanupSessionArtifacts removes both
    const ref = await writeContextReference(ws, 'hello world', 'input.txt')
    assert.equal(existsSync(ref.file), true)
    const cleaned = await cleanupSessionArtifacts(ws)
    assert.ok(cleaned.removedDirs >= 2)
    assert.equal(existsSync(res.artifactPath), false)
    assert.equal(existsSync(ref.file), false)
  })

  it('eliminates double injection in jobTerminal.ts and offloads oversized delegate outputs', () => {
    const marker = 'UNIQUE_DELEGATE_PAYLOAD_SEGMENT_'
    const longOutput = marker + 'A'.repeat(RESULT_REF_MAX + 2500)
    const md = formatJobTerminalMarkdown({
      jobId: 'job-42',
      state: 'completed',
      sessionKey: 'agent:worker:delegate:dm:1',
      parentSessionKey: 'agent:main:webchat:dm:1',
      parentEngine: 'codex',
      callback: 'origin-inject',
      callbackEpoch: 1,
      parallelPolicy: 'all',
      agentId: 'worker',
      resultRef: longOutput,
    })
    // Extract JSON inside <delegate-terminal>...</delegate-terminal>
    const m = /<delegate-terminal[^>]*>\n([\s\S]*?)\n<\/delegate-terminal>/.exec(md)
    assert.ok(m)
    const parsedJson = JSON.parse(m[1]!)
    assert.equal('resultRef' in parsedJson, false, 'JSON metadata must not duplicate resultRef')
    assert.equal(typeof parsedJson.artifactPath, 'string')
    // Marker appears only once in the markdown body
    assert.equal(md.split(marker).length - 1, 1)
  })

  it('offloads sync delegate outputs exceeding 12K chars and caps mcpWebContextServer defaults', () => {
    const ws = makeTempDir('oc-sync-dlg-')
    assert.equal(DEFAULT_MAX_OUTPUT_CHARS, 24_000)
    assert.equal(MAX_OUTPUT_CHARS, 64_000)

    const small = boundSyncDelegateOutput('short ok', { workspaceDir: ws })
    assert.equal(small.offloaded, false)
    assert.equal(small.output, 'short ok')

    const large = boundSyncDelegateOutput('D'.repeat(SYNC_DELEGATE_INLINE_MAX_CHARS + 3000), {
      targetAgentId: 'coder',
      workspaceDir: ws,
    })
    assert.equal(large.offloaded, true)
    assert.ok(large.artifactPath && existsSync(large.artifactPath))
    assert.match(large.output, /Full content offloaded to/)
  })

  it('bounds remoteSwarmRuntime read_board by UTF-8 maxBytes and offloads oversized post_message', async () => {
    const brainDir = makeTempDir('oc-swarm-')
    const rt = new RemoteSwarmRuntime({
      executor: {
        runWorkerTurn: async () => ({ text: 'ok' }),
        releaseWorkerSession: async () => {},
      },
      rootBase: brainDir,
    })
    const sk = 'agent:main:webchat:dm:swarmtest'
    rt.registerSession({
      sessionKey: sk,
      model: 'antigravity-flash',
      workspaceCwd: brainDir,
    })
    // Oversized post_message > 24K chars gets offloaded with warning
    const bigPost = await rt.handleToolCall({
      sessionKey: sk,
      callerMember: 'coordinator',
      tool: 'post_message',
      args: { text: 'Z'.repeat(MAX_SWARM_POST_CHARS + 2000) },
    })
    assert.equal(bigPost.ok, true)
    assert.equal(bigPost.truncated, true)
    assert.equal(typeof bigPost.artifact_path, 'string')

    // Post multiple medium messages and verify read_board enforces maxBytes cleanly without broken UTF-8
    for (let i = 0; i < 6; i += 1) {
      await rt.handleToolCall({
        sessionKey: sk,
        callerMember: 'coordinator',
        tool: 'post_message',
        args: { text: `消息-${i}: ${'你好世界'.repeat(200)}` },
      })
    }
    assert.equal(DEFAULT_READ_BOARD_MAX_BYTES, 32 * 1024)
    const board = (await rt.handleToolCall({
      sessionKey: sk,
      callerMember: 'coordinator',
      tool: 'read_board',
      args: { maxBytes: 4096 },
    })) as { ok: boolean; truncated: boolean; byte_budget_hit: boolean; posts: Array<{ text: string }> }
    assert.equal(board.ok, true)
    assert.equal(board.truncated, true)
    assert.equal(board.byte_budget_hit, true)
    assert.ok(board.posts.length >= 1 && board.posts.length < 7)
    for (const p of board.posts) {
      assert.equal(p.text.includes('\uFFFD'), false)
    }
  })
})

describe('OCV5-840 modelHistory tool decay & window fallback', () => {
  it('decays older (>2 turns) tool & agent-group rows while preserving recent 2 turns intact', () => {
    const oldBigOutput = 'OLD_TOOL_OUT_' + 'X'.repeat(4000)
    const recentBigOutput = 'RECENT_TOOL_OUT_' + 'Y'.repeat(2000)
    const messages = [
      { role: 'user', text: 'Turn 1' },
      { role: 'tool', toolName: 'Bash', inputPreview: 'cat giant.log', output: oldBigOutput },
      {
        role: 'agent-group',
        _delegateAgentId: 'researcher',
        _delegateGoal: 'analyze logs',
        _resultPreview: 'OLD_DELEGATE_' + 'Q'.repeat(3000),
        childBlocks: [
          { kind: 'tool_use', toolName: 'Read' },
          { kind: 'tool_result', output: 'HUGE_CHILD_OUTPUT'.repeat(300) },
        ],
      },
      { role: 'assistant', text: 'Turn 1 answer' },
      { role: 'user', text: 'Turn 2' },
      { role: 'tool', toolName: 'Read', output: recentBigOutput },
      { role: 'assistant', text: 'Turn 2 answer' },
      { role: 'user', text: 'Turn 3' },
      { role: 'assistant', text: 'Turn 3 answer' },
    ]
    const projected = projectModelHistoryForReplay(messages, { recentFullTurns: 2 })
    const oldTool = projected.find((r) => r.role === 'tool' && r.text.includes('Bash'))!
    const oldGroup = projected.find((r) => r.role === 'agent-group')!
    const recentTool = projected.find((r) => r.role === 'tool' && r.text.includes('Read'))!
    assert.equal(oldTool.decayed, true)
    assert.ok(oldTool.text.length < 1000)
    assert.match(oldTool.text, /older output decayed/)
    assert.equal(oldGroup.decayed, true)
    assert.ok(oldGroup.text.length < 1500)
    assert.equal(recentTool.decayed, false)
    assert.ok(recentTool.text.includes(recentBigOutput))
  })

  it('bounds null contextWindow for antigravity/ccb/zcode and reserves realistic headroom', () => {
    assert.equal(resolveModelHistoryContextWindow(null, 'antigravity'), 200_000)
    assert.equal(resolveModelHistoryContextWindow(null, 'ccb'), 200_000)
    assert.equal(resolveEffectiveModelHistoryContextWindow(undefined, undefined), 200_000)
    assert.equal(modelHistoryReservedTokens('antigravity'), 16_256)
    assert.equal(modelHistoryReservedTokens('cursor'), 16_256)
    assert.equal(modelHistoryReservedTokens(undefined), 256)
  })
})

describe('OCV5-840 Control-Plane HTTP API, bridgeApiAllowlist sync & metrics', () => {
  it('serves context-health, hygiene run/history, memory & skill archive/restore end-to-end', async () => {
    const root = makeTempDir('oc-ctx-api-')
    const agentDir = join(root, 'agents', 'main')
    const memDir = join(agentDir, 'memory')
    const skillsDir = join(root, 'skills')
    const skillDir = join(skillsDir, 'demo-skill')
    mkdirSync(memDir, { recursive: true })
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Rules\nStay crisp.\n', 'utf8')
    writeFileSync(
      join(memDir, 'old_note.md'),
      '---\nname: Old Note\ndescription: Expired entry\ntype: project\nexpires: 2020-01-01\n---\nStale body\n',
      'utf8',
    )
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: demo-skill\ndescription: Demo skill\n---\n# Demo\n',
      'utf8',
    )
    const deps = {
      agentDir: () => agentDir,
      skillsDir,
      userProfilePath: join(root, 'user.md'),
      getSessionsDb: async () => undefined,
    }

    // 1. GET /context-health
    const rHealth = mockRes()
    await handleAgentContextHealth(mockReq('GET'), rHealth.res, 'main', new URL('http://x/api/agents/main/context-health'), deps)
    assert.equal(rHealth.statusCode(), 200)
    assert.equal(rHealth.json().agentId, 'main')
    assert.equal(rHealth.json().summary.expiredMemoryCount, 1)

    // 2. POST /context-hygiene/run (dryRun=false archives expired memory)
    const rRun = mockRes()
    await handleAgentContextHygieneRun(mockReq('POST', { dryRun: false, archiveExpiredMemories: true, decayArchival: false }), rRun.res, 'main', deps)
    assert.equal(rRun.statusCode(), 200)
    assert.equal(rRun.json().ok, true)
    assert.equal(rRun.json().run.expiredMemoriesArchived, 1)

    // 3. GET /context-hygiene/history
    const rHist = mockRes()
    await handleAgentContextHygieneHistory(mockReq('GET'), rHist.res, 'main', new URL('http://x/api/agents/main/context-hygiene/history'), deps)
    assert.equal(rHist.statusCode(), 200)
    assert.equal(rHist.json().runs.length, 1)

    // 4. GET /memory/archive & POST /memory/archive/restore
    const rMemArch = mockRes()
    await handleAgentMemoryArchive(mockReq('GET'), rMemArch.res, 'main', deps)
    assert.equal(rMemArch.statusCode(), 200)
    assert.equal(rMemArch.json().items.length, 1)
    const archivedId = rMemArch.json().items[0].id

    const rMemRest = mockRes()
    await handleAgentMemoryArchiveRestore(mockReq('POST', { id: archivedId }), rMemRest.res, 'main', deps)
    assert.equal(rMemRest.statusCode(), 200)
    assert.equal(rMemRest.json().restored.length, 1)
    assert.equal(existsSync(join(memDir, 'old_note.md')), true)

    // 5. POST /skills/:name/archive -> GET /skills/archive -> POST /skills/archive/restore
    const rSkillArch = mockRes()
    await handleSkillArchiveItem(mockReq('POST', { reason: 'cold' }), rSkillArch.res, 'demo-skill', deps)
    assert.equal(rSkillArch.statusCode(), 200)
    assert.equal(rSkillArch.json().ok, true)

    const rSkillList = mockRes()
    await handleSkillsArchiveList(mockReq('GET'), rSkillList.res, deps)
    assert.equal(rSkillList.statusCode(), 200)
    assert.equal(rSkillList.json().items.length, 1)

    const rSkillRest = mockRes()
    await handleSkillsArchiveRestore(mockReq('POST', { name: 'demo-skill' }), rSkillRest.res, deps)
    assert.equal(rSkillRest.statusCode(), 200)
    assert.equal(rSkillRest.json().restored.length, 1)
    assert.equal(existsSync(join(skillDir, 'SKILL.md')), true)
  })

  it('registers every new control-plane HTTP route in bridgeApiAllowlist with commercial proxy', () => {
    const routes: Array<[string, string]> = [
      ['GET', '/api/agents/main/context-health'],
      ['POST', '/api/agents/main/context-hygiene/run'],
      ['GET', '/api/agents/main/context-hygiene/history'],
      ['GET', '/api/agents/main/memory/archive'],
      ['POST', '/api/agents/main/memory/archive'],
      ['POST', '/api/agents/main/memory/archive/restore'],
      ['GET', '/api/skills/archive'],
      ['POST', '/api/skills/demo-skill/archive'],
      ['POST', '/api/skills/archive/restore'],
      ['POST', '/api/board/projects/proj-1/memories/note.md/restore'],
    ]
    for (const [method, path] of routes) {
      assert.ok(matchBridgeApiAllowlist(path, method), `allowlist missing ${method} ${path}`)
      assert.ok(matchCommercialContainerApiProxy(path, method), `commercial proxy missing ${method} ${path}`)
    }
  })

  it('exposes all 4 context governance counters in Prometheus metrics output', () => {
    const text = serializeMetrics()
    assert.match(text, /oc_context_pressure_total/)
    assert.match(text, /oc_context_compactions_total/)
    assert.match(text, /oc_context_rebuilds_total/)
    assert.match(text, /oc_context_payload_offloads_total/)
  })
})

describe('OCV5-840 Runtime wiring (P0-1 replay decay, P0-2 checkpoint consume, P0-4 pressure tokens/breakdown)', () => {
  it('P0-1: buildHistoricalContextPrompt decays old (>2 turns) tool outputs while keeping recent 2 turns intact', () => {
    const hugeOld = 'OLD_TOOL_BLOB_'.repeat(600)
    const recentTool = 'RECENT_TOOL_EXACT_'.repeat(60)
    const messages = [
      { role: 'user', text: 'turn 1' },
      { role: 'tool', toolName: 'Bash', output: hugeOld },
      { role: 'assistant', text: 'ans 1' },
      { role: 'user', text: 'turn 2' },
      { role: 'assistant', text: 'ans 2' },
      { role: 'user', text: 'turn 3' },
      { role: 'tool', toolName: 'Read', output: recentTool },
      { role: 'assistant', text: 'ans 3' },
      { role: 'user', text: 'next question', status: 'sending' },
    ]
    const prompt = buildHistoricalContextPrompt(messages, 'next question')
    assert.ok(prompt)
    assert.match(prompt!, /older output decayed/)
    assert.ok(prompt!.includes(recentTool), 'recent turn tool output must remain full fidelity')
    assert.ok(!prompt!.includes(hugeOld), 'older (>2 turns) huge tool output must be decayed')
  })

  it('P0-2: checkpoint_reset saves bounded summary on session and next turn consumes it once instead of raw history', async () => {
    const session = makeFakeSession({ providerTag: 'antigravity' })
    const host = makeFakeHost()
    const hugeRaw = 'RAW_UNCOMPACTED_LOG_'.repeat(1_500)
    const history = [
      { role: 'user', text: 'Investigate memory leak' },
      { role: 'tool', toolName: 'Bash', output: hugeRaw },
      { role: 'assistant', text: 'Isolated leak in offload gate.' },
      { role: 'user', text: 'Fix it' },
      { role: 'assistant', text: 'Applied patch.' },
      { role: 'user', text: 'Continue verification' },
    ]
    const outcome = await compactSession.call(host, session, {
      loadHistoryMessages: async () => history,
    })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.strategy, 'checkpoint_reset')
    const peeked = peekPendingCheckpointSummary(session)
    assert.ok(peeked && peeked.includes('## Rolling Context Checkpoint'))
    assert.ok(peeked.length <= 8_000)

    const consumed = consumePendingCheckpointSummary(session)
    assert.equal(consumed, peeked)
    assert.equal(consumePendingCheckpointSummary(session), null, 'checkpoint must be one-shot')

    const nextPayload = buildRollingCheckpointPayload(consumed!, 'Now run final tests')
    assert.equal(typeof nextPayload, 'string')
    assert.match(nextPayload as string, /<openclaude_rolling_checkpoint>/)
    assert.match(nextPayload as string, /Now run final tests/)
    assert.ok(!(nextPayload as string).includes(hugeRaw))
  })

  it('P0-4: propagates usedTokens, windowTokens, and breakdown across Codex, CCB parser, and turn enrichment', () => {
    const codexObs: any[] = []
    const codexCtx = new CodexNativeContext((ev) => codexObs.push(ev))
    codexCtx.observeUsage('t-1', {
      threadId: 't-1',
      tokenUsage: { last: { totalTokens: 165_000 }, modelContextWindow: 200_000 },
    })
    assert.equal(codexObs.length, 1)
    assert.equal(codexObs[0].pressure.usedTokens, 165_000)
    assert.equal(codexObs[0].pressure.windowTokens, 200_000)
    assert.equal(codexObs[0].pressure.level, 'warning')

    const parsedCcb = parseCcbContextObservation({
      kind: 'context_pressure',
      pressure: {
        engine: 'claude-code',
        scope: 'native_context',
        dimension: 'transport_bytes',
        level: 'warning',
        usedRatio: 0.85,
        usedTokens: 170_000,
        windowTokens: 200_000,
        breakdown: { systemBytes: 4000, memoryBytes: 2000, skillsBytes: 1000, projectBytes: 500, historyBytes: 50_000, toolsBytes: 8000 },
        secretLeak: '/etc/passwd',
      },
    })
    assert.ok(parsedCcb && parsedCcb.kind === 'context_pressure')
    assert.equal(parsedCcb.pressure.usedTokens, 170_000)
    assert.equal(parsedCcb.pressure.windowTokens, 200_000)
    assert.equal(parsedCcb.pressure.breakdown?.memoryBytes, 2000)
    assert.equal('secretLeak' in parsedCcb.pressure, false)

    const enriched = enrichContextPressure(
      {
        engine: 'ccb',
        scope: 'native_context',
        dimension: 'tokens',
        level: 'warning',
        usedRatio: 0.82,
      },
      {
        agentId: 'main',
        engine: 'ccb',
        modelContextWindow: 200_000,
        observedTokens: 164_000,
        toolsBytes: 12_000,
        appliedSlots: [
          { name: 'SOUL', bytes: 2_000 },
          { name: 'MEMORY', bytes: 6_000 },
          { name: 'SKILLS', bytes: 3_000 },
          { name: 'PROJECT', bytes: 4_000 },
        ],
      },
    )
    assert.equal(enriched.usedTokens, 164_000)
    assert.equal(enriched.windowTokens, 200_000)
    assert.equal(enriched.breakdown?.systemBytes, 2_000)
    assert.equal(enriched.breakdown?.memoryBytes, 6_000)
    assert.equal(enriched.breakdown?.skillsBytes, 3_000)
    assert.equal(enriched.breakdown?.projectBytes, 4_000)
    assert.equal(enriched.breakdown?.toolsBytes, 12_000)
    assert.ok((enriched.breakdown?.historyBytes ?? 0) > 0)
  })
})

describe('OCV5-840 T2 Blocker Counter-Examples (B1/B2 API, B3, B4, B5, B6, B7, B8, B9)', () => {
  function makeRealSubmitHost(
    session: AgentSession,
    runOneTurnImpl: (s: AgentSession, payload: unknown) => Promise<void>,
  ): SessionSubmitHost {
    return {
      sessions: new Map([[session.sessionKey, session]]),
      _resumeMap: new Map(),
      _resumeMapTimestamps: new Map(),
      _resumeMapProvider: new Map(),
      _resumeMapLastCost: new Map(),
      _resumeMapCostImprecise: new Map(),
      _resumeMapHistory: new Map(),
      _promptQueueExecutions: new Set(),
      _promptQueueExecutionKeys: new Set(),
      _promptQueueDispatchFences: new Set(),
      _pendingExternalExchanges: new Map(),
      _saveResumeMap: () => {},
      awaitResumeMapFlush: async () => {},
      _cursorWorkspacePathForSession: () => '/tmp',
      _ccbJsonlExists: () => true,
      isRuntimeRecycleDraining: () => false,
      _ownsPromptQueueExecutionFence: () => true,
      applyIdleResetIfRequested: async () => {},
      _resolveDurableResumeId: () => undefined,
      _resumeIdFor: () => undefined,
      _trackPersistence: () => {},
      runOneTurnWithRetry: async (s: AgentSession, payload: unknown) => {
        await runOneTurnImpl(s, payload)
      },
      getOrCreate: async () => session,
    } as unknown as SessionSubmitHost
  }

  it('B1/B2 API: ignores caller-supplied batchId and forwards exact pruneSkillHistoryNames without pruning unselected skills', async () => {
    const root = makeTempDir('oc-b1b2-api-')
    const agentDir = join(root, 'agents', 'main')
    const memDir = join(agentDir, 'memory')
    const skillsDir = join(root, 'skills')
    mkdirSync(memDir, { recursive: true })
    for (const sk of ['alpha', 'beta']) {
      const hDir = join(skillsDir, sk, 'history')
      mkdirSync(hDir, { recursive: true })
      writeFileSync(join(skillsDir, sk, 'SKILL.md'), `---\nname: ${sk}\n---\n# ${sk}\n`)
      for (let i = 1; i <= 6; i++) {
        writeFileSync(join(hDir, `1.0.${i}.md`), `v${i}-${sk}`)
      }
    }
    const deps = {
      agentDir: () => agentDir,
      userProfilePath: join(root, 'user.md'),
      skillsDir,
      getSessionsDb: async () => undefined,
    }

    // B1 API: two consecutive archives with identical caller batchId must get distinct server batchIds & preserve v1
    writeFileSync(join(memDir, 'same.md'), 'VERSION-ONE')
    const r1 = mockRes()
    await handleAgentMemoryArchive(mockReq('POST', { files: ['same.md'], batchId: 'attacker-batch' }), r1.res, 'main', deps)
    assert.equal(r1.statusCode(), 200)
    const b1 = r1.json().batchId
    assert.notEqual(b1, 'attacker-batch')

    writeFileSync(join(memDir, 'same.md'), 'VERSION-TWO')
    const r2 = mockRes()
    await handleAgentMemoryArchive(mockReq('POST', { files: ['same.md'], batchId: 'attacker-batch' }), r2.res, 'main', deps)
    assert.equal(r2.statusCode(), 200)
    assert.notEqual(r2.json().batchId, b1)

    // B2 API: exact pruneSkillHistoryNames=['alpha'] prunes alpha to 5 versions while leaving beta untouched at 6
    const rPrune = mockRes()
    await handleAgentContextHygieneRun(
      mockReq('POST', { dryRun: false, pruneSkillHistory: true, pruneSkillHistoryNames: ['alpha'], decayArchival: false }),
      rPrune.res,
      'main',
      deps,
    )
    assert.equal(rPrune.statusCode(), 200)
    assert.equal(rPrune.json().run.skillHistoriesPruned, 1)
    const { readdirSync } = await import('node:fs')
    assert.equal(readdirSync(join(skillsDir, 'alpha', 'history')).length, 5)
    assert.equal(readdirSync(join(skillsDir, 'beta', 'history')).length, 6)
  })

  it('B3: rejects concurrent normal submit() during compactSession history load barrier so shutdown cannot interrupt it', async () => {
    const ckptDir = makeTempDir('oc-b3-ckpt-')
    const session = makeFakeSession({
      sessionKey: 'agent:main:webchat:dm:b3-race',
      providerTag: 'antigravity',
    })
    let shutdownCalls = 0
    ;(session.runner as any).shutdown = async () => {
      shutdownCalls += 1
    }
    const lifecycleHost = makeFakeHost()
    let releaseLoad!: () => void
    const loadGate = new Promise<void>((r) => {
      releaseLoad = r
    })
    const history = [
      { role: 'user', text: 'First turn' },
      { role: 'tool', toolName: 'Bash', output: 'Z'.repeat(12_000) },
      { role: 'assistant', text: 'Done' },
    ]
    const compactPromise = compactSession.call(lifecycleHost, session, {
      checkpointDir: ckptDir,
      loadHistoryMessages: async () => {
        await loadGate
        return history
      },
    })
    assert.equal(isSessionCompacting(session.sessionKey), true)

    let submitRunnerEntered = false
    const submitHost = makeRealSubmitHost(session, async () => {
      submitRunnerEntered = true
    })
    await assert.rejects(
      () => submit.call(submitHost, session, 'concurrent user message', () => {}),
      /SESSION_COMPACT_IN_PROGRESS/,
    )
    assert.equal(submitRunnerEntered, false)

    releaseLoad()
    const outcome = await compactPromise
    assert.equal(outcome.ok, true)
    assert.equal(shutdownCalls, 1)
    assert.equal(isSessionCompacting(session.sessionKey), false)
    clearPendingCheckpoint(session.sessionKey, ckptDir)
  })

  it('B4: isolates artifacts & context references by full sessionKey so destroying agent A preserves sibling agent B', async () => {
    const ws = makeTempDir('oc-b4-shared-peer-')
    const keyA = 'agent:alpha:webchat:dm:shared-peer-1'
    const keyB = 'agent:beta:webchat:dm:shared-peer-1'
    const payloadA = `ALPHA_PAYLOAD_${'A'.repeat(4_000)}`
    const payloadB = `BETA_PAYLOAD_${'B'.repeat(4_000)}`

    const offA = offloadPayloadIfOversized({
      workspaceDir: ws,
      sessionKey: keyA,
      sessionId: 'shared-peer-1',
      category: 'attachment',
      content: payloadA,
      inlineMaxChars: 1_000,
    })
    const offB = offloadPayloadIfOversized({
      workspaceDir: ws,
      sessionKey: keyB,
      sessionId: 'shared-peer-1',
      category: 'attachment',
      content: payloadB,
      inlineMaxChars: 1_000,
    })
    const refA = await writeContextReference(ws, 'REF-A-SECRET', 'a.txt', undefined, keyA)
    const refB = await writeContextReference(ws, 'REF-B-SECRET', 'b.txt', undefined, keyB)

    assert.ok(offA.artifactPath && existsSync(offA.artifactPath))
    assert.ok(offB.artifactPath && existsSync(offB.artifactPath))
    assert.ok(existsSync(refA.file) && existsSync(refB.file))

    // Destroy ONLY session A
    await cleanupSessionArtifacts(ws, keyA)

    assert.equal(existsSync(offA.artifactPath!), false, 'session A artifact must be removed')
    assert.equal(existsSync(refA.file), false, 'session A context ref must be removed')
    assert.equal(existsSync(offB.artifactPath!), true, 'sibling agent B artifact must survive')
    assert.equal(readFileSync(offB.artifactPath!, 'utf8'), payloadB)
    assert.equal(existsSync(refB.file), true, 'sibling agent B context ref must survive')
    assert.equal(readFileSync(refB.file, 'utf8'), 'REF-B-SECRET')

    // N2: symlinked artifacts root must be rejected (fail-open with artifactPath=undefined)
    const symWs = makeTempDir('oc-n2-symlink-')
    const outsideDir = makeTempDir('oc-n2-outside-')
    symlinkSync(outsideDir, join(symWs, '.openclaude-artifacts'))
    const blocked = offloadPayloadIfOversized({
      workspaceDir: symWs,
      sessionKey: keyA,
      category: 'attachment',
      content: payloadA,
      inlineMaxChars: 1_000,
    })
    assert.equal(blocked.offloaded, true)
    assert.equal(blocked.artifactPath, undefined)
  })

  it('B5: enforces strict WS sessionKey targeting & side-effect-free rejections (0 ring writes / 0 frameSeq advance)', async () => {
    const sessA = makeFakeSession({
      sessionKey: 'agent:alpha:webchat:dm:peer-1',
      agentId: 'alpha',
      peerId: 'peer-1',
      userId: 'u1',
      ccbSessionId: 'resume-A-keep',
    })
    const sessB = makeFakeSession({
      sessionKey: 'agent:beta:webchat:dm:peer-1',
      agentId: 'beta',
      peerId: 'peer-1',
      userId: 'u1',
      ccbSessionId: 'resume-B-keep',
    })
    let compactCalledFor: string | null = null
    const stampedFrames: Array<{ sessionKey: string; frame: Record<string, unknown> }> = []
    const directFrames: Array<Record<string, unknown>> = []
    const fakeWs = {
      readyState: WebSocket.OPEN,
      send: (raw: string) => {
        directFrames.push(JSON.parse(raw))
      },
    }
    const fakeLog = { info: () => {}, error: () => {} }
    const makeSessionsMap = (list: AgentSession[]) => ({
      getByKey: (k: string) => list.find((s) => s.sessionKey === k),
      list: () => list.map((s) => ({ sessionKey: s.sessionKey })),
    })
    const stubCompact = (async function (this: unknown, s: AgentSession) {
      compactCalledFor = s.sessionKey
      return { ok: true, supported: true, engine: s.providerTag, strategy: 'checkpoint_reset' as const }
    }) as unknown as typeof compactSession

    // 1. Explicit sessionKey for non-live beta + peer-1 must NOT fall back to live alpha!
    await handleControlSessionCompactFrame({
      ws: fakeWs,
      userId: 'u1',
      frame: { sessionKey: 'agent:beta:webchat:dm:peer-1', sessionId: 'peer-1', requestId: 'req-1' },
      sessions: makeSessionsMap([sessA]),
      clientsByPeer: new Map(),
      sendStampedSessionFrame: (sk, _pk, f) => stampedFrames.push({ sessionKey: sk, frame: f }),
      log: fakeLog,
      compactImpl: stubCompact,
    })
    assert.equal(compactCalledFor, null)
    assert.equal(sessA.ccbSessionId, 'resume-A-keep')
    assert.equal(stampedFrames.length, 0, 'rejection must NEVER touch any session replay ring')
    assert.equal(directFrames.at(-1)?.error, 'SESSION_NOT_FOUND')

    // 2. Explicit sessionKey with conflicting sessionId -> SESSION_TARGET_MISMATCH, 0 ring writes
    await handleControlSessionCompactFrame({
      ws: fakeWs,
      userId: 'u1',
      frame: { sessionKey: sessA.sessionKey, sessionId: 'wrong-peer', requestId: 'req-2' },
      sessions: makeSessionsMap([sessA]),
      clientsByPeer: new Map(),
      sendStampedSessionFrame: (sk, _pk, f) => stampedFrames.push({ sessionKey: sk, frame: f }),
      log: fakeLog,
      compactImpl: stubCompact,
    })
    assert.equal(compactCalledFor, null)
    assert.equal(stampedFrames.length, 0)
    assert.equal(directFrames.at(-1)?.error, 'SESSION_TARGET_MISMATCH')

    // 3. Missing sessionKey when BOTH alpha and beta are live for peer-1 -> SESSION_AMBIGUOUS, 0 ring writes
    await handleControlSessionCompactFrame({
      ws: fakeWs,
      userId: 'u1',
      frame: { sessionId: 'peer-1', requestId: 'req-3' },
      sessions: makeSessionsMap([sessA, sessB]),
      clientsByPeer: new Map(),
      sendStampedSessionFrame: (sk, _pk, f) => stampedFrames.push({ sessionKey: sk, frame: f }),
      log: fakeLog,
      compactImpl: stubCompact,
    })
    assert.equal(compactCalledFor, null)
    assert.equal(stampedFrames.length, 0)
    assert.equal(directFrames.at(-1)?.error, 'SESSION_AMBIGUOUS')

    // 4. Foreign user -> SESSION_FORBIDDEN, 0 ring writes
    await handleControlSessionCompactFrame({
      ws: fakeWs,
      userId: 'u2-attacker',
      frame: { sessionKey: sessA.sessionKey, sessionId: 'peer-1', requestId: 'req-4' },
      sessions: makeSessionsMap([sessA]),
      clientsByPeer: new Map(),
      sendStampedSessionFrame: (sk, _pk, f) => stampedFrames.push({ sessionKey: sk, frame: f }),
      log: fakeLog,
      compactImpl: stubCompact,
    })
    assert.equal(compactCalledFor, null)
    assert.equal(stampedFrames.length, 0)
    assert.equal(directFrames.at(-1)?.error, 'SESSION_FORBIDDEN')
  })

  it('B6: never fakes success on CCB compacting->error, history read throw, or empty container rows on active native session', async () => {
    // 1. CCB emits compacting status followed by error -> COMPACTION_NOT_CONFIRMED
    const ccbSession = makeFakeSession({ providerTag: 'ccb' })
    ;(ccbSession.runner.capabilities as any).supportsNativeCompact = true
    const ccbFailHost = makeFakeHost({
      submit: async (_s, _p, onEvent) => {
        onEvent?.({ kind: 'turn_status', status: 'compacting' } as any)
        onEvent?.({ kind: 'error', error: 'upstream 500 during compact' } as any)
      },
    })
    const ccbRes = await compactSession.call(ccbFailHost, ccbSession)
    assert.equal(ccbRes.ok, false)
    assert.equal(ccbRes.error, 'COMPACTION_NOT_CONFIRMED')

    // 2. Checkpoint history read throws -> HISTORY_UNAVAILABLE, runner NOT shut down, resumeMap intact
    let shutdownCalled = false
    const agSession = makeFakeSession({
      sessionKey: 'agent:main:webchat:dm:b6-err',
      providerTag: 'antigravity',
      ccbSessionId: 'native-still-valid',
    })
    ;(agSession.runner as any).shutdown = async () => {
      shutdownCalled = true
    }
    const agHost = makeFakeHost()
    agHost._resumeMap.set(agSession.sessionKey, 'native-still-valid')
    const throwRes = await compactSession.call(agHost, agSession, {
      loadHistoryMessages: async () => {
        throw new Error('SQLITE_BUSY')
      },
    })
    assert.equal(throwRes.ok, false)
    assert.equal(throwRes.error, 'HISTORY_UNAVAILABLE')
    assert.equal(shutdownCalled, false)
    assert.equal(agHost._resumeMap.get(agSession.sessionKey), 'native-still-valid')

    // 3. Container SQLite returns [] while active native resume exists (master PG gap) -> HISTORY_UNAVAILABLE
    const masterGapRes = await compactSession.call(agHost, agSession, {
      loadHistoryMessages: async () => [],
    })
    assert.equal(masterGapRes.ok, false)
    assert.equal(masterGapRes.error, 'HISTORY_UNAVAILABLE')
    assert.equal(shutdownCalled, false)
    assert.equal(agHost._resumeMap.get(agSession.sessionKey), 'native-still-valid')
  })

  it('B7: persists 0600 checkpoint across AgentSession rebuild, preserves on failed submit, and acks ONLY after engine success', async () => {
    const key = `agent:main:webchat:dm:b7-durable-${Date.now()}`
    const session1 = makeFakeSession({ sessionKey: key, providerTag: 'antigravity' })
    const host1 = makeFakeHost()
    const hugeRaw = 'RAW_UNCOMPACTED_B7_'.repeat(1_200)
    const history = [
      { role: 'user', text: 'Audit B7 durability' },
      { role: 'tool', toolName: 'Bash', output: hugeRaw },
      { role: 'assistant', text: 'Persisting checkpoint before reset.' },
    ]
    const outcome = await compactSession.call(host1, session1, {
      loadHistoryMessages: async () => history,
    })
    assert.equal(outcome.ok, true)
    const ckptPath = checkpointFilePath(key)
    assert.equal(existsSync(ckptPath), true)
    assert.equal(statSync(ckptPath).mode & 0o777, 0o600)
    const saved = peekPendingCheckpoint(key)
    assert.ok(saved && saved.summary.includes('## Rolling Context Checkpoint'))

    // Simulate gateway restart / eviction -> brand new AgentSession object with same sessionKey
    const rebuiltFailSession = makeFakeSession({ sessionKey: key, providerTag: 'antigravity', ccbSessionId: null })
    let failAttemptPayload = ''
    const failSubmitHost = makeRealSubmitHost(rebuiltFailSession, async (_s, payload) => {
      failAttemptPayload = String(payload)
      throw new Error('RUNNER_START_FAILED')
    })
    await assert.rejects(
      () => submit.call(failSubmitHost, rebuiltFailSession, 'Next turn attempt 1', () => {}),
      /RUNNER_START_FAILED/,
    )
    assert.match(failAttemptPayload, /<openclaude_rolling_checkpoint>/)
    assert.ok(!failAttemptPayload.includes(hugeRaw))
    // Checkpoint MUST still exist on disk after failure!
    assert.ok(peekPendingCheckpoint(key), 'checkpoint must survive pre-start / execution failure')
    assert.equal(rebuiltFailSession._historicalContextInjected, false)

    // Retry on ANOTHER rebuilt AgentSession -> succeeds -> checkpoint is delivered AND acked/deleted
    const rebuiltOkSession = makeFakeSession({ sessionKey: key, providerTag: 'antigravity', ccbSessionId: null })
    let okAttemptPayload = ''
    const okSubmitHost = makeRealSubmitHost(rebuiltOkSession, async (s, payload) => {
      okAttemptPayload = String(payload)
      markCheckpointTurnOutcome(s, 'completed')
    })
    await submit.call(okSubmitHost, rebuiltOkSession, 'Next turn attempt 2', () => {})
    assert.match(okAttemptPayload, /<openclaude_rolling_checkpoint>/)
    assert.match(okAttemptPayload, /Next turn attempt 2/)
    assert.ok(!okAttemptPayload.includes(hugeRaw))
    assert.equal(peekPendingCheckpoint(key), null, 'checkpoint must be deleted after engine success')
    assert.equal(existsSync(ckptPath), false)
    // Stale ack is a safe no-op
    assert.equal(ackPendingCheckpoint(key, saved!.generation), false)
  })

  it('B8: remote Codex reset preserves lane (never calls terminal shutdown) and CursorSand/remote CCB never emit unbilled /compact turns', async () => {
    const ckptDir = makeTempDir('oc-b8-ckpt-')
    const history = [
      { role: 'user', text: 'Remote codex task' },
      { role: 'tool', toolName: 'Bash', output: 'R'.repeat(12_000) },
      { role: 'assistant', text: 'Step done' },
    ]

    // 1. Remote Codex lane safety
    let laneClosed = false
    let restartConfigCalls = 0
    let terminalShutdownCalls = 0
    let clearedThread = false
    const remoteCodex = makeFakeSession({
      sessionKey: 'agent:main:webchat:dm:b8-remote-codex',
      providerTag: 'codex',
      runner: Object.assign(new EventEmitter(), {
        engineId: 'codex',
        isRunning: true,
        executionBackend: { kind: 'codex-app-server-v1', nodeId: 'n1', credentialId: 'c1' },
        capabilities: {
          billingMode: 'engine-reported',
          supportsEffort: true,
          resumeKind: 'codex-thread',
          needsServerRequestId: true,
          historyMode: 'native-resume',
          permissionModel: 'native',
          emitsCallUsage: true,
          emitsToolInputDeltas: true,
          supportsNativeCompact: true,
          multimodalInput: 'native',
        },
        restartForConfigChange: async () => {
          restartConfigCalls += 1
        },
        shutdown: async () => {
          terminalShutdownCalls += 1
          laneClosed = true
        },
        clearSessionId: () => {
          clearedThread = true
        },
      }) as unknown as AgentSession['runner'],
    })
    const codexRes = await compactSession.call(makeFakeHost(), remoteCodex, {
      checkpointDir: ckptDir,
      loadHistoryMessages: async () => history,
    })
    assert.equal(codexRes.ok, true)
    assert.equal(codexRes.strategy, 'checkpoint_reset')
    assert.equal(terminalShutdownCalls, 0, 'remote Codex MUST NOT call terminal shutdown()')
    assert.equal(laneClosed, false, 'remote Codex lane MUST stay open for next turn')
    assert.equal(restartConfigCalls, 1)
    assert.equal(clearedThread, true)

    // 2. CursorSand (permissionModel='native', supportsNativeCompact=false) must NOT send unbilled /compact turn
    let sandSubmitCalls = 0
    const cursorSand = makeFakeSession({
      sessionKey: 'agent:main:webchat:dm:b8-cursor-sand',
      providerTag: 'cursor',
      runner: Object.assign(new EventEmitter(), {
        engineId: 'cursor',
        isRunning: true,
        capabilities: {
          billingMode: 'external',
          supportsEffort: false,
          resumeKind: 'cursor-session',
          needsServerRequestId: false,
          historyMode: 'native-resume',
          permissionModel: 'native',
          emitsCallUsage: true,
          emitsToolInputDeltas: true,
          supportsNativeCompact: false,
          multimodalInput: 'native',
        },
        shutdown: async () => {},
        clearSessionId: () => {},
      }) as unknown as AgentSession['runner'],
    })
    const sandRes = await compactSession.call(
      makeFakeHost({ submit: async () => { sandSubmitCalls += 1 } }),
      cursorSand,
      { checkpointDir: ckptDir, loadHistoryMessages: async () => history },
    )
    assert.equal(sandRes.ok, true)
    assert.equal(sandRes.strategy, 'checkpoint_reset')
    assert.equal(sandSubmitCalls, 0, 'CursorSand MUST NOT invoke unbilled /compact turn')

    // 3. Remote CCB (executionBackend present) must NOT invoke unauthenticated /compact turn
    let remoteCcbSubmitCalls = 0
    const remoteCcb = makeFakeSession({
      sessionKey: 'agent:main:webchat:dm:b8-remote-ccb',
      providerTag: 'ccb',
      runner: Object.assign(new EventEmitter(), {
        engineId: 'ccb',
        isRunning: true,
        executionBackend: { kind: 'cc5-box-v1', nodeId: 'n1' },
        capabilities: {
          billingMode: 'proxy',
          supportsEffort: true,
          resumeKind: 'ccb-session',
          needsServerRequestId: false,
          historyMode: 'native-resume',
          permissionModel: 'native',
          emitsCallUsage: true,
          emitsToolInputDeltas: true,
          supportsNativeCompact: true,
          multimodalInput: 'native',
        },
        shutdown: async () => {},
        clearSessionId: () => {},
      }) as unknown as AgentSession['runner'],
    })
    const remoteCcbRes = await compactSession.call(
      makeFakeHost({ submit: async () => { remoteCcbSubmitCalls += 1 } }),
      remoteCcb,
      { checkpointDir: ckptDir, loadHistoryMessages: async () => history },
    )
    assert.equal(remoteCcbRes.ok, true)
    assert.equal(remoteCcbRes.strategy, 'checkpoint_reset')
    assert.equal(remoteCcbSubmitCalls, 0)
  })

  it('B9: real child extractor produces 45KB text with unique tail marker -> inline compact preview + full artifact containing tail marker', async () => {
    const root = makeTempDir('oc-b9-webctx-')
    const safeRoot = join(root, 'uploads')
    const homeDir = join(root, 'home')
    mkdirSync(safeRoot, { recursive: true })
    mkdirSync(homeDir, { recursive: true })

    const tailMarker = 'UNIQUE_TAIL_MARKER_B9_999'
    const fullDoc = `START_DOC\n${'A'.repeat(45_000)}\n${tailMarker}`
    const docPath = join(safeRoot, 'long-report.txt')
    writeFileSync(docPath, fullDoc, 'utf8')

    // Real executable child process that strictly enforces payload.max_chars (same contract as oc-web-context.py)
    const binPath = join(root, 'fake-web-context.mjs')
    writeFileSync(
      binPath,
      `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
const req = JSON.parse(readFileSync(0, 'utf8'))
const raw = readFileSync(req.file_path, 'utf8')
const cap = Number(req.max_chars) || 24000
const sliced = raw.slice(0, cap)
process.stdout.write(JSON.stringify({ ok: true, markdown: sliced, truncated: raw.length > cap }))
`,
      'utf8',
    )
    chmodSync(binPath, 0o755)

    const prevBin = process.env.OPENCLAUDE_WEB_CONTEXT_BIN
    const prevRoots = process.env.OPENCLAUDE_WEB_CONTEXT_SAFE_ROOTS
    const prevHome = process.env.OPENCLAUDE_HOME
    const prevSess = process.env.OPENCLAUDE_SESSION_KEY
    process.env.OPENCLAUDE_WEB_CONTEXT_BIN = binPath
    process.env.OPENCLAUDE_WEB_CONTEXT_SAFE_ROOTS = safeRoot
    process.env.OPENCLAUDE_HOME = homeDir
    process.env.OPENCLAUDE_SESSION_KEY = 'agent:main:webchat:dm:b9-web'
    try {
      const res = await parseFile({ file_path: docPath, max_chars: 24_000 })
      const md = String(res.markdown ?? '')
      assert.equal(res.truncated, true)
      assert.ok(md.length <= 25_000, `inline markdown must stay compact, got ${md.length}`)
      assert.ok(typeof res.artifact_path === 'string' && existsSync(res.artifact_path))
      assert.equal(statSync(res.artifact_path as string).mode & 0o777, 0o600)
      const fullArtifact = readFileSync(res.artifact_path as string, 'utf8')
      assert.equal(fullArtifact.length, fullDoc.length)
      assert.ok(fullArtifact.includes(tailMarker), 'offloaded artifact MUST contain the full tail marker')
    } finally {
      if (prevBin === undefined) delete process.env.OPENCLAUDE_WEB_CONTEXT_BIN
      else process.env.OPENCLAUDE_WEB_CONTEXT_BIN = prevBin
      if (prevRoots === undefined) delete process.env.OPENCLAUDE_WEB_CONTEXT_SAFE_ROOTS
      else process.env.OPENCLAUDE_WEB_CONTEXT_SAFE_ROOTS = prevRoots
      if (prevHome === undefined) delete process.env.OPENCLAUDE_HOME
      else process.env.OPENCLAUDE_HOME = prevHome
    if (prevSess === undefined) delete process.env.OPENCLAUDE_SESSION_KEY
      else process.env.OPENCLAUDE_SESSION_KEY = prevSess
    }
  })

  it('B4 residual: real prepareBoundedPrompt + resultRefFromSnapshot register full sessionKey and destroySession(A) reclaims both while keeping sibling B', async () => {
    const { paths } = await import('@openclaude/storage')
    const peerId = `b4-res-${Date.now()}`
    const keyA = `agent:alpha:webchat:dm:${peerId}`
    const keyB = `agent:beta:webchat:dm:${peerId}`
    const sessionWs = join(paths.home, 'workspace', 'sessions', peerId)
    mkdirSync(sessionWs, { recursive: true })
    tempDirs.push(sessionWs)

    // 1. Real prepareBoundedPrompt writes oversized input under session A's scope
    const bounded = await prepareBoundedPrompt({
      input: `OVERSIZED_PROMPT_${'P'.repeat(5_000)}`,
      serialize: (s) => s,
      maxBytes: 1_200,
      cwd: sessionWs,
      engine: 'antigravity',
      sessionKey: keyA,
      onEvent: () => {},
    })
    const promptFileMatch = /Input file: "([^"]+)"/.exec(bounded)
    assert.ok(promptFileMatch?.[1] && existsSync(promptFileMatch[1]), 'prepareBoundedPrompt must create input file')
    const promptFileA = promptFileMatch[1]

    // 2. Real resultRefFromSnapshot writes 50KB delegate callback under session A's scope
    const refText = resultRefFromSnapshot({
      id: `job-b4-${Date.now()}`,
      state: 'completed',
      agentId: 'worker',
      sessionKey: 'agent:worker:delegate:dm:child-1',
      parentSessionKey: keyA,
      callback: 'inline',
      callbackEpoch: 1,
      result: { body: { ok: true, output: `DELEGATE_50K_${'D'.repeat(50_000)}` } },
    } as any)
    const delegateMatch = /Full content offloaded to: `([^`]+)`/.exec(refText ?? '')
    assert.ok(delegateMatch?.[1] && existsSync(delegateMatch[1]), 'resultRefFromSnapshot must offload 50KB callback')
    const delegateFileA = delegateMatch[1]

    // 3. Sibling agent B shares same peer workspace
    const payloadB = `SIBLING_B_KEEP_${'B'.repeat(4_000)}`
    const offB = offloadPayloadIfOversized({
      workspaceDir: sessionWs,
      sessionKey: keyB,
      sessionId: peerId,
      category: 'attachment',
      content: payloadB,
      inlineMaxChars: 1_000,
    })
    assert.ok(offB.artifactPath && existsSync(offB.artifactPath))

    // 4. Real destroySession(keyA) (evicted-session branch, matching T2 verification)
    const destroyHost = {
      ...makeFakeHost(),
      _sessionIdToKey: new Map(),
      onSessionDestroyed: () => {},
    } as unknown as SessionLifecycleHost
    await destroySession.call(destroyHost, keyA)

    assert.equal(existsSync(promptFileA), false, 'A boundedPrompt input file MUST be deleted by destroySession(A)')
    assert.equal(existsSync(delegateFileA), false, 'A 50KB delegate callback file MUST be deleted by destroySession(A)')
    assert.equal(existsSync(offB.artifactPath!), true, 'Sibling agent B attachment MUST remain intact')
    assert.equal(readFileSync(offB.artifactPath!, 'utf8'), payloadB)
  })

  it('B6 residual: CCB file_reference sideband without native boundary/summary MUST NOT confirm compaction', async () => {
    const ccbSession = makeFakeSession({
      sessionKey: 'agent:main:webchat:dm:b6-file-ref',
      providerTag: 'ccb',
    })
    ;(ccbSession.runner.capabilities as any).supportsNativeCompact = true
    const fileRefOnlyHost = makeFakeHost({
      submit: async (_s, _p, onEvent) => {
        // Real CCB requestBodyBudget can emit file_reference before model call even when /compact fails locally
        onEvent?.({
          kind: 'context_compacted',
          compaction: {
            engine: 'claude-code',
            scope: 'native_context',
            strategy: 'file_reference',
            beforeBytes: 25_000_000,
            afterBytes: 1_000,
            droppedEntries: 0,
          },
        } as any)
      },
    })
    const res = await compactSession.call(fileRefOnlyHost, ccbSession)
    assert.equal(res.ok, false)
    assert.equal(res.error, 'COMPACTION_NOT_CONFIRMED')
  })

  it('B7 residual: crashed/RUNNER_CRASHED turn that resolves without throwing MUST preserve persisted checkpoint on disk', async () => {
    const key = `agent:main:webchat:dm:b7-crashed-resolve-${Date.now()}`
    const session1 = makeFakeSession({ sessionKey: key, providerTag: 'antigravity' })
    const outcome = await compactSession.call(makeFakeHost(), session1, {
      loadHistoryMessages: async () => [
        { role: 'user', text: 'Preserve on crashed resolve' },
        { role: 'tool', toolName: 'Bash', output: 'C'.repeat(12_000) },
        { role: 'assistant', text: 'Checkpoint saved.' },
      ],
    })
    assert.equal(outcome.ok, true)
    const ckptPath = checkpointFilePath(key)
    assert.equal(existsSync(ckptPath), true)

    // Simulate real `_runOneTurn` settling a `crashed/RUNNER_CRASHED` terminal and resolving (NOT throwing)
    const crashedSession = makeFakeSession({ sessionKey: key, providerTag: 'antigravity', ccbSessionId: null })
    let seenPayload = ''
    const crashedHost = makeRealSubmitHost(crashedSession, async (s, payload) => {
      seenPayload = String(payload)
      markCheckpointTurnOutcome(s, 'failed')
      // Resolves cleanly without throwing — exact behavior of _runOneTurn on RUNNER_CRASHED!
    })
    await submit.call(crashedHost, crashedSession, 'Turn that crashes inside engine', () => {})

    assert.match(seenPayload, /<openclaude_rolling_checkpoint>/)
    assert.equal(existsSync(ckptPath), true, 'persisted checkpoint MUST remain on disk after crashed resolve')
    assert.ok(peekPendingCheckpoint(key), 'peekPendingCheckpoint MUST still return checkpoint for retry')
    assert.equal(crashedSession._historicalContextInjected, false, 'session injection flag MUST reset for retry')

    // Subsequent retry succeeds -> marks 'completed' -> checkpoint is acked and removed
    const okHost = makeRealSubmitHost(crashedSession, async (s) => {
      markCheckpointTurnOutcome(s, 'completed')
    })
    await submit.call(okHost, crashedSession, 'Retry turn succeeds', () => {})
    assert.equal(peekPendingCheckpoint(key), null)
    assert.equal(existsSync(ckptPath), false)
  })
})
