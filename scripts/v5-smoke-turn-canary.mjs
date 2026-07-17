// v5 部署 smoke:canary 账号驱动一个真实聊天 turn(WS 全链路)。
//
// 背景(2026-07-17 goal 事故):健康端点/调度器 smoke 全绿的同时,codex 引擎
// 100% turn 必挂 —— 没有任何一道门真正跑过一个 turn。本脚本作为激活后的
// smoke 硬门补上这个盲区:登录 canary → PUT 建会话(复刻前端行为,勿删,
// 纯 WS 新会话另有 master 侧 goal NOT_FOUND 语义)→ WS inbound.message →
// **三信号齐全**才算成功(收紧后,不再"见任一 text block 即过"):
//   ① sawText  —— 至少一个非空 text block(引擎真出了正文);
//   ② sawFinal —— outbound.message{isFinal:true} 干净收尾帧(webchat turn 终止契约);
//   ③ sawCost  —— outbound.cost_charged 计费到账(REQUIRE_COST=0 才放宽)。
// error 帧(outbound.error/outbound.turn_error/error)= 立即失败。
//
// 用法(在 kl-mirror 上、release 根目录为 cwd 运行,node >= 20):
//   node scripts/v5-smoke-turn-canary.mjs
// 环境变量:
//   V5_BASE(默认 http://127.0.0.1:18790)
//   V5_CANARY_EMAIL(默认 v5-canary@claudeai.chat)
//   V5_CANARY_PASSWORD_FILE(默认 /root/.secrets/v5-canary.password)
//   V5_TURN_MODEL(默认 gpt-5.6-sol —— codex 引擎侧,即 2026-07-17 的盲区面)
//   V5_TURN_ATTEMPTS(默认 8;容器冷启动时 bridge 会 close,需重连)
//   V5_TURN_SILENCE_MS(默认 90000;xhigh 思考档需要长窗;仅作兜底,判成靠三信号)
//   OC_CANARY_TURNSTILE_TOKEN(默认 'x' —— 依赖 canary 账号 turnstile bypass;换机/关 bypass 时注入真 token)
//   V5_CANARY_REQUIRE_COST(默认 1;canary 账号落免单套餐时置 0 放宽计费断言)
// 退出码:0=turn 三信号齐全;1=失败(错误帧/收尾或计费缺失/重试耗尽);2=配置错误。
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
// turnstile_token: 生产依赖 kl-mirror 上对 canary 账号的 turnstile bypass(登录校验放行 'x')。
// 若 bypass 关闭/换机,用 OC_CANARY_TURNSTILE_TOKEN 注入一个真实 token 覆盖。
const TURNSTILE_TOKEN = process.env.OC_CANARY_TURNSTILE_TOKEN ?? 'x'
// 计费到账断言(默认必开):turn 收尾后必须收到 outbound.cost_charged。仅当 canary 账号
// 落在"零边际成本/免单"套餐(finalizer 不产 cost_charged)时,才用 V5_CANARY_REQUIRE_COST=0
// 显式放宽(runbook 记载),避免计费断言把此类账号的部署门永久卡住。
const REQUIRE_COST = (process.env.V5_CANARY_REQUIRE_COST ?? '1') !== '0'

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
  body: JSON.stringify({ email: EMAIL, password, turnstile_token: TURNSTILE_TOKEN }),
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

// TURN_OK 判据(2026-07-17 收紧):不再"见任一 text block 即过"。三条硬信号缺一不可——
//   sawText  = 至少一个非空 text block(引擎真出了正文);
//   sawFinal = 收到干净收尾帧 outbound.message{isFinal:true}(webchat 的 turn 终止契约,
//              bridge userChatBridge.ts:4582;不是靠"静默即判终"这种弱信号);
//   sawCost  = 收尾后广播 outbound.cost_charged(计费真到账;REQUIRE_COST=0 才放宽)。
// 错误帧(outbound.error / outbound.turn_error / error)= 立即失败。
let sawText = false
let sawFinal = false
let sawCost = false
let sawError = null
const wsBase = BASE.replace(/^http/, 'ws')

const criteriaMet = () => sawText && sawFinal && (sawCost || !REQUIRE_COST)

const attempt = () => new Promise((resolve) => {
  const ws = new WebSocket(`${wsBase}/ws/user-chat-bridge`, ['bearer', token])
  let silence
  const finish = (r) => { clearTimeout(silence); try { ws.close() } catch {}; resolve(r) }
  const resetSilence = () => {
    clearTimeout(silence)    // 冷启动/长思考兜底:静默兜底关连接,真正判成靠下方三信号
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
      if (f.isFinal === true) sawFinal = true   // 干净收尾信号(cost_charged 在其后广播)
      if (f.error) sawError = JSON.stringify(f.error).slice(0, 300)
    }
    if (f.type === 'outbound.cost_charged') sawCost = true
    if (f.type === 'outbound.error' || f.type === 'outbound.turn_error' || f.type === 'error') {
      sawError = JSON.stringify(f).slice(0, 300)
    }
    // 三信号集齐即提前收连接,不必空等满 SILENCE_MS(cost_charged 通常是最后一帧)。
    if (criteriaMet()) finish('complete')
  }
  ws.onerror = () => {}
  ws.onclose = () => finish('closed')
})

for (let i = 1; i <= ATTEMPTS; i++) {
  const r = await attempt()
  if (sawError) { console.error(`turn-canary: TURN_FAILED ${sawError}`); process.exit(1) }
  if (criteriaMet()) {
    console.log(`turn-canary: TURN_OK model=${MODEL} text=${sawText} final=${sawFinal} cost_charged=${sawCost}`)
    process.exit(0)
  }
  if (r === 'closed' && !sawText && !sawFinal) {
    // bridge 在容器冷启动期间会直接关连接("container not ready",可能发生在
    // sys 帧之后):只要还没出任何正文/收尾信号,close 一律视为冷启动重连。真正的
    // turn 失败由错误帧显式暴露,turn 出了一半再断则落到下面的硬失败(不当冷启动重试)。
    console.log(`turn-canary: attempt ${i}/${ATTEMPTS} closed without text/final (container starting?), retrying`)
    await new Promise((s) => setTimeout(s, 6000))
    continue
  }
  // 出了部分信号但判据不齐 = 真故障,精确点名缺哪一条,不再重试掩盖。
  const missing = []
  if (!sawText) missing.push('text')
  if (!sawFinal) missing.push('final(isFinal 收尾帧)')
  if (REQUIRE_COST && !sawCost) missing.push('cost_charged(计费到账)')
  console.error(`turn-canary: TURN_INCOMPLETE after attempt ${i} (resolve=${r}; 缺:${missing.join(', ') || '<none>'}; text=${sawText} final=${sawFinal} cost=${sawCost})`)
  process.exit(1)
}
console.error('turn-canary: retries exhausted (container never became ready)')
process.exit(1)
