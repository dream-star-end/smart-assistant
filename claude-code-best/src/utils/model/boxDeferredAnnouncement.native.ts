/** Box deferred-tool announcement: real query yield, record, loader, hash.
 * Synthetic tools and a stub model. No remote API.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const root = mkdtempSync(join(tmpdir(), 'box-deferred-'))
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
process.env.HOME = root
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.NODE_ENV = 'test'
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
delete process.env.USER_TYPE
delete process.env.ENABLE_SEARCH_EXTRA_TOOLS

const MODEL = 'box-api-claude-opus-5-5'
const descriptor = {
  canonicalModel: MODEL,
  contextWindow: 200000,
  capabilityZero: false,
  supportsThinking: true,
  supportsVision: true,
  supportedEfforts: ['low'],
  contextOwner: 'box-native-v1',
}
process.env.OC_MODEL_EXECUTION_DESCRIPTOR = JSON.stringify(descriptor)

const { switchSession, setMainLoopModelOverride, setOriginalCwd, setCwdState } = await import('../../bootstrap/state.js')
const { recordTranscript, resetSessionFilePointer, flushSessionStorage } = await import('../sessionStorage.js')
const { loadConversationForResume } = await import('../conversationRecovery.js')
const { getDeferredToolsDeltaAttachment, createAttachmentMessage } = await import('../attachments.js')
const { isDeferredToolsDeltaEnabled } = await import('../searchExtraTools.js')
const { normalizeMessagesForAPI, createUserMessage, createAssistantMessage } = await import('../messages.js')
const { query } = await import('../../query.js')
const { getEmptyToolPermissionContext } = await import('../../Tool.js')
const { asSystemPrompt } = await import('../systemPromptType.js')
const { getPrompt } = await import('../../../packages/builtin-tools/src/tools/SearchExtraToolsTool/prompt.js')
const { deriveBoxContextHash } = await import('../../../../packages/commercial/src/http/proxy/boxCallFingerprint.ts')
const { classifyBoxContinuation } = await import('../../../../packages/commercial/src/http/proxy/boxPreparedContinuation.ts')
const { compileBoxToolCatalog } = await import('../../../../packages/commercial/src/http/proxy/boxToolCatalog.ts')

setOriginalCwd(root)
setCwdState(root)
setMainLoopModelOverride(MODEL)

const search = { name: 'SearchExtraTools' }
const readTool = { name: 'Read' }
const one = { name: 'mcp__fixture__one' }
const two = { name: 'mcp__fixture__two' }
const pool = [search, readTool, one] as never
const grown = [search, readTool, one, two] as never
const removed = [search, readTool] as never

function fail(message: string): never {
  throw new Error(message)
}

function deltas(messages: { type?: string; attachment?: { type?: string } }[]) {
  return messages.filter(message => message.type === 'attachment' && message.attachment?.type === 'deferred_tools_delta')
}

function produce(tools: never, messages: never, model = MODEL) {
  return getDeferredToolsDeltaAttachment(tools, model, messages, { callSite: 'attachments_main' })
}

async function openSession(sessionId: string) {
  switchSession(sessionId as never, join(root, 'config', 'projects', 'p'))
  await resetSessionFilePointer()
}

function stamp(messages: { timestamp?: string }[]) {
  const start = Date.now()
  messages.forEach((message, index) => {
    message.timestamp = new Date(start + index * 1000).toISOString()
  })
  return messages
}

const apiTools = [
  { name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } },
  { name: 'SearchExtraTools', description: 'search', input_schema: { type: 'object', properties: {} } },
]

function proxyBody(messages: unknown[], tools = apiTools, system = [{ type: 'text', text: 'stable' }]) {
  return {
    model: MODEL,
    stream: true,
    max_tokens: 128,
    tools,
    system,
    messages,
    metadata: { user_id: JSON.stringify({ session_id: 'sess-deferred', oc_turn_key: 'ab'.repeat(32) }) },
  }
}

function apiMessages(messages: never) {
  return (normalizeMessagesForAPI(messages) as { message: { role: string; content: unknown } }[])
    .map(message => ({ role: message.message.role, content: message.message.content }))
}

function context() {
  let appState = {
    toolPermissionContext: getEmptyToolPermissionContext(),
    fastMode: false,
    mcp: { tools: [], clients: [] },
    effortValue: undefined,
    advisorModel: undefined,
    sessionHooks: new Map(),
  }
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: MODEL,
      tools: pool,
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: [] },
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    getAppState: () => appState,
    setAppState: (updater: (state: typeof appState) => typeof appState) => {
      appState = updater(appState)
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  }
}

async function runQuery(messages: unknown[], model = MODEL) {
  const seen: unknown[] = []
  const yielded: { type?: string; attachment?: { type?: string } }[] = []
  const toolContext = context()
  toolContext.options.mainLoopModel = model
  const generator = query({
    messages: messages as never,
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool: async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    toolUseContext: toolContext as never,
    querySource: 'sdk',
    maxTurns: 1,
    deps: {
      uuid: () => randomUUID(),
      microcompact: async (incoming: unknown[]) => ({ messages: incoming }),
      autocompact: async () => ({ compactionResult: undefined, consecutiveFailures: 0 }),
      callModel: async function* (params: { messages: unknown[] }) {
        seen.push(params.messages)
        yield createAssistantMessage({ content: 'done' })
      },
    } as never,
  })
  let next = await generator.next()
  while (!next.done) {
    yielded.push(next.value as { type?: string; attachment?: { type?: string } })
    next = await generator.next()
  }
  return { seen, yielded, terminal: next.value }
}

if (!isDeferredToolsDeltaEnabled(MODEL)) fail('BOX_GATE_OFF')
if (isDeferredToolsDeltaEnabled('claude-sonnet-4-5')) fail('SIDE_MODEL_GATE')
if (isDeferredToolsDeltaEnabled()) fail('NO_MODEL_GATE')

const imageUser = createUserMessage({
  content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aaaa' } }] as never,
})
const firstQuery = await runQuery([imageUser])
const firstYielded = deltas(firstQuery.yielded)
if (firstYielded.length !== 1) fail(`QUERY_YIELD_${firstYielded.length}`)
const firstSeen = deltas((firstQuery.seen[0] ?? []) as { type?: string; attachment?: { type?: string } }[])
if (firstSeen.length !== 1) fail(`QUERY_MODEL_MESSAGES_${firstSeen.length}`)
if ((firstQuery.terminal as { reason?: string }).reason !== 'completed') {
  fail(`QUERY_TERMINAL_${(firstQuery.terminal as { reason?: string }).reason}`)
}

const sessionA = randomUUID()
await openSession(sessionA)
await recordTranscript(stamp([imageUser, firstYielded[0]]) as never, undefined, undefined, undefined, true)
await flushSessionStorage()
const loadedA = await loadConversationForResume(sessionA, undefined)
if (!loadedA) fail('LOAD_A_EMPTY')
if (deltas(loadedA.messages).length !== 1) fail(`LOAD_A_${deltas(loadedA.messages).length}`)
if (produce(pool, loadedA.messages as never).length !== 0) fail('RESUME_REANNOUNCED')

const sessionB = randomUUID()
await openSession(sessionB)
const otherUser = createUserMessage({ content: 'other session' })
const secondQuery = await runQuery([otherUser])
if (deltas(secondQuery.yielded).length !== 1) fail('SESSION_B_SUPPRESSED')
await recordTranscript(stamp([otherUser, deltas(secondQuery.yielded)[0]]) as never, undefined, undefined, undefined, true)
await flushSessionStorage()
const loadedB = await loadConversationForResume(sessionB, undefined)
if (!loadedB || deltas(loadedB.messages).length !== 1) fail(`LOAD_B_${loadedB ? deltas(loadedB.messages).length : 'null'}`)
const reloadedA = await loadConversationForResume(sessionA, undefined)
if (!reloadedA || deltas(reloadedA.messages).length !== 1) fail('SESSION_BLEED')

const textUser = createUserMessage({ content: 'read the file' })
const firstAttachment = createAttachmentMessage(produce(pool, [textUser] as never)[0]!)
const firstApi = apiMessages([textUser, firstAttachment] as never)
const assistant = createAssistantMessage({
  content: [{ type: 'tool_use', id: 'toolu_grow_1', name: 'Read', input: { file_path: 'a.ts' } }] as never,
})
const toolResult = createUserMessage({
  content: [{ type: 'tool_result', tool_use_id: 'toolu_grow_1', content: 'file body' }] as never,
})
const sessionC = randomUUID()
await openSession(sessionC)
await recordTranscript(stamp([textUser, firstAttachment, assistant, toolResult]) as never, undefined, undefined, undefined, true)
await flushSessionStorage()
const loadedC = await loadConversationForResume(sessionC, undefined)
if (!loadedC) fail('LOAD_C_EMPTY')
if (deltas(loadedC.messages).length !== 1) fail(`LOAD_C_${deltas(loadedC.messages).length}`)
const restored = loadedC.messages.filter(message => {
  const content = (message as { message?: { content?: unknown } }).message?.content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) && content.length === 1 && typeof (content[0] as { text?: unknown }).text === 'string'
      ? (content[0] as { text: string }).text
      : ''
  return text !== 'No response requested.' && text !== 'Continue from where you left off.'
})
const continuedApi = apiMessages(restored as never)
const memoryApi = apiMessages([textUser, firstAttachment, assistant, toolResult] as never)
const firstHash = deriveBoxContextHash(proxyBody(firstApi) as never)
const memoryPrior = deriveBoxContextHash(proxyBody(memoryApi) as never, true)
const priorHash = deriveBoxContextHash(proxyBody(continuedApi) as never, true)
if (memoryPrior !== firstHash) fail(`MEMORY_HASH_${firstHash}_${memoryPrior}`)
if (firstHash !== priorHash) {
  const preview = (messages: { role: string; content: unknown }[]) => messages.map(message => `${message.role}:${JSON.stringify(message.content).slice(0, 80)}`).join(' || ')
  fail(`HASH_${firstHash}_${priorHash} first=${preview(firstApi)} loaded=${preview(continuedApi)}`)
}
if (JSON.stringify(memoryApi) !== JSON.stringify(continuedApi)) {
  const shape = (messages: { role: string; content: unknown }[]) => messages.map(message => {
    const content = message.content
    const kinds = Array.isArray(content) ? content.map(block => (block as { type?: string }).type).join('+') : typeof content
    return `${message.role}:${kinds}`
  }).join(',')
  const raw = restored.map(message => `${message.type}:${(message as { attachment?: { type?: string } }).attachment?.type ?? ''}`).join(',')
  fail(`RESTORE_SHAPE memory=${shape(memoryApi)} loaded=${shape(continuedApi)} raw=${raw}`)
}
const classified = classifyBoxContinuation(proxyBody(memoryApi) as never)
if (classified.classification !== 'continuation_candidate' || classified.priorContextHash !== firstHash) {
  fail(`CLASSIFY_${classified.classification}_${classified.rejectCode}`)
}

const changedTools = [
  { ...apiTools[0], input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
  apiTools[1],
]
const changedHash = deriveBoxContextHash(proxyBody(continuedApi, changedTools) as never, true)
if (changedHash === firstHash) fail('SCHEMA_HASH_UNCHANGED')
const catalogA = compileBoxToolCatalog(apiTools).bindingSha256
const catalogB = compileBoxToolCatalog(changedTools).bindingSha256
if (catalogA === catalogB) fail('CATALOG_UNCHANGED')
const systemHash = deriveBoxContextHash(proxyBody(continuedApi, apiTools, [{ type: 'text', text: 'changed' }]) as never, true)
if (systemHash === firstHash) fail('SYSTEM_HASH_UNCHANGED')

const stable = produce(pool, loadedC.messages as never)
if (stable.length !== 0) fail('STABLE_DELTA')
const added = produce(grown, loadedC.messages as never)
if (added.length !== 1 || added[0]?.addedNames.join() !== 'mcp__fixture__two') fail(`ADD_${JSON.stringify(added)}`)
const dropped = produce(removed, loadedC.messages as never)
if (dropped.length !== 1 || dropped[0]?.removedNames.join() !== 'mcp__fixture__one') fail(`REMOVE_${JSON.stringify(dropped)}`)

const full = produce(pool, [] as never)
if (full.length !== 1 || full[0]?.addedNames.join() !== 'mcp__fixture__one') fail('COMPACT_FULL')
const partialKept = produce(pool, loadedC.messages as never)
if (partialKept.length !== 0) fail('COMPACT_PARTIAL_REPEAT')
const partialDropped = produce(pool, [textUser] as never)
if (partialDropped.length !== 1) fail('COMPACT_PARTIAL_MISSING')

const sideQuery = await runQuery([createUserMessage({ content: 'side' })], 'claude-sonnet-4-5')
if (deltas(sideQuery.yielded).length !== 0) fail('SIDE_QUERY_ANNOUNCED')

const promptBox = getPrompt()
const promptAgain = getPrompt()
if (promptBox !== promptAgain) fail('PROMPT_DRIFT')
if (!promptBox.includes('<system-reminder>')) fail('PROMPT_HINT')
setMainLoopModelOverride('claude-sonnet-4-5')
if (!getPrompt().includes('<available-deferred-tools>')) fail('PROMPT_SIDE')
setMainLoopModelOverride(MODEL)

delete process.env.OC_MODEL_EXECUTION_DESCRIPTOR
if (produce(pool, [] as never).length !== 0) fail('NO_DESCRIPTOR_DELTA')
const bare = await runQuery([createUserMessage({ content: 'bare' })])
if (deltas(bare.yielded).length !== 0) fail('NO_DESCRIPTOR_QUERY')
const sessionD = randomUUID()
await openSession(sessionD)
const orphan = createAttachmentMessage({
  type: 'deferred_tools_delta',
  addedNames: ['mcp__fixture__one'],
  addedLines: ['mcp__fixture__one'],
  removedNames: [],
} as never)
await recordTranscript(stamp([createUserMessage({ content: 'drop me' }), orphan]) as never, undefined, undefined, undefined, true)
await flushSessionStorage()
const loadedD = await loadConversationForResume(sessionD, undefined)
if (!loadedD) fail('LOAD_D_EMPTY')
if (deltas(loadedD.messages).length !== 0) fail('UNSIGNED_PERSISTED')

process.env.OC_MODEL_EXECUTION_DESCRIPTOR = JSON.stringify({ ...descriptor, contextOwner: undefined })
if (produce(pool, [] as never).length !== 0) fail('UNSIGNED_OWNER_DELTA')
delete process.env.OC_MODEL_EXECUTION_DESCRIPTOR

const firstBody = JSON.parse(readFileSync('/home/agent/.openclaude/generated/ocv5-296-r17-growth-1.json', 'utf8'))
const secondBody = JSON.parse(readFileSync('/home/agent/.openclaude/generated/ocv5-296-r17-growth-2.json', 'utf8'))
const r17First = deriveBoxContextHash(firstBody)
const r17Prior = deriveBoxContextHash(secondBody, true)
if (r17First === r17Prior) fail('R17_RED_LOST')

console.log(JSON.stringify({
  ok: true,
  firstHash,
  priorHash,
  classify: classified.classification,
  catalogChanged: catalogA !== catalogB,
  schemaGuardWouldReject: changedHash !== firstHash,
  systemGuardWouldReject: systemHash !== firstHash,
  yielded: firstYielded.length,
  loadedA: deltas(loadedA.messages).length,
  loadedB: deltas(loadedB.messages).length,
  r17First,
  r17Prior,
  r17Equal: r17First === r17Prior,
}))
process.exit(0)
