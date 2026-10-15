#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
// OCV5-432 release gate (selfhost, after C1–C3): a real multi-turn chat on an OpenCode Go
// /responses model must read the upstream prompt cache. The canary logs in through the
// product API, runs three plain turns in one new session over the real chat socket, then
// reads its own per-session usage (GET /api/me/usage). The defect this proves gone
// (INC-20261015-GO-CACHE-PREFIX) wrote the whole prompt on every request and read 0.
// Prints TAP only; never prints credentials, tokens or response bodies.
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import WebSocket from 'ws'
import { assessGoCache, goCachePrompts, parseGoCacheModel } from './lib/user-contract-go-cache.mjs'
import { tapResult } from './lib/user-contract.mjs'

const GO_CACHE_CASE = 'G1 OpenCode Go prompt cache hits across turns'

const TOTAL_TIMEOUT = 300_000
const TURN_TIMEOUT = 120_000
const base = new URL(process.env.V5_E2E_BASE || 'http://127.0.0.1:18790').origin
const email = process.env.V5_CANARY_EMAIL || 'v5-selfhost-canary@claudeai.chat'
const passwordFile =
  process.env.V5_CANARY_PASSWORD_FILE || '/etc/openclaude/selfhost-canary.password'
const started = performance.now()
const hard = setTimeout(() => {
  console.log(
    tapResult(
      false,
      1,
      GO_CACHE_CASE,
      performance.now() - started,
      'Go-cache contract exceeded total timeout',
    ),
  )
  process.exit(1)
}, TOTAL_TIMEOUT)

async function api(token, path, init = {}) {
  const r = await fetch(base + path, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  })
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path.split('?')[0]} HTTP ${r.status}`)
  return r.json()
}

function turn(token, peer, model, cmid, text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/user-chat-bridge`, [
      'bearer',
      token,
    ])
    let done = false
    const timer = setTimeout(() => finish(new Error('turn did not complete')), TURN_TIMEOUT)
    function finish(error) {
      if (done) return
      done = true
      clearTimeout(timer)
      ws.close()
      error ? reject(error) : resolve()
    }
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          type: 'inbound.message',
          channel: 'webchat',
          peer: { id: peer, kind: 'dm' },
          agentId: 'main',
          clientMessageId: cmid,
          content: { text },
          model,
          ts: Date.now(),
        }),
      ),
    )
    ws.on('message', (raw) => {
      let f
      try {
        f = JSON.parse(String(raw))
      } catch {
        return
      }
      if (f?.peer?.id !== peer || f.clientMessageId !== cmid) return
      if (f.error || ['outbound.error', 'outbound.turn_error', 'error'].includes(f.type))
        finish(new Error(`turn failed: ${f.error?.code ?? f.code ?? f.type}`))
      else if (f.type === 'outbound.message' && f.isFinal === true) finish()
    })
    ws.on('error', () => finish(new Error('chat socket error')))
    ws.on('close', () => finish(new Error('chat socket closed before the final message')))
  })
}

try {
  const model = parseGoCacheModel(process.env.V5_GO_CACHE_MODEL)
  const password = readFileSync(passwordFile, 'utf8').trim()
  if (!password) throw new Error('Canary password file is empty')
  // Placeholder token: passes only through the account-level Turnstile allowlist the canary is
  // on (same convention as v5-e2e-journey-canary.mjs); any other account is refused.
  const { access_token: token } = await api(null, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password, turnstile_token: 'x' }),
  })
  if (typeof token !== 'string' || !token) throw new Error('login returned no access token')
  const models = (await api(token, '/api/public/models')).models ?? []
  if (!models.some((m) => m.id === model))
    throw new Error(`model ${model} is not in the canary's catalog`)
  const nonce = randomBytes(6).toString('hex')
  const peer = `g432${Date.now().toString(36)}${nonce}`
  await api(token, `/api/sessions/${peer}`, {
    method: 'PUT',
    body: JSON.stringify({
      title: 'OCV5-432 release cache check',
      agentId: 'main',
      modelId: model,
    }),
  })
  const prompts = goCachePrompts(nonce)
  for (const [i, text] of prompts.entries())
    await turn(token, peer, model, `m-g432-${nonce}-${i + 1}`, text)
  // Usage is written when each request finalizes; give the last one a bounded moment.
  let verdict
  for (let i = 0; i < 30; i++) {
    const usage = await api(token, '/api/me/usage?sessions_limit=20')
    verdict = assessGoCache((usage.sessions?.rows ?? []).find((r) => r.session_id === peer))
    if (verdict.ok || !/billed requests|no usage row/.test(verdict.reason)) break
    await new Promise((r) => setTimeout(r, 1_000))
  }
  console.log(
    `# go-cache model=${model} session=${peer} requests=${verdict.requests} prompt=${verdict.prompt} cache_read=${verdict.read} cache_write=${verdict.write} ratio=${verdict.ratio}`,
  )
  if (!verdict.ok) throw new Error(verdict.reason)
  console.log(tapResult(true, 1, GO_CACHE_CASE, performance.now() - started))
  clearTimeout(hard)
} catch (error) {
  console.log(
    tapResult(
      false,
      1,
      GO_CACHE_CASE,
      performance.now() - started,
      error?.message ?? 'Go-cache contract failure',
    ),
  )
  clearTimeout(hard)
  process.exitCode = 1
}
