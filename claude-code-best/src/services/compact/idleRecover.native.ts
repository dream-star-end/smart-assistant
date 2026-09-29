/** Real store + loader. Not an in-memory stand-in. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const root = mkdtempSync(join(tmpdir(), 'idle-loader-'))
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
process.env.HOME = root
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'

const { switchSession } = await import('../../bootstrap/state.js')
const { recordTranscript, flushSessionStorage } = await import('../../utils/sessionStorage.js')
const { loadConversationForResume } = await import('../../utils/conversationRecovery.js')
const { annotateBoundaryWithPreservedSegment, buildPostCompactMessages } = await import('./compact.js')
const { buildIdleCompactionResult, selectIdlePreserve, writeIdleNativeFile } = await import('./idleRecover.js')

const sessionId = randomUUID()
switchSession(sessionId, join(root, 'config', 'projects', 'p'))
const user = {
  type: 'user' as const, uuid: randomUUID(),
  message: { role: 'user', content: 'keep the image and the tool' },
}
const tool = {
  type: 'assistant' as const, uuid: randomUUID(), parentUuid: user.uuid,
  message: { role: 'assistant', content: [
    { type: 'text', text: 'reading' },
    { type: 'tool_use', id: 'toolu_native', name: 'Read', input: { file_path: 'a.ts' } },
  ] },
}
const result = {
  type: 'user' as const, uuid: randomUUID(), parentUuid: tool.uuid,
  sourceToolAssistantUUID: tool.uuid,
  message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_native', content: 'file body' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aaaa' } },
  ] },
}
const preserved = selectIdlePreserve([user, tool, result])
const home = join(root, 'idle-home')
const opId = createHash('sha256').update('op').digest('hex')
writeIdleNativeFile(join(home, 'idle-native', encodeURIComponent(sessionId), 'rev.json'), {
  v: 1, opId, revision: 'rev', sessionId, summaryText: 'native summary', modelCalls: 1,
  frozenTail: preserved.tail, attachments: preserved.attachments,
})
const built = buildIdleCompactionResult({
  v: 1, opId, revision: 'rev', sessionId, summaryText: 'native summary', modelCalls: 1,
  frozenTail: preserved.tail, attachments: preserved.attachments,
}, [user, tool, result], annotateBoundaryWithPreservedSegment)
if (!built.result.boundaryMarker.compactMetadata.preservedSegment) throw new Error('NO_SEGMENT')
const post = buildPostCompactMessages(built.result)
const keptIds = new Set((built.result.messagesToKeep ?? []).map((message) => message.uuid))
await recordTranscript(post.filter((message) => !keptIds.has(message.uuid)), undefined, undefined, undefined, true)
await recordTranscript(built.result.messagesToKeep ?? [], undefined, undefined, undefined, true)
await flushSessionStorage()
const loaded = await loadConversationForResume(sessionId, undefined)
if (!loaded) throw new Error('LOAD_EMPTY')
const byId = new Map(loaded.messages.map((message) => [message.uuid, message]))
const missing = post.filter((message) => !byId.has(message.uuid)).map((message) => message.uuid)
if (missing.length) {
  console.log(JSON.stringify({ missing, loaded: loaded.messages.map((m) => ({ uuid: m.uuid, type: m.type })) }, null, 2))
  throw new Error('LOADER_MISSING')
}
for (const message of post) {
  const found = byId.get(message.uuid)!
  const want = JSON.stringify(message.message?.content ?? message.content ?? null)
  const got = JSON.stringify(found.message?.content ?? found.content ?? null)
  if (want !== got) {
    console.log(JSON.stringify({ uuid: message.uuid, want, got }))
    throw new Error('LOADER_CONTENT')
  }
}
const order = loaded.messages.filter((message) => post.some((item) => item.uuid === message.uuid)).map((message) => message.uuid)
if (order.join() !== post.map((message) => message.uuid).join()) throw new Error('LOADER_ORDER')
console.log(JSON.stringify({ ok: true, messages: post.length }))
process.exit(0)
