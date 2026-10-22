/** Cursor account-pool engine whose official Claude Code process lives in
 * that account's Grok Bot box. Parsing and the web timeline stay on CcbAdapter. */
import { unlinkSync } from 'node:fs'
import { CcbAdapter } from './ccbAdapter.js'
import type { EngineCapabilities, EngineTurnRun, TurnParams } from './engineAdapter.js'
import type { PartialSnapshot, TurnSummary } from './engineEvents.js'
import type { EngineCreateOpts } from './registry.js'
import type { CursorCredentialSelection } from './cursorCredentialSelection.js'
import { isBoxGptWebCatalogModel, writeBoxCcControlFile } from './cursorBoxCc.js'
import {
  BOX_GPT_WEB_BUSY_MESSAGE,
  releaseBoxGptWebTurnSlot,
  tryAcquireBoxGptWebTurnSlot,
} from './cursorBoxGptWeb.js'

const EMPTY_SNAPSHOT: PartialSnapshot = {
  assistantText: '',
  thinkingText: '',
  completedTools: [],
  assistantSegments: [],
  thinkingSegments: [],
  runtimeEvents: [],
}

function rejectImmediateGptWebTurn(
  params: TurnParams,
  message: string,
  errorClass: 'rate_limited',
  errorKind: 'other',
): EngineTurnRun {
  params.onEvent({
    kind: 'error',
    error: message,
    errorClass,
  })
  params.onEvent({
    kind: 'final',
  })
  const summary: TurnSummary = {
    usage: {
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
    },
    assistantText: '',
    thinkingText: '',
    assistantSegments: [],
    thinkingSegments: [],
    tools: [],
    runtimeEvents: [],
    stopReason: null,
    numTurns: 0,
    isError: true,
    errorKind,
    errorClass,
    errorDetail: message,
    staleResumeId: false,
    phantomSignals: {
      apiState: 'skipped',
      skipReason: errorClass === 'rate_limited' ? 'box_gpt_web_busy' : 'box_gpt_web_forbidden',
    },
  }
  return {
    submitted: Promise.resolve(),
    summary: Promise.resolve(summary),
    end: () => {},
    getPartialSnapshot: () => ({
      ...EMPTY_SNAPSHOT,
      completedTools: [],
      assistantSegments: [],
      thinkingSegments: [],
      runtimeEvents: [],
    }),
    getPhantomSignals: () => ({
      apiState: 'skipped',
      skipReason: errorClass === 'rate_limited' ? 'box_gpt_web_busy' : 'box_gpt_web_forbidden',
    }),
    get finalized() {
      return true
    },
    get pendingToolCalls() {
      return 0
    },
  }
}

export class CursorBoxCcAdapter extends CcbAdapter {
  override readonly engineId = 'cursor'
  override readonly capabilities: EngineCapabilities = {
    // proxy: the CLI's own usage is visible, but this path does not settle a
    // Cursor Sand bill or an Anthropic proxy bill. Login is the box's.
    billingMode: 'proxy',
    supportsEffort: false,
    resumeKind: 'ccb-session',
    needsServerRequestId: false,
    historyMode: 'native-resume',
    permissionModel: 'native',
    emitsCallUsage: true,
    emitsToolInputDeltas: true,
    supportsNativeCompact: false,
    multimodalInput: 'native',
  }

  private readonly controlHolder: { path: string | null }
  private readonly sessionKey: string
  private heldGptWebSlotOwner: string | null = null

  constructor(opts: EngineCreateOpts) {
    const selection = opts.cursorCredentialSelection
    if (!selection || (selection.masterBox !== true
      && (!selection.sandEnabled || selection.credentialKind !== 'session' || !selection.machineId))) {
      throw new Error('BOX_CC_SESSION_REQUIRED')
    }
    const holder = { path: null as string | null }
    super({
      ...opts,
      harness: 'official-cc',
      boxResidentCc: true,
      prepareBoxCc: () => prepareControl(selection, opts.sessionKey, holder),
    })
    this.controlHolder = holder
    this.sessionKey = opts.sessionKey
  }

  override submitTurn(params: TurnParams): EngineTurnRun {
    const isGptWeb =
      isBoxGptWebCatalogModel(this.model) ||
      isBoxGptWebCatalogModel(params.modelAuthority?.executionDescriptor?.canonicalModel)
    if (!isGptWeb) {
      return super.submitTurn(params)
    }
    const slotOwner = `${this.sessionKey}:${params.turnKey ?? Date.now()}:${Math.random().toString(36).slice(2, 8)}`
    if (!tryAcquireBoxGptWebTurnSlot(slotOwner)) {
      return rejectImmediateGptWebTurn(params, BOX_GPT_WEB_BUSY_MESSAGE, 'rate_limited', 'other')
    }
    this.heldGptWebSlotOwner = slotOwner
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      if (this.heldGptWebSlotOwner === slotOwner) {
        this.heldGptWebSlotOwner = null
      }
      releaseBoxGptWebTurnSlot(slotOwner)
    }
    try {
      const run = super.submitTurn(params)
      const summary = run.summary.finally(release)
      void run.submitted.catch(release)
      return {
        submitted: run.submitted,
        summary,
        end: () => {
          try {
            run.end()
          } finally {
            release()
          }
        },
        getPartialSnapshot: () => run.getPartialSnapshot(),
        getPhantomSignals: () => run.getPhantomSignals(),
        get finalized() {
          return run.finalized
        },
        get pendingToolCalls() {
          return run.pendingToolCalls
        },
      }
    } catch (err) {
      release()
      throw err
    }
  }

  override async shutdown(): Promise<void> {
    try {
      await super.shutdown()
    } finally {
      if (this.heldGptWebSlotOwner) {
        releaseBoxGptWebTurnSlot(this.heldGptWebSlotOwner)
        this.heldGptWebSlotOwner = null
      }
      if (this.controlHolder.path) {
        try { unlinkSync(this.controlHolder.path) } catch { /* already gone */ }
        this.controlHolder.path = null
      }
    }
  }
}

async function prepareControl(
  selection: CursorCredentialSelection,
  sessionKey: string,
  holder: { path: string | null },
): Promise<string> {
  holder.path = await writeBoxCcControlFile({ selection, sessionKey })
  return holder.path
}
