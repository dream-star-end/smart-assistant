// Private synthetic app-server over real stdio JSON-RPC. Never calls a model.
import { existsSync, appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const [artifact, log, mode] = process.argv.slice(2)
const reply = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.id == null) return
  appendFileSync(log, JSON.stringify({ method: request.method, threadId: request.params?.threadId }) + '\n')
  if (request.method === 'thread/resume' && !existsSync(artifact)) {
    reply({ id: request.id, error: { code: -32600, message: `no rollout found for thread id ${request.params.threadId}` } })
  } else if (request.method === 'thread/resume' || request.method === 'thread/start') {
    reply({ id: request.id, result: { thread: { id: request.params?.threadId ?? 'private-fresh-thread' } } })
  } else if (request.method === 'turn/start') {
    reply({ id: request.id, result: { turn: { id: 'private-turn' } } })
    setTimeout(() => {
      if (mode === 'success') reply({ method: 'item/agentMessage/delta', params: {
        threadId: request.params.threadId, turnId: 'private-turn', itemId: 'private-message',
        delta: 'PRIVATE_NATIVE_CONTINUATION_RESULT',
      } })
      reply({ method: 'turn/completed', params: { threadId: request.params.threadId,
      turn: { id: 'private-turn', status: mode === 'context' ? 'failed' : 'completed',
        ...(mode === 'context' ? { error: { message: 'context window exceeded' } } : {}) } } })
    }, 10)
  } else reply({ id: request.id, result: {} })
})
