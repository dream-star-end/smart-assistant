// v5 部署 smoke:canary 账号驱动一个真实聊天 turn(WS 全链路)。
//
// 背景(2026-07-17 goal 事故):健康端点/调度器 smoke 全绿的同时,codex 引擎
// 100% turn 必挂 —— 没有任何一道门真正跑过一个 turn。本脚本作为激活后的
// smoke 硬门补上这个盲区:登录 canary → PUT 建会话(复刻前端行为,勿删,
// 纯 WS 新会话另有 master 侧 goal NOT_FOUND 语义)→ WS inbound.message →
// 等 text block = 成功;error 帧/静默 = 失败。
//
// 用法(在 kl-mirror 上、release 根目录为 cwd 运行,node >= 20):
//   node scripts/v5-smoke-turn-canary.mjs
// 环境变量:
//   V5_BASE(默认 http://127.0.0.1:18790)
//   V5_CANARY_EMAIL(默认 v5-canary@claudeai.chat)
//   V5_CANARY_PASSWORD_FILE(默认 /root/.secrets/v5-canary.password)
//   V5_TURN_MODEL(默认 gpt-5.6-sol —— codex 引擎侧,即 2026-07-17 的盲区面)
//   V5_TURN_ATTEMPTS(默认 8;容器冷启动时 bridge 会 close,需重连)
//   V5_TURN_SILENCE_MS(默认 90000;xhigh 思考档需要长窗)
// 退出码:0=turn 成功出正文;1=失败(错误帧/静默/重试耗尽);2=配置错误。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const require_ = createRequire(join(process.cwd(), 'package.json'))
const { WebSocket } = require_('ws')

const BASE = process.env.V5_BASE ?? 'http://127.0.0.1:18790'
const EMAIL = process.env.V5_CANARY_EMAIL ?? 'v5-canary@claudeai.chat'
const PASSWORD_FILE = process.env.V5_CANARY_PASSWORD_FILE ?? '/root/.secrets/v5-canary.password'
const MODEL = process.env.V5_TURN_MODEL ?? 'gpt-5.6-sol'
const ATTEMPTS = Number(process.env.V5_TURN_ATTEMPTS ?? 8)
const SILENCE_MS = Number(process.env.V5_TURN_SILENCE_MS ?? 90000)

let password
try {
  password = readFileSync(PASSWORD_FILE, 'utf8').trim()
} catch (err) {
  console.error(`turn-canary: cannot read ${PASSWORD_FILE}: ${err.message}`)
  process.exit(2)
}
if (!password) { console.error('turn-canary: empty canary password'); process.exit(2) }

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password, turnstile_token: 'x' }),
})
if (!login.ok) {
  console.error(`turn-canary: login failed ${login.status}: ${(await login.text()).slice(0, 200)}`)
  process.exit(1)
}
const { access_token: token } = await login.json()
console.log('turn-canary: login ok')

const peerId = `smoketurn${Date.now().toString(36)}`
const put = await fetch(`${BASE}/api/sessions/${peerId}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ title: 'deploy smoke turn canary', model: MODEL }),
})
if (!put.ok) {
  console.error(`turn-canary: session PUT failed ${put.status}`)
  process.exit(1)
}

let sawText = false
let sawCost = false
let sawError = null
const wsBase = BASE.replace(/^http/, 'ws')

const attempt = () => new Promise((resolve) => {
  const ws = new WebSocket(`${wsBase}/ws/user-chat-bridge`, ['bearer', token])
  let silence
  const finish = (r) => { clearTimeout(silence); try { ws.close() } catch {}; resolve(r) }
  const resetSilence = () => {
    clearTimeout(silence)    // webchat 不发 isFinal:静默即判终(在册契约)
    silence = setTimeout(() => finish('silence'), SILENCE_MS)
  }
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'inbound.message',
      channel: 'webchat',
      peer: { id: peerId, kind: 'dm' },
      content: { text: '请回答:1+1等于几?只回答数字。' },
      ts: Date.now(),
      model: MODEL,
    }))
    resetSilence()
  }
  ws.onmessage = (ev) => {
    resetSilence()
    let f
    try { f = JSON.parse(ev.data) } catch { return }
    if (f.type === 'outbound.message') {
      for (const b of f.blocks ?? []) {
        if (b.kind === 'text' && b.text?.trim()) sawText = true
      }
      if (f.error) sawError = JSON.stringify(f.error).slice(0, 300)
    }
    if (f.type === 'outbound.cost_charged') sawCost = true
    if (f.type === 'error' || f.type === 'outbound.turn_error') {
      sawError = JSON.stringify(f).slice(0, 300)
    }
  }
  ws.onerror = () => {}
  ws.onclose = () => finish('closed')
})

for (let i = 1; i <= ATTEMPTS; i++) {
  const r = await attempt()
  if (sawError) { console.error(`turn-canary: TURN_FAILED ${sawError}`); process.exit(1) }
  if (sawText) {
    console.log(`turn-canary: TURN_OK model=${MODEL} cost_charged=${sawCost}`)
    process.exit(0)
  }
  if (r === 'closed') {
    // bridge 在容器冷启动期间会直接关连接("container not ready",可能发生在
    // sys 帧之后):只要还没出正文/错误,close 一律视为冷启动重连。真正的
    // turn 失败由错误帧显式暴露,不会走到这里。
    console.log(`turn-canary: attempt ${i}/${ATTEMPTS} closed without text/error (container starting?), retrying`)
    await new Promise((s) => setTimeout(s, 6000))
    continue
  }
  console.error(`turn-canary: TURN_SILENT after attempt ${i}`)
  process.exit(1)
}
console.error('turn-canary: retries exhausted (container never became ready)')
process.exit(1)
