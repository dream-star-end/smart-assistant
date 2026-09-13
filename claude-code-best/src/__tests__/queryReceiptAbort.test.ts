import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getSessionId,
  resetStateForTests,
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from '../bootstrap/state.js'
import { query } from '../query.js'
import { getEmptyToolPermissionContext } from '../Tool.js'
import { StreamingToolExecutor } from '../services/tools/StreamingToolExecutor.js'
import type { Message, UserMessage } from '../types/message.js'
import { bindReceiptInput } from '../utils/receiptInputAdmission.js'
import { createUserMessage } from '../utils/messages.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import {
  clearSessionMessagesCache,
  flushSessionStorage,
  getProjectDir,
  getTranscriptPath,
  loadFullLog,
  recordTranscript,
  resetProjectForTesting,
} from '../utils/sessionStorage.js'
import { resetCommandQueue } from '../utils/messageQueueManager.js'

let dir: string
let restoreSpy: (() => void) | undefined
const oldConfig = process.env.CLAUDE_CONFIG_DIR
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'receipt-query-abort-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1'
  resetStateForTests()
  resetCommandQueue()
  setOriginalCwd(dir)
  setCwdState(dir)
  setProjectRoot(dir)
  getProjectDir.cache.clear?.()
  clearSessionMessagesCache()
  resetProjectForTesting()
})
afterEach(async () => {
  restoreSpy?.()
  restoreSpy = undefined
  await flushSessionStorage()
  resetProjectForTesting()
  resetCommandQueue()
  if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = oldConfig
  delete process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
  await rm(dir, { recursive: true, force: true })
})

for (const owner of ['notify_owned', 'ingested', 'ordinary'] as const) {
  test(`actual query abort drains completed results with ${owner} ownership`, async () => {
    const abortController = new AbortController()
    let inProgress = new Set<string>()
    let appState: any = {
      toolPermissionContext: getEmptyToolPermissionContext(),
      fastMode: false,
      mcp: { tools: [], clients: [] },
      sessionHooks: new Map(),
    }
    const context: any = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'claude-sonnet-4-5-20250929',
        tools: [],
        verbose: false,
        thinkingConfig: { type: 'disabled' },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allowedAgentTypes: [] },
      },
      abortController,
      readFileState: new Map(),
      getAppState: () => appState,
      setAppState: (fn: any) => {
        appState = fn(appState)
      },
      setInProgressToolUseIDs: (fn: any) => {
        inProgress = fn(inProgress)
      },
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
      messages: [],
    }
    const assistant: any = {
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        id: 'abort-model-message',
        type: 'message',
        role: 'assistant',
        model: 'synthetic',
        content: [
          {
            type: 'tool_use',
            id: 'abort-tool',
            name: 'MissingReceiptAbortTool',
            input: {},
          },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }
    let originalResult: UserMessage | undefined
    let ingestCalls = 0
    const realAddTool = StreamingToolExecutor.prototype.addTool
    // The transport registration is the only controlled seam. Keep real
    // addTool, real executor buffering, real query and native persistence.
    const spy = spyOn(
      StreamingToolExecutor.prototype,
      'addTool',
    ).mockImplementation(function (
      this: StreamingToolExecutor,
      block,
      message,
    ) {
      realAddTool.call(this, block, message)
      originalResult = (this as any).tools[0].results[0]
      if (owner !== 'ordinary')
        bindReceiptInput(originalResult!, {
          marker: {
            jobId: 'abort-receipt',
            generation: 1,
            resultDigest: 'a'.repeat(64),
          },
          ingest: async (_proof, commit, oracle) => {
            ingestCalls++
            if (owner === 'ingested') {
              await commit()
              expect((await oracle()).kind).toBe('present')
            }
            return owner
          },
        })
      abortController.abort('user_stop_after_completed_before_drain')
    })
    restoreSpy = () => spy.mockRestore()
    let modelCalls = 0
    const first = createUserMessage({
      content: 'query receipt abort regression',
    })
    const persisted: Message[] = [first]
    const generator = query({
      messages: [first],
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool: async (_tool, input) => ({
        behavior: 'allow',
        updatedInput: input,
      }),
      toolUseContext: context,
      querySource: 'sdk',
      maxTurns: 1,
      deps: {
        uuid: randomUUID,
        microcompact: async (messages: Message[]) => ({ messages }),
        autocompact: async () => ({
          compactionResult: undefined,
          consecutiveFailures: 0,
        }),
        callModel: async function* () {
          modelCalls++
          yield assistant
        },
      } as any,
    })
    for await (const message of generator) {
      if (
        message.type === 'user' ||
        message.type === 'assistant' ||
        message.type === 'system'
      ) {
        persisted.push(message as Message)
        await recordTranscript(persisted)
      }
    }
    await flushSessionStorage()
    expect(modelCalls).toBe(1)
    expect(originalResult).toBeDefined()
    expect(abortController.signal.aborted).toBe(true)
    const native = await loadFullLog({
      isLite: true,
      sessionId: getSessionId(),
      fullPath: getTranscriptPath(),
      messages: [],
      date: '',
      value: 0,
      created: new Date(),
      modified: new Date(),
      firstPrompt: '',
      messageCount: 3,
      isSidechain: false,
    })
    const rows = (await readFile(getTranscriptPath(), 'utf8'))
      .trim()
      .split('\n')
      .map(s => JSON.parse(s))
    if (owner === 'notify_owned') {
      expect(native.messages.some(m => m.uuid === originalResult!.uuid)).toBe(
        false,
      )
      expect(rows.some(m => m.uuid === originalResult!.uuid)).toBe(false)
      expect(JSON.stringify(native.messages)).not.toContain(
        'Error: No such tool available',
      )
      expect(JSON.stringify(native.messages)).toContain('不重复提交结果')
    } else {
      expect(
        native.messages.filter(m => m.uuid === originalResult!.uuid),
      ).toHaveLength(1)
      const results = rows.filter(m => m.uuid === originalResult!.uuid)
      expect(results).toHaveLength(1)
      expect(Boolean(results[0].delegateReceipt)).toBe(owner === 'ingested')
    }
    expect(ingestCalls).toBe(owner === 'ordinary' ? 0 : 1)
  }, 60000)
}
