/** Existing history → compact command → native loader.
 * Does not call buildIdleCompactionResult or recordTranscript's 5th argument itself.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const root = mkdtempSync(join(tmpdir(), 'idle-loader-'))
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
process.env.HOME = root
process.env.USER_TYPE = 'ant'
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'

const { switchSession } = await import('../../bootstrap/state.js')
const { flushSessionStorage } = await import('../../utils/sessionStorage.js')
const { loadConversationForResume } = await import('../../utils/conversationRecovery.js')
const { readIdleNativeFile, writeIdleNativeFile, IDLE_COMPACT_INSTRUCTIONS } = await import('./idleRecover.js')
const { call } = await import('../../commands/compact/compact.js')

const home = join(root, 'idle-home')
process.env.OPENCLAUDE_HOME = home

function message(uuid: string, content: string | Array<Record<string, unknown>>, role: 'user' | 'assistant' = 'user') {
  return {
    type: role === 'assistant' ? 'assistant' as const : 'user' as const,
    uuid,
    message: { role, content },
  }
}

async function runCase(sessionId: string, messages: ReturnType<typeof message>[], summary: string | undefined) {
  switchSession(sessionId, join(root, 'config', 'projects', 'p'))
  const { recordTranscript, resetSessionFilePointer } = await import('../../utils/sessionStorage.js')
  await resetSessionFilePointer()
  await recordTranscript(messages as never)
  await flushSessionStorage()
  const opId = createHash('sha256').update(sessionId).digest('hex')
  writeIdleNativeFile(join(home, 'idle-native', encodeURIComponent(sessionId), 'rev.json'), {
    v: 1,
    opId,
    revision: 'rev',
    sessionId,
    ...(summary ? { summaryText: summary } : {}),
    modelCalls: summary ? 1 : 0,
    frozenTail: [],
    attachments: [],
  })
  const context = {
    messages,
    abortController: new AbortController(),
    options: { verbose: true, mainLoopModel: 'test', tools: [], mcpClients: [] },
    getAppState: () => ({ toolPermissionContext: { additionalWorkingDirectories: new Map() } }),
    setAppState: () => {},
    readFileState: new Map(),
  }
  const result = await call(IDLE_COMPACT_INSTRUCTIONS, context as never)
  return { result, opId, sessionId }
}

const prefixId = randomUUID()
const toolId = randomUUID()
const imageId = randomUUID()
const chunk = 'x'.repeat(128 * 1024)
const history = [
  message(prefixId, chunk),
  ...Array.from({ length: 63 }, () => message(randomUUID(), chunk)),
  message(randomUUID(), 'recent note '.repeat(20)),
  message(toolId, [
    { type: 'text', text: 'reading' },
    { type: 'tool_use', id: 'toolu_native', name: 'Read', input: { file_path: 'a.ts' } },
  ], 'assistant'),
  message(imageId, [
    { type: 'tool_result', tool_use_id: 'toolu_native', content: 'file body' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aaaa' } },
  ]),
]
const before = JSON.stringify(history).length
const largeSession = randomUUID()
const large = await runCase(largeSession, history, 'native summary')
if (large.result.type !== 'compact') throw new Error(`LARGE_${large.result.type}`)
await flushSessionStorage()
const loaded = await loadConversationForResume(largeSession, undefined)
if (!loaded) throw new Error('LOAD_EMPTY')
const ids = new Set(loaded.messages.map((row) => row.uuid))
if (ids.has(prefixId)) throw new Error('PREFIX_KEPT')
if (!ids.has(toolId) || !ids.has(imageId)) throw new Error('TAIL_MISSING')
const image = loaded.messages.find((row) => row.uuid === imageId)
const imageJson = JSON.stringify(image?.message?.content ?? null)
if (!imageJson.includes('aaaa') || !imageJson.includes('toolu_native')) throw new Error('IMAGE_BYTES')
const tool = loaded.messages.find((row) => row.uuid === toolId)
if (tool?.type !== 'assistant') throw new Error('TOOL_ROLE')
const summary = loaded.messages.find((row) => row.isCompactSummary)
if (!summary) throw new Error('SUMMARY_MISSING')
const after = JSON.stringify(loaded.messages).length
if (after >= before / 2) throw new Error(`NOT_SHRUNK ${before} ${after}`)
const file = readIdleNativeFile(join(home, 'idle-native', encodeURIComponent(largeSession), 'rev.json'))
if (!file.applied || file.modelCalls !== 1) throw new Error('APPLIED')

process.env.CLAUDE_CODE_EXTRA_METADATA = JSON.stringify({ oc_turn_key: large.opId })
const again = await call(IDLE_COMPACT_INSTRUCTIONS, {
  messages: history,
  abortController: new AbortController(),
  options: { verbose: true, mainLoopModel: 'test', tools: [], mcpClients: [] },
  getAppState: () => ({ toolPermissionContext: { additionalWorkingDirectories: new Map() } }),
  setAppState: () => {},
  readFileState: new Map(),
} as never)
if (again.type !== 'compact') throw new Error(`RETRY_${again.type}`)
const reread = readIdleNativeFile(join(home, 'idle-native', encodeURIComponent(largeSession), 'rev.json'))
if (reread.modelCalls !== 1) throw new Error('RESUMMARIZED')

delete process.env.CLAUDE_CODE_EXTRA_METADATA
const shortSession = randomUUID()
const short = await runCase(shortSession, [message(randomUUID(), 'only six thousand '.repeat(40))], undefined)
if (short.result.type !== 'skip') throw new Error(`SHORT_${short.result.type}`)
const shortFile = readIdleNativeFile(join(home, 'idle-native', encodeURIComponent(shortSession), 'rev.json'))
if (!shortFile.applied || shortFile.summaryText) throw new Error('SHORT_PENDING')

const parallelPrefix = randomUUID()
const parallelA = randomUUID()
const parallelB = randomUUID()
const parallelAr = randomUUID()
const parallelBr = randomUUID()
const parallel = [
  message(parallelPrefix, 'long user context '.repeat(45_000)),
  {
    type: 'assistant' as const, uuid: parallelA,
    message: { role: 'assistant' as const, id: 'same-api-response', content: [
      { type: 'tool_use', id: 'toolA', name: 'Read', input: { file_path: 'a' } },
    ] },
  },
  {
    type: 'assistant' as const, uuid: parallelB,
    message: { role: 'assistant' as const, id: 'same-api-response', content: [
      { type: 'tool_use', id: 'toolB', name: 'Read', input: { file_path: 'b' } },
    ] },
  },
  message(parallelAr, [
    { type: 'tool_result', tool_use_id: 'toolA', content: 'x'.repeat(200_000) },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'bbbb' } },
  ]),
  message(parallelBr, [
    { type: 'tool_result', tool_use_id: 'toolB', content: 'small result' },
  ]),
]
const parallelRun = await runCase(randomUUID(), parallel, 'saved parallel summary')
if (parallelRun.result.type !== 'compact') throw new Error(`PARALLEL_${parallelRun.result.type}`)
await flushSessionStorage()
const parallelLoaded = await loadConversationForResume(parallelRun.sessionId, undefined)
if (!parallelLoaded) throw new Error('PARALLEL_LOAD_EMPTY')
const parallelIds = parallelLoaded.messages.map((row) => row.uuid)
if (parallelIds.includes(parallelPrefix)) throw new Error('PARALLEL_PREFIX_KEPT')
const parallelOrder = [parallelA, parallelB, parallelAr, parallelBr].filter((id) => parallelIds.includes(id))
if (parallelOrder.join() !== [parallelA, parallelB, parallelAr, parallelBr].join()) {
  throw new Error(`PARALLEL_ORDER ${parallelOrder.join(',')}`)
}
const parallelImage = JSON.stringify(parallelLoaded.messages.find((row) => row.uuid === parallelAr)?.message?.content ?? null)
if (!parallelImage.includes('bbbb') || !parallelImage.includes('toolA')) throw new Error('PARALLEL_BYTES')

console.log(JSON.stringify({
  ok: true,
  before,
  after,
  loaded: loaded.messages.length,
  keptTail: file.frozenTail.length,
  short: short.result.type,
  parallel: parallelOrder.length,
}))
process.exit(0)
