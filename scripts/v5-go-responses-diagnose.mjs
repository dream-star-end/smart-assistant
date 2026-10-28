#!/usr/bin/env node
// Manual upstream diagnosis; NOT the G1 release/billing gate. Run via node --import tsx.
// No production imports run at module load; tests and --help never read credentials/call Go.
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { GO_CACHE_MODEL, goCachePrompts } from './lib/user-contract-go-cache.mjs'
import { traceGoResponsesBody } from './lib/go-responses-sse-trace.mjs'

const RESPONSE_LIMIT = 256 * 1024
const PREAMBLE = `# G1 synthetic cache diagnosis\n${Array.from({ length: 1536 }, (_, i) =>
  `Reference row ${i}: retain this stable context; answer the latest user instruction without tools.`,
).join('\n')}`

async function bridgeText(response) {
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > RESPONSE_LIMIT) throw new Error('diagnostic_output_limit')
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const events = Buffer.concat(chunks).toString('utf8').split('\n')
    .filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
  if (events.at(-1)?.type !== 'message_stop') throw new Error('diagnostic_no_message_stop')
  const text = events.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta')
    .map((e) => e.delta.text).join('')
  if (!text) throw new Error('diagnostic_no_text')
  return text
}

export async function diagnoseGoResponses({ key, fetchImpl, bridgeFactory, upstreamModel, emit, signal }) {
  const nonce = randomBytes(6).toString('hex')
  const session = randomUUID()
  const messages = []
  for (const [i, prompt] of goCachePrompts(nonce).entries()) {
    const started = performance.now()
    let upstream = null
    let httpStatus = null
    const turnSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    messages.push({ role: 'user', content: prompt })
    const tracedFetch = async (url, init) => {
      // Exactly one fetch. Do not retry HTTP errors, stream errors or sessions.
      const raw = await fetchImpl(url, init)
      httpStatus = raw.status
      return raw.ok && raw.body ? new Response(traceGoResponsesBody(raw.body, (s) => { upstream = s }), {
        status: raw.status, statusText: raw.statusText, headers: raw.headers,
      }) : raw
    }
    let reason = 'bridge_or_transport_error'
    try {
      const response = await bridgeFactory(tracedFetch)('unused', {
        method: 'POST', signal: turnSignal,
        headers: { 'x-api-key': key, 'x-opencode-session': session },
        body: JSON.stringify({ model: upstreamModel, system: PREAMBLE, messages }),
      })
      if (!response.ok) {
        reason = 'http_error'
        await response.body?.cancel()
        throw new Error('diagnostic_http_error')
      }
      const text = await bridgeText(response)
      messages.push({ role: 'assistant', content: text })
      emit({ model: GO_CACHE_MODEL, turn: i + 1, httpStatus, bridge: 'completed', upstream,
        elapsedMs: Math.round(performance.now() - started) })
    } catch (error) {
      if (turnSignal.aborted) reason = 'local_deadline_or_abort'
      else if (error?.message === 'OpenCode Go stream ended without a successful complete response') reason = 'bridge_incomplete_response'
      else if (error?.message === 'OpenCode Go returned an error event') reason = 'upstream_error_event'
      else if (error?.message === 'diagnostic_output_limit') reason = 'local_output_limit'
      // Never print arbitrary errors: JSON parsers and upstream errors can quote payloads.
      emit({ model: GO_CACHE_MODEL, turn: i + 1, httpStatus, bridge: 'rejected', reason, upstream,
        elapsedMs: Math.round(performance.now() - started) })
      return false
    }
  }
  return true
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log('After wait-for-trains reports FREE: node --import tsx scripts/v5-go-responses-diagnose.mjs --live --env-file /etc/openclaude/commercial-v5-selfhost.env\nOne synthetic three-turn Go session; not product G1 or billing proof. No retries. Metadata only.')
    return
  }
  if (args.length !== 3 || args[0] !== '--live' || args[1] !== '--env-file') throw new Error('arguments')
  const key = parseEnv(readFileSync(args[2], 'utf8')).OPENCODE_GO_API_KEY?.trim()
  if (!key) throw new Error('credential_missing')
  const { getStaticProvider } = await import('@openclaude/protocol')
  const { createOpenAIResponsesGoFetch } = await import('../packages/commercial/src/http/proxy/openAiResponsesGoBridge.js')
  const { STATIC_PROVIDER_META } = await import('../packages/commercial/src/http/proxy/staticProviderMeta.js')
  // This process uses Node's direct default dispatcher. Refuse if Go changes route policy.
  if (STATIC_PROVIDER_META.opencodego.egress !== 'direct') throw new Error('egress_policy_changed')
  const upstreamModel = getStaticProvider('opencodego').upstreamModelForRequest(GO_CACHE_MODEL)
  const ok = await diagnoseGoResponses({ key, fetchImpl: fetch, bridgeFactory: createOpenAIResponsesGoFetch,
    upstreamModel, emit: (summary) => console.log(JSON.stringify(summary)), signal: AbortSignal.timeout(300_000) })
  if (!ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Go diagnostic failed (details withheld); check arguments, local credential availability and route policy.'); process.exitCode = 1 })
}
