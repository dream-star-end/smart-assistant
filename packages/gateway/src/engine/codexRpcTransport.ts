/**
 * Codex app-server process, launch-override, shutdown, and JSON-RPC stdio transport layer.
 *
 * Extracted from CodexAppServerRunner (codexAppServerRunner.ts) — OCV5-830.
 * The runner keeps non-async one-line forwarders calling these implementations with
 * the instance as `this`, preserving closure semantics, test method overrides, and
 * promise microtask timing.
 */
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexTransportModelId } from '@openclaude/protocol'
import {
  type CodexLaunchOverrides,
  buildCodexLaunchOverrides,
  shouldOmitPlatformMcp,
} from '../codexLaunchOverrides.js'
import type { RepoSnapshot } from '../sessionRepoWorkspace.js'
import { buildAdvisorReadOnlyArgs, readAdvisorReadOnlyConfig } from './codexAdvisorReadOnly.js'
import {
  asRecord,
  isGoalAlreadyClearedError,
  jsonRpcResult,
  type PendingCodexUserInput,
} from './codexAppServerProtocol.js'
import {
  killCodexProcessGroup,
  readLatestCodexNativeHandoff,
  runnerShutdownTimeoutMs,
  waitForCloseWithin,
} from './codexLifecycle.js'
import {
  buildCodexLongContextArgs,
  buildCodexModelCatalogArgs,
  buildCodexMultiAgentDisableArgs,
  buildCodexProviderConfigArgs,
  buildCodexReasoningSummaryArgs,
  buildCodexTelemetryHardeningArgs,
  codexReasoningEffortConfig,
} from './codexShared.js'
import type { NativeModelHandoffArtifact } from './engineAdapter.js'
import { log, type CodexAppServerRunner } from './codexAppServerRunner.js'

const RUNNER_SHUTDOWN_GRACE_DEFAULT_MS = 3_000
const RUNNER_SHUTDOWN_FINAL_DRAIN_DEFAULT_MS = 3_000
const NATIVE_COMPACTION_TIMEOUT_MS = 15 * 60_000

export interface CodexRpcTransportHost {
  opts: CodexAppServerRunner['opts']
  proc: CodexAppServerRunner['proc']
  threadId: CodexAppServerRunner['threadId']
  effortLevel: CodexAppServerRunner['effortLevel']
  lastActivityAt: CodexAppServerRunner['lastActivityAt']
  attached: CodexAppServerRunner['attached']
  initialized: CodexAppServerRunner['initialized']
  initializedPayload: CodexAppServerRunner['initializedPayload']
  shuttingDown: CodexAppServerRunner['shuttingDown']
  processing: CodexAppServerRunner['processing']
  activeTurnId: CodexAppServerRunner['activeTurnId']
  currentCollabAgentPolicy: CodexAppServerRunner['currentCollabAgentPolicy']
  currentTurnCompleter: CodexAppServerRunner['currentTurnCompleter']
  pendingNativeCompaction: CodexAppServerRunner['pendingNativeCompaction']
  pendingRetryAbort: CodexAppServerRunner['pendingRetryAbort']
  pending: CodexAppServerRunner['pending']
  nextRequestId: CodexAppServerRunner['nextRequestId']
  pendingUserInputs: CodexAppServerRunner['pendingUserInputs']
  pendingUserInputIdsByRpc: CodexAppServerRunner['pendingUserInputIdsByRpc']
  queue: CodexAppServerRunner['queue']
  stdoutBuf: CodexAppServerRunner['stdoutBuf']
  outputDrainPromise: CodexAppServerRunner['outputDrainPromise']
  resolveOutputDrain: CodexAppServerRunner['resolveOutputDrain']
  emittedToolUseIds: CodexAppServerRunner['emittedToolUseIds']
  activeTurnTotal: CodexAppServerRunner['activeTurnTotal']
  currentTurnUsage: CodexAppServerRunner['currentTurnUsage']
  nativeContext: CodexAppServerRunner['nativeContext']
  advisorReadOnly: CodexAppServerRunner['advisorReadOnly']
  spawnedAdvisorReadOnly: CodexAppServerRunner['spawnedAdvisorReadOnly']
  advisorReadOnlyConfig: CodexAppServerRunner['advisorReadOnlyConfig']
  platformGoal: CodexAppServerRunner['platformGoal']
  platformGoalInitialized: CodexAppServerRunner['platformGoalInitialized']
  syncedPlatformGoalSignature: CodexAppServerRunner['syncedPlatformGoalSignature']
  syncedPlatformGoal: CodexAppServerRunner['syncedPlatformGoal']
  sessionDir: CodexAppServerRunner['sessionDir']
  hermeticDir: CodexAppServerRunner['hermeticDir']
  cachedOverrides: CodexAppServerRunner['cachedOverrides']
  codexRouteConfig: CodexAppServerRunner['codexRouteConfig']
  spawnedProviderSignature: CodexAppServerRunner['spawnedProviderSignature']
  remoteInstructions: CodexAppServerRunner['remoteInstructions']
  promptPolicy: CodexAppServerRunner['promptPolicy']
  _promptIntelligentUi: CodexAppServerRunner['_promptIntelligentUi']
  _promptPolicyFingerprint: CodexAppServerRunner['_promptPolicyFingerprint']
  _spawnPromise: CodexAppServerRunner['_spawnPromise']
  _preheatPromise: CodexAppServerRunner['_preheatPromise']
  _preheatGeneration: CodexAppServerRunner['_preheatGeneration']
  _unannouncedPreheatThread: CodexAppServerRunner['_unannouncedPreheatThread']
  _preheatedSignature: CodexAppServerRunner['_preheatedSignature']
  relayDeniedTracker: CodexAppServerRunner['relayDeniedTracker']

  emit: CodexAppServerRunner['emit']
  shutdown: CodexAppServerRunner['shutdown']
  clearSessionId: CodexAppServerRunner['clearSessionId']
  resetInitializedState: CodexAppServerRunner['resetInitializedState']
  resetCallUsageAttribution: CodexAppServerRunner['resetCallUsageAttribution']
  cleanupLaunchOverrides: CodexAppServerRunner['cleanupLaunchOverrides']
  cleanupHermeticDir: CodexAppServerRunner['cleanupHermeticDir']
  ensureLaunchOverrides: CodexAppServerRunner['ensureLaunchOverrides']
  codexRouteSignature: CodexAppServerRunner['codexRouteSignature']
  buildInitializeParams: CodexAppServerRunner['buildInitializeParams']
  handleLine: CodexAppServerRunner['handleLine']
  handleStderrChunk: CodexAppServerRunner['handleStderrChunk']
  wakeRetryBackoffOnProcGone: CodexAppServerRunner['wakeRetryBackoffOnProcGone']
  sendRequest: CodexAppServerRunner['sendRequest']
  writeRaw: CodexAppServerRunner['writeRaw']
  isInlinePushProcLive: CodexAppServerRunner['isInlinePushProcLive']
  takePendingUserInput: CodexAppServerRunner['takePendingUserInput']
  settlePendingUserInputsForTurn: CodexAppServerRunner['settlePendingUserInputsForTurn']
  settleAllPendingUserInputs: CodexAppServerRunner['settleAllPendingUserInputs']
  clearPendingUserInputs: CodexAppServerRunner['clearPendingUserInputs']
  emitUserInputWaitStatus: CodexAppServerRunner['emitUserInputWaitStatus']
  clearPendingNativeCompaction: CodexAppServerRunner['clearPendingNativeCompaction']
  platformGoalSignature: CodexAppServerRunner['platformGoalSignature']
  _ensureSpawnedRemote: CodexAppServerRunner['_ensureSpawnedRemote']
  getSpawnFn(): typeof spawn
  getHostProcessEnv(): NodeJS.ProcessEnv
  buildCodexSpawnEnv(): NodeJS.ProcessEnv
  resolveChatgptRelayBaseUrl(): string | undefined
  onTransportProcessClose(
    proc: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
    remote: boolean,
  ): void
}

export function platformGoalSignature(this: CodexRpcTransportHost): string {
  const goal = this.platformGoal
  if (!goal || goal.status === 'cleared') return 'cleared'
  return JSON.stringify({
    goalId: goal.goalId,
    stateRevision: goal.stateRevision,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
  })
}

export async function syncPlatformGoal(this: CodexRpcTransportHost): Promise<void> {
  // thread/goal/set is outside the node's closed RPC grammar; goal cards stay container-side.
  if (this.opts.remote) return
  if (!this.platformGoalInitialized || !this.threadId || !this.attached) return
  const signature = this.platformGoalSignature()
  if (signature === this.syncedPlatformGoalSignature) return
  const goal = this.platformGoal
  const cleared = !goal || goal.status === 'cleared'
  const previousSignature = this.syncedPlatformGoalSignature
  const previousGoal = this.syncedPlatformGoal
  this.syncedPlatformGoalSignature = signature
  this.syncedPlatformGoal = goal ? structuredClone(goal) : null
  try {
    await this.sendRequest('thread/goal/set', {
      threadId: this.threadId,
      objective: cleared ? null : goal.objective,
      status: cleared ? null : goal.status === 'completed' ? 'complete' : goal.status,
      tokenBudget: cleared ? null : goal.tokenBudget,
    })
  } catch (err) {
    if (cleared && isGoalAlreadyClearedError(err)) {
      log.info('codex thread/goal/set: no goal upstream — treating clear as no-op', {
        sessionKey: this.opts.sessionKey,
        threadId: this.threadId,
      })
      return
    }
    this.syncedPlatformGoalSignature = previousSignature
    this.syncedPlatformGoal = previousGoal
    throw err
  }
}

export function sendPermissionResponse(
  this: CodexRpcTransportHost,
  requestId: string,
  responseUnk: unknown,
): boolean {
  const pending = this.pendingUserInputs.get(requestId)
  if (!pending) return false

  const response = asRecord(responseUnk)
  const codexAnswers: Record<string, { answers: string[] }> = {}
  if (response.behavior === 'allow') {
    const updatedInput = asRecord(response.updatedInput)
    const answersByQuestionText = asRecord(updatedInput.answers)
    for (const question of pending.questions) {
      const answer = answersByQuestionText[question.question]
      if (typeof answer !== 'string' || answer.trim().length === 0) continue
      codexAnswers[question.id] = { answers: [answer] }
    }
  }

  const written = this.writeRaw(jsonRpcResult(pending.rpcId, { answers: codexAnswers }))
  if (!written) return false
  this.takePendingUserInput(requestId)
  this.lastActivityAt = Date.now()
  this.emitUserInputWaitStatus()
  return true
}

export function settlePendingUserInputsForTurn(
  this: CodexRpcTransportHost,
  turnId: string,
  reason: string,
): number {
  const requestIds = [...this.pendingUserInputs.entries()]
    .filter(([, pending]) => pending.turnId === turnId)
    .map(([requestId]) => requestId)
  for (const requestId of requestIds) {
    const pending = this.takePendingUserInput(requestId)
    if (!pending) continue
    this.writeRaw(jsonRpcResult(pending.rpcId, { answers: {} }))
  }
  if (requestIds.length > 0) {
    this.emitUserInputWaitStatus()
    log.info('codex requestUserInput settled without browser answer', {
      sessionKey: this.opts.sessionKey,
      turnId,
      count: requestIds.length,
      reason,
    })
  }
  return requestIds.length
}

export function takePendingUserInput(
  this: CodexRpcTransportHost,
  requestId: string,
): PendingCodexUserInput | null {
  const pending = this.pendingUserInputs.get(requestId)
  if (!pending) return null
  this.pendingUserInputs.delete(requestId)
  this.pendingUserInputIdsByRpc.delete(pending.rpcKey)
  return pending
}

export async function compactCurrentThreadForHandoff(
  this: CodexRpcTransportHost,
): Promise<NativeModelHandoffArtifact> {
  if (!this.proc || !this.attached || !this.threadId) {
    throw new Error('CODEX_NATIVE_COMPACTION_SESSION_NOT_READY')
  }
  if (this.processing || this.currentTurnCompleter || this.pendingNativeCompaction) {
    throw new Error('CODEX_NATIVE_COMPACTION_BUSY')
  }
  const compactStartedAt = Date.now()
  const completed = new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      if (this.pendingNativeCompaction?.startedAt !== compactStartedAt) return
      this.pendingNativeCompaction = null
      rejectPromise(new Error('CODEX_NATIVE_COMPACTION_TIMEOUT'))
    }, NATIVE_COMPACTION_TIMEOUT_MS)
    timer.unref?.()
    this.pendingNativeCompaction = {
      startedAt: compactStartedAt,
      resolve: resolvePromise,
      reject: rejectPromise,
      timer,
    }
  })
  try {
    await this.sendRequest('thread/compact/start', { threadId: this.threadId })
    await completed
    const result = (await this.sendRequest('thread/read', {
      threadId: this.threadId,
      includeTurns: false,
    })) as { thread?: { path?: unknown } }
    const rolloutPath = result.thread?.path
    if (typeof rolloutPath !== 'string' || !rolloutPath) {
      throw new Error('CODEX_NATIVE_COMPACTION_PATH_MISSING')
    }
    return await readLatestCodexNativeHandoff(rolloutPath, compactStartedAt)
  } catch (error) {
    this.clearPendingNativeCompaction(compactStartedAt)
    throw error
  }
}

export async function ensureLaunchOverrides(
  this: CodexRpcTransportHost,
  repoSnap: RepoSnapshot | null,
): Promise<CodexLaunchOverrides | null> {
  if (this.opts.hermeticNoTools) return null
  if (!this.opts.config) return null
  if (this.cachedOverrides && this.sessionDir) return this.cachedOverrides
  if (this.sessionDir) {
    try {
      rmSync(this.sessionDir, { recursive: true, force: true })
    } catch (err) {
      log.warn('codex app-server stale sessionDir cleanup failed', {
        sessionDir: this.sessionDir,
        err: (err as Error).message,
      })
    }
    this.sessionDir = null
  }
  const privacyGeneration = this._preheatGeneration
  const dir = mkdtempSync(join(tmpdir(), 'oc-codex-app-'))
  try {
    const overrides = await buildCodexLaunchOverrides({
      systemHelpContextFile: this.opts.systemHelpContextFile,
      promptPolicy: this.promptPolicy,
      agentId: this.opts.agentId,
      sessionKey: this.opts.sessionKey,
      persona: this.opts.persona,
      identityCompat: this.opts.identityCompat,
      provider: this.opts.agentProvider,
      model: this.opts.model,
      effortLevel: this.effortLevel,
      sessionDir: dir,
      claudeCodePath: this.opts.config.auth.claudeCodePath,
      gatewayPort: this.opts.config.gateway.port,
      gatewayToken: this.opts.config.gateway.accessToken,
      delegationDepth: this.opts.delegationDepth,
      repoSnapshot: repoSnap,
      sessionId: this.opts.sessionId,
      projectId: this.opts.projectId,
      runContext: this.opts.runContext,
      frozenProjectContext: this.opts.frozenProjectContext,
      cwd: this.opts.cwd,
      readOnly: this.advisorReadOnly,
    })
    if (privacyGeneration !== this._preheatGeneration) throw new Error('PROMPT_PRIVACY_SPAWN_STALE')
    writeFileSync(overrides.instructionsFile, overrides.instructionsContent, 'utf8')
    if (overrides.tokenFile && overrides.tokenContent !== null) {
      writeFileSync(overrides.tokenFile, overrides.tokenContent, { mode: 0o600 })
    }
    if (overrides.delegateContextFile && overrides.delegateContextContent !== null) {
      writeFileSync(overrides.delegateContextFile, overrides.delegateContextContent, {
        mode: 0o600,
      })
    }
    this._promptIntelligentUi = overrides.intelligentUiApplied
    this._promptPolicyFingerprint = overrides.promptPolicyFingerprint
    this.sessionDir = dir
    this.cachedOverrides = overrides
    return overrides
  } catch (err) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* swallow */
    }
    throw err
  }
}

export function cleanupLaunchOverrides(this: CodexRpcTransportHost): void {
  if (this.sessionDir) {
    try {
      rmSync(this.sessionDir, { recursive: true, force: true })
    } catch (err) {
      log.warn('codex app-server session dir cleanup failed', {
        sessionDir: this.sessionDir,
        err: (err as Error).message,
      })
    }
    this.sessionDir = null
  }
  this.cachedOverrides = null
}

export function cleanupHermeticDir(this: CodexRpcTransportHost): void {
  if (!this.hermeticDir) return
  try {
    rmSync(this.hermeticDir, { recursive: true, force: true })
  } catch (err) {
    log.warn('codex hermetic cwd cleanup failed', {
      sessionKey: this.opts.sessionKey,
      err: (err as Error).message,
    })
  }
  this.hermeticDir = null
}

export async function shutdown(
  this: CodexRpcTransportHost,
  opts?: { keepQueuedTurns?: boolean },
): Promise<void> {
  const preserveNativeUsage = this.nativeContext.running
  this.shuttingDown = true
  this.nativeContext.abort(new Error('Native context compaction interrupted'))
  this._preheatGeneration++
  this._preheatPromise = null
  this._preheatedSignature = null
  if (this._unannouncedPreheatThread) {
    this._unannouncedPreheatThread = false
    this.clearSessionId()
  }
  this._spawnPromise = null
  if (this.pendingRetryAbort) {
    this.pendingRetryAbort.abort('shutdown')
    this.pendingRetryAbort = null
  }
  for (const [, p] of this.pending) {
    p.reject(new Error('CodexAppServerRunner shutdown'))
  }
  this.pending.clear()
  if (!opts?.keepQueuedTurns) {
    const pendingQueue = this.queue
    this.queue = []
    for (const q of pendingQueue) q.reject(new Error('CodexAppServerRunner shutdown'))
  }
  if (this.pendingNativeCompaction) {
    const pending = this.pendingNativeCompaction
    this.pendingNativeCompaction = null
    clearTimeout(pending.timer)
    pending.reject(new Error('CODEX_NATIVE_COMPACTION_INTERRUPTED'))
  }
  this.settleAllPendingUserInputs('runner shutdown')
  const proc = this.proc
  if (proc) {
    let resolveClose!: () => void
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve
    })
    const onClose = () => resolveClose()
    proc.once('close', onClose)
    if (proc.exitCode === null && proc.signalCode === null) {
      if (this.opts.remote) {
        void this.opts.remote.stop().catch((err: Error) => {
          log.warn('codex remote lane stop failed', { sessionKey: this.opts.sessionKey, err: err.message })
        })
        proc.kill()
      } else {
        killCodexProcessGroup(proc, 'SIGTERM')
      }
    }
    let closed = await waitForCloseWithin(
      closePromise,
      runnerShutdownTimeoutMs(
        'OPENCLAUDE_RUNNER_SHUTDOWN_GRACE_MS',
        RUNNER_SHUTDOWN_GRACE_DEFAULT_MS,
      ),
    )
    if (!closed) {
      killCodexProcessGroup(proc, 'SIGKILL')
      closed = await waitForCloseWithin(
        closePromise,
        runnerShutdownTimeoutMs(
          'OPENCLAUDE_RUNNER_SHUTDOWN_FINAL_DRAIN_MS',
          RUNNER_SHUTDOWN_FINAL_DRAIN_DEFAULT_MS,
        ),
      )
    }
    if (!closed) {
      proc.removeListener('close', onClose)
      log.error('codex app-server close did not arrive after process-group SIGKILL', {
        sessionKey: this.opts.sessionKey,
        pid: proc.pid,
      })
      return
    }
  }
  for (const [, p] of this.pending) {
    p.reject(new Error('CodexAppServerRunner shutdown'))
  }
  this.pending.clear()
  if (this.currentTurnCompleter) {
    this.currentTurnCompleter.reject(new Error('CodexAppServerRunner shutdown'))
    this.currentTurnCompleter = null
  }
  this.activeTurnId = null
  this.currentCollabAgentPolicy = undefined
  this.resetInitializedState()
  this.attached = false
  this.syncedPlatformGoalSignature = null
  this.syncedPlatformGoal = null
  if (this.proc === proc) this.proc = null
  this.spawnedProviderSignature = null
  this.stdoutBuf = ''
  this.emittedToolUseIds.clear()
  if (!preserveNativeUsage) {
    this.activeTurnTotal = null
    this.currentTurnUsage = null
  }
  this.resetCallUsageAttribution()
  this.cleanupLaunchOverrides()
  this.cleanupHermeticDir()
  this.shuttingDown = false
}

export async function ensureSpawnedInternal(
  this: CodexRpcTransportHost,
  repoSnap: RepoSnapshot | null,
  effectiveCwd: string,
): Promise<void> {
  let generation = this._preheatGeneration
  if (this.proc && !this.proc.killed && this.initialized) return
  if (this.proc && !this.proc.killed && !this.initialized) {
    log.warn('codex app-server alive but uninitialized — replacing process', {
      sessionKey: this.opts.sessionKey,
    })
    await this.shutdown()
    if (this._preheatGeneration !== generation + 1) throw new Error('CODEX_SPAWN_STALE')
    generation = this._preheatGeneration
  }
  this.stdoutBuf = ''
  this.relayDeniedTracker.reset()
  if (this.opts.remote) return this._ensureSpawnedRemote()
  let argvOverrides: string[] = []
  try {
    if (this.opts.hermeticNoTools) {
      argvOverrides = [
        '-c',
        'mcp_servers={}',
        '-c',
        'features.shell_tool=false',
        '-c',
        'features.unified_exec=false',
        '-c',
        'features.apps=false',
        '-c',
        'features.plugins=false',
        '-c',
        'features.browser_use=false',
        '-c',
        'features.browser_use_external=false',
        '-c',
        'features.computer_use=false',
        '-c',
        'features.image_generation=false',
        '-c',
        'features.multi_agent=false',
        '-c',
        'features.multi_agent_v2=false',
      ]
    } else {
      const launchStartedAt = performance.now()
      const overrides = await this.ensureLaunchOverrides(repoSnap)
      log.info('codex_turn_timing', {
        traceId: this.opts.traceId,
        threadId: this.threadId,
        stage: 'launch_context_ready',
        durationMs: performance.now() - launchStartedAt,
      })
      if (overrides) argvOverrides = overrides.argvOverrides
    }
  } catch (err) {
    if (this.promptPolicy) throw err
    log.warn(
      'codex app-server launch overrides build failed; spawning without platform context',
      {
        sessionKey: this.opts.sessionKey,
        err: (err as Error).message,
      },
    )
  }
  const hostEnv = this.getHostProcessEnv()
  const providerSignature = this.codexRouteSignature()
  const providerArgs = buildCodexProviderConfigArgs(hostEnv, this.codexRouteConfig)
  const modelCatalogArgs = buildCodexModelCatalogArgs(this.opts.model)
  const longContextArgs = buildCodexLongContextArgs(this.opts.model)
  const effortArgs = codexReasoningEffortConfig(this.opts.model, this.effortLevel)
  const reasoningSummaryArgs = buildCodexReasoningSummaryArgs(this.opts.agentProvider, hostEnv)
  const multiAgentDisableArgs = buildCodexMultiAgentDisableArgs(hostEnv)
  const requestUserInputArgs = this.opts.hermeticNoTools
    ? []
    : ['-c', 'features.default_mode_request_user_input=true']
  const applyPatchStreamingArgs = this.opts.hermeticNoTools
    ? []
    : ['-c', 'features.apply_patch_streaming_events=true']
  const chatgptRelayBaseUrl = this.resolveChatgptRelayBaseUrl()
  const telemetryArgs = buildCodexTelemetryHardeningArgs(chatgptRelayBaseUrl)
  const omitPlatformMcp = shouldOmitPlatformMcp(this.opts.agentId, this.opts.sessionKey)
  const stageAgentArgs = omitPlatformMcp
    ? ['-c', 'mcp_servers={}', '-c', 'features.apps=false', '-c', 'features.plugins=false']
    : []
  const args = [
    'app-server',
    ...(this.advisorReadOnly ? ['-c', 'mcp_servers={}'] : []),
    ...argvOverrides,
    ...providerArgs,
    ...modelCatalogArgs,
    ...longContextArgs,
    ...effortArgs,
    ...reasoningSummaryArgs,
    ...multiAgentDisableArgs,
    ...requestUserInputArgs,
    ...applyPatchStreamingArgs,
    ...telemetryArgs,
    ...stageAgentArgs,
    ...(this.advisorReadOnly ? buildAdvisorReadOnlyArgs() : []),
    '--listen',
    'stdio://',
  ]
  if (generation !== this._preheatGeneration) throw new Error('CODEX_SPAWN_STALE')
  const proc = this.getSpawnFn()('codex', args, {
    cwd: effectiveCwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    env: this.buildCodexSpawnEnv(),
  }) as ChildProcessWithoutNullStreams
  this.proc = proc
  this.spawnedAdvisorReadOnly = this.advisorReadOnly
  proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
    if (this.proc !== proc) return
    log.warn('codex app-server stdin error', {
      sessionKey: this.opts.sessionKey,
      err: err.message,
      code: err.code,
    })
  })
  this.outputDrainPromise = new Promise<void>((resolve) => {
    this.resolveOutputDrain = resolve
  })
  this.spawnedProviderSignature = providerSignature
  proc.stdout.on('data', (chunk: Buffer) => {
    if (this.proc !== proc) return
    this.lastActivityAt = Date.now()
    this.stdoutBuf += chunk.toString('utf8')
    let nl = this.stdoutBuf.indexOf('\n')
    while (nl >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (line) this.handleLine(line)
      nl = this.stdoutBuf.indexOf('\n')
    }
  })
  proc.stderr.on('data', (chunk: Buffer) => {
    this.handleStderrChunk(proc, chunk.toString('utf8'))
  })
  proc.on('error', (err) => {
    if (this.proc !== proc) {
      log.info('codex app-server stale proc error ignored', {
        sessionKey: this.opts.sessionKey,
        err: err.message,
      })
      return
    }
    log.error('codex app-server proc error', { err: err.message })
    this.emit('error', err)
    this.wakeRetryBackoffOnProcGone()
  })
  proc.on('close', (code, signal) => {
    this.onTransportProcessClose(proc, code, signal, false)
  })

  const initializeStartedAt = performance.now()
  try {
    const initialized = await this.sendRequest('initialize', this.buildInitializeParams())
    this.initializedPayload = initialized
    this.advisorReadOnlyConfig = await readAdvisorReadOnlyConfig(
      this.advisorReadOnly,
      initialized,
      () => this.sendRequest('config/read', { cwd: effectiveCwd, includeLayers: false }),
      this.cachedOverrides?.tokenFile != null,
    )
    log.info('codex_turn_timing', {
      traceId: this.opts.traceId,
      threadId: this.threadId,
      stage: 'initialize_ready',
      durationMs: performance.now() - initializeStartedAt,
    })
  } catch (err) {
    try {
      await this.shutdown()
    } catch {
      /* teardown is best-effort on a failed handshake */
    }
    throw err
  }
  this.initialized = true
}

export async function ensureSpawnedRemote(this: CodexRpcTransportHost): Promise<void> {
  const remote = this.opts.remote!
  await remote.ready()
  let platformPrompt = ''
  try {
    const overrides = await this.ensureLaunchOverrides(null)
    platformPrompt = overrides?.instructionsContent ?? ''
  } catch (err) {
    throw err instanceof Error ? err : new Error('CODEX_REMOTE_CONTEXT_UNAVAILABLE')
  }
  this.remoteInstructions = remote.instructions(platformPrompt)
  const proc = remote.child
  this.proc = proc
  this.spawnedProviderSignature = this.codexRouteSignature()
  this.outputDrainPromise = new Promise<void>((resolve) => {
    this.resolveOutputDrain = resolve
  })
  proc.stdout.on('data', (chunk: Buffer) => {
    if (this.proc !== proc) return
    this.lastActivityAt = Date.now()
    this.stdoutBuf += chunk.toString('utf8')
    let nl = this.stdoutBuf.indexOf('\n')
    while (nl >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (line) this.handleLine(line)
      nl = this.stdoutBuf.indexOf('\n')
    }
  })
  proc.stderr.resume()
  proc.on('error', (err: Error) => {
    if (this.proc !== proc) return
    log.error('codex remote lane error', { sessionKey: this.opts.sessionKey, err: err.message })
    this.emit('error', err)
    this.wakeRetryBackoffOnProcGone()
  })
  proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    this.onTransportProcessClose(proc, code, signal, true)
  })
  try {
    this.initializedPayload = await this.sendRequest('initialize', this.buildInitializeParams())
  } catch (err) {
    try {
      await this.shutdown()
    } catch {
      /* teardown is best-effort on a failed handshake */
    }
    throw err
  }
  this.initialized = true
}

export function failAllPending(this: CodexRpcTransportHost, reason: string): void {
  this.nativeContext.abort(new Error(reason))
  for (const [, p] of this.pending) {
    p.reject(new Error(reason))
  }
  this.pending.clear()
  if (this.currentTurnCompleter) {
    this.currentTurnCompleter.reject(new Error(reason))
    this.currentTurnCompleter = null
  }
  this.clearPendingUserInputs()
}

export function writeRaw(this: CodexRpcTransportHost, line: string): boolean {
  if (!this.isInlinePushProcLive(this.proc)) return false
  try {
    this.proc!.stdin.write(`${line}\n`)
    return true
  } catch (err) {
    log.warn('codex app-server stdin write failed', {
      err: (err as Error).message,
    })
    return false
  }
}

export function sendRequest(
  this: CodexRpcTransportHost,
  method: string,
  params: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(new Error(`codex request ${method} aborted`))
  const id = ++this.nextRequestId
  return new Promise((resolve, reject) => {
    const onAbort = signal
      ? () => {
          this.pending.delete(id)
          reject(new Error(`codex request ${method} aborted`))
        }
      : null
    const unlisten = () => {
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
    if (onAbort) signal?.addEventListener('abort', onAbort, { once: true })
    this.pending.set(id, {
      resolve: (v) => {
        unlisten()
        resolve(v)
      },
      reject: (e) => {
        unlisten()
        reject(e)
      },
      method,
    })
    this.writeRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

export function buildCompactResumeParams(
  sourceThread: string,
  cwd: string,
  model: string | undefined,
  instructionsContent: string | undefined,
): Record<string, unknown> {
  const transportModel = codexTransportModelId(model)
  return {
    ...(instructionsContent !== undefined ? { baseInstructions: instructionsContent } : {}),
    threadId: sourceThread,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    cwd,
    ...(transportModel ? { model: transportModel } : {}),
  }
}
