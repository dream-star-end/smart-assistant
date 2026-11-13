#!/usr/bin/env node
// OCV5-435 release gate (selfhost, after C1–C3): a Stop sent while the turn is accepted but
// its engine is still starting must stop that turn. The canary logs in through the product
// API, opens a new session (so the engine cold-starts), sends one message over the real chat
// socket and sends the browser's exact Stop control as soon as Master acks the admission.
// The defect this proves gone (INC-20261015-PRESTART-STOP-LOST) answered that Stop
// TURN_NOT_ACTIVE and let the turn run unseen: the model answered (or asked a question that
// hung in waiting_for_user) after the user had stopped it. The stopped turn must commit as
// interrupted with the user-stop notice (a crash also commits as interrupted, with another
// notice) and must never ask the user anything; a follow-up turn in the same session must
// then commit as turn_completed. The Stop can reach the gateway just before or just
// after the message itself, so the verdict reads the committed outcome, not the receipt.
// Prints TAP only; never prints credentials, tokens or response bodies.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import WebSocket from 'ws'
import { tapResult } from './lib/user-contract.mjs'
import { authorizeContractModelSwitch } from './lib/user-contract-switch-cost.mjs'

const STOP_CASE = 'S1 Stop sent while the engine starts ends the turn before the model answers'
const MODEL = 'gpt-6-luna'
const TOTAL_TIMEOUT = 240_000
const ACK_TIMEOUT = 20_000
const FINAL_TIMEOUT = 90_000
const QUIET_MS = 5_000
const TURN_TIMEOUT = 120_000
/** SessionManager.interrupt(..., 'user') persists exactly this reason (USER_CANCELLED). */
const USER_STOP_NOTICE = '本轮已由用户停止。'
const base = new URL(process.env.V5_E2E_BASE || 'http://127.0.0.1:18790').origin
const email = process.env.V5_CANARY_EMAIL || 'v5-selfhost-canary@claudeai.chat'
const passwordFile =
  process.env.V5_CANARY_PASSWORD_FILE || '/etc/openclaude/selfhost-canary.password'
const started = performance.now()
const hard = setTimeout(() => {
  console.log(tapResult(false, 1, STOP_CASE, performance.now() - started, 'Stop contract exceeded total timeout'))
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

function openSocket(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/user-chat-bridge`, ['bearer', token])
    ws.once('open', () => resolve(ws))
    ws.once('error', () => reject(new Error('chat socket error')))
  })
}

function messageFrame(peer, cmid, text) {
  return {
    type: 'inbound.message',
    channel: 'webchat',
    peer: { id: peer, kind: 'dm' },
    agentId: 'main',
    clientMessageId: cmid,
    // Same send identity the browser uses for a first attempt.
    idempotencyKey: `web:${cmid}:0`,
    content: { text },
    model: MODEL,
    ts: Date.now(),
  }
}

/** Model output of any kind for this exact turn: text, thinking, tools, a question or a wait. */
function modelOutput(frame) {
  if (frame.type === 'outbound.permission_request') return 'permission_request'
  if (frame.type === 'outbound.turn_status' && frame.status === 'waiting_for_user') return 'waiting_for_user'
  if (frame.type !== 'outbound.message') return null
  const kinds = (frame.blocks ?? [])
    .filter((b) => b && ['text', 'thinking', 'tool_use', 'tool_result'].includes(b.kind))
    // The stop notice itself ("[error] 本轮已由用户停止。") is not model output.
    .filter((b) => b.kind !== 'text' || !/^(\[error\]|$)/.test(String(b.text ?? '').trim()))
    .map((b) => b.kind)
  return kinds.length > 0 ? kinds.join('+') : null
}

async function stoppedTurn(token, peer, cmid) {
  const ws = await openSocket(token)
  const own = []
  let ackAt = 0
  let finalAt = 0
  let committed = null
  let stopSentAt = 0
  ws.on('message', (raw) => {
    let f
    try {
      f = JSON.parse(String(raw))
    } catch {
      return
    }
    if (f?.peer?.id !== peer || f.clientMessageId !== cmid) return
    own.push({ at: Date.now(), frame: f })
    if (f.type === 'outbound.ack' && f.admitted === true && !ackAt) ackAt = Date.now()
    if (f.type === 'outbound.message' && f.isFinal === true && f.meta?.reconcileSource === 'tape_commit') {
      committed = f.meta.reconcile
      finalAt = Date.now()
    }
  })
  try {
    ws.send(JSON.stringify(messageFrame(peer, cmid, '请只回复一个字「好」，不使用任何工具。')))
    const ackDeadline = Date.now() + ACK_TIMEOUT
    while (!ackAt && Date.now() < ackDeadline) await new Promise((r) => setTimeout(r, 50))
    if (!ackAt) throw new Error('message was not admitted')
    if (own.some((e) => e.frame.type === 'outbound.turn_status' || e.frame.type === 'outbound.message'))
      console.log('# note engine produced frames before the Stop; this run covers a running-turn Stop')
    stopSentAt = Date.now()
    ws.send(
      JSON.stringify({
        type: 'inbound.control.stop',
        controlId: `control:stop:${cmid}`,
        channel: 'webchat',
        peer: { id: peer, kind: 'dm' },
        agentId: 'main',
        clientMessageId: cmid,
      }),
    )
    const finalDeadline = Date.now() + FINAL_TIMEOUT
    while (!finalAt && Date.now() < finalDeadline) await new Promise((r) => setTimeout(r, 100))
    if (!finalAt) throw new Error('stopped turn never committed')
    await new Promise((r) => setTimeout(r, QUIET_MS))
  } finally {
    ws.close()
  }
  const outputs = own
    .filter((e) => e.at >= stopSentAt)
    .map((e) => modelOutput(e.frame))
    .filter(Boolean)
  const receipts = own
    .filter((e) => e.frame.type === 'outbound.control.receipt')
    .map((e) => `${e.frame.status}${e.frame.errorCode ? `/${e.frame.errorCode}` : ''}`)
  console.log(
    `# stop session=${peer} ack_to_stop_ms=${stopSentAt - ackAt} stop_to_commit_ms=${finalAt - stopSentAt} committed=${committed} receipts=${receipts.join(',') || 'none'} outputs_after_stop=${outputs.join(',') || 'none'}`,
  )
  if (committed !== 'interrupted') {
    throw new Error(`stopped turn committed as ${committed} (output after Stop: ${[...new Set(outputs)].join(',') || 'none'})`)
  }
  const userStopped = own.some(
    (e) => e.frame.type === 'outbound.message' &&
      (e.frame.blocks ?? []).some((b) => b?.kind === 'text' && String(b.text ?? '').includes(USER_STOP_NOTICE)),
  )
  if (!userStopped) throw new Error('stopped turn ended without the user-stop notice (crashed or interrupted by the system)')
  const waits = outputs.filter((kind) => kind === 'permission_request' || kind === 'waiting_for_user')
  if (waits.length > 0) throw new Error(`stopped turn still asked the user: ${[...new Set(waits)].join(',')}`)
}

async function plainTurn(token, peer, cmid, text) {
  const frame = messageFrame(peer, cmid, text)
  const approval = await authorizeContractModelSwitch((path, init) => api(token, path, init), {
    sessionId: peer, requestId: cmid, targetModel: MODEL, agentId: 'main', text, mediaCount: 0,
  })
  if (approval.consent) frame.modelSwitchConsent = approval.consent
  console.log(`# follow-up cost mode=${approval.mode} confirmed=${approval.confirmed}`)
  return new Promise((resolve, reject) => {
    openSocket(token).then((ws) => {
      let done = false
      const timer = setTimeout(() => finish(new Error('follow-up turn did not complete')), TURN_TIMEOUT)
      function finish(error) {
        if (done) return
        done = true
        clearTimeout(timer)
        ws.close()
        error ? reject(error) : resolve()
      }
      ws.on('message', (raw) => {
        let f
        try {
          f = JSON.parse(String(raw))
        } catch {
          return
        }
        if (f?.peer?.id !== peer || f.clientMessageId !== cmid) return
        if (f.error || ['outbound.error', 'outbound.turn_error', 'error'].includes(f.type))
          finish(new Error(`follow-up turn failed: ${f.error?.code ?? f.code ?? f.type}`))
        else if (f.type === 'outbound.message' && f.isFinal === true && f.meta?.reconcileSource === 'tape_commit')
          f.meta.reconcile === 'turn_completed'
            ? finish()
            : finish(new Error(`follow-up turn committed as ${f.meta.reconcile}`))
      })
      ws.on('close', () => finish(new Error('chat socket closed before the follow-up final')))
      ws.send(JSON.stringify(frame))
    }, reject)
  })
}

try {
  const password = readFileSync(passwordFile, 'utf8').trim()
  if (!password) throw new Error('Canary password file is empty')
  // Placeholder token: passes only through the account-level Turnstile allowlist the canary is
  // on (same convention as v5-go-cache-contract.mjs); any other account is refused.
  const identity = await api(null, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password, turnstile_token: 'x' }),
  })
  if (String(identity.user_id ?? identity.user?.id ?? '') !== '765') throw new Error('Stop contract requires canary uid765')
  const token = identity.access_token
  if (typeof token !== 'string' || !token) throw new Error('login returned no access token')
  const models = (await api(token, '/api/public/models')).models ?? []
  if (!models.some((m) => m.id === MODEL)) throw new Error(`model ${MODEL} is not in the canary's catalog`)
  const nonce = randomBytes(6).toString('hex')
  const peer = `g435${Date.now().toString(36)}${nonce}`
  await api(token, `/api/sessions/${peer}`, {
    method: 'PUT',
    body: JSON.stringify({ title: 'OCV5-435 release stop check', agentId: 'main', modelId: MODEL }),
  })
  await stoppedTurn(token, peer, `m-g435-${nonce}-1`)
  await plainTurn(token, peer, `m-g435-${nonce}-2`, '请只回复数字 2，不使用任何工具。')
  console.log(tapResult(true, 1, STOP_CASE, performance.now() - started))
  clearTimeout(hard)
} catch (error) {
  console.log(tapResult(false, 1, STOP_CASE, performance.now() - started, error?.message ?? 'Stop contract failure'))
  clearTimeout(hard)
  process.exitCode = 1
}
