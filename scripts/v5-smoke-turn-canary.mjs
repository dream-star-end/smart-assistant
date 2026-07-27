// v5 部署 smoke:canary 账号驱动一个真实聊天 turn(WS 全链路)。
//
// 背景(2026-07-17 goal 事故):健康端点/调度器 smoke 全绿的同时,codex 引擎
// 100% turn 必挂 —— 没有任何一道门真正跑过一个 turn。本脚本作为激活后的
// smoke 硬门补上这个盲区:登录 canary → PUT 建会话(复刻前端行为,勿删,
// 纯 WS 新会话另有 master 侧 goal NOT_FOUND 语义)→ WS inbound.message →
// **三信号齐全**才算成功(收紧后,不再"见任一 text block 即过"):
//   ① exactText——最终正文精确为“2”(引擎真执行了题目,而非任意占位文本);
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
//   V5_CANARY_ALLOW_LEDGER_COST_EVIDENCE(默认 0;仅供 0% candidate 的 CCB
//     探针使用。exactText+final 到齐但 live cost frame 因 control VIP 仍归旧 active
//     而不可达时,输出唯一 session/model proof 并以 rc=3 交给 deploy 脚本做精确 DB 核验)
//   OC_CANARY_TURNSTILE_TOKEN(默认 'x' —— 依赖 canary 邮箱在线上 TURNSTILE_BYPASS_ACCOUNTS
//     账号白名单里;换机时把新 canary 邮箱加进该 env 键即可,不要再打开全局旁路)
//   V5_CANARY_REQUIRE_COST(默认 1;canary 账号落免单套餐时置 0 放宽计费断言)
// 退出码:0=turn 三信号齐全;1=失败(错误帧/收尾或计费缺失/重试耗尽);2=配置错误;
//   3=仅缺 live cost frame,且已输出供 deploy 精确核验的 candidate ledger proof。
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
const ALLOW_LEDGER_COST_EVIDENCE =
  (process.env.V5_CANARY_ALLOW_LEDGER_COST_EVIDENCE ?? '0') === '1'
const LEDGER_COST_GRACE_MS = 5_000
// turnstile_token: 生产走**账号级**白名单放行占位 token —— canary 邮箱必须在
// TURNSTILE_BYPASS_ACCOUNTS(env,见 config.ts / auth/turnstile.ts resolveTurnstileBypass)。
// 2026-07-26 前这里依赖的是全局 TURNSTILE_TEST_BYPASS=1,那等于全站人机验证失效,已废止:
// 生产开全局旁路会被 config.ts 的危险开关扫描在启动期直接拒绝。
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
//   exactText= isFinal 帧最终正文精确为“2”(引擎真执行了题目,不是任意占位正文);
//   sawFinal = 收到干净收尾帧 outbound.message{isFinal:true}(webchat 的 turn 终止契约,
//              bridge userChatBridge.ts:4582;不是靠"静默即判终"这种弱信号);
//   sawCost  = 收尾后广播 outbound.cost_charged(计费真到账;REQUIRE_COST=0 才放宽)。
// 错误帧(outbound.error / outbound.turn_error / error)= 立即失败。
const wsBase = BASE.replace(/^http/, 'ws')

const attempt = () => new Promise((resolve) => {
  const ws = new WebSocket(`${wsBase}/ws/user-chat-bridge`, ['bearer', token])
  let sawText = false
  let sawFinal = false
  let sawCost = false
  let sawError = null
  let answerText = ''
  let finalText = ''
  let silence
  let ledgerCostGrace
  let settled = false
  const exactText = () => finalText === '2'
  const criteriaMet = () => exactText() && sawFinal && (sawCost || !REQUIRE_COST)
  const finish = (reason) => {
    if (settled) return
    settled = true
    clearTimeout(silence)
    clearTimeout(ledgerCostGrace)
    try { ws.close() } catch {}
    resolve({ reason, sawText, sawFinal, sawCost, sawError, finalText })
  }
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
        if (b.kind === 'text' && b.text?.trim()) {
          sawText = true
          answerText += b.text
        }
      }
      if (f.isFinal === true) {
        sawFinal = true   // 干净收尾信号(cost_charged 在其后广播)
        // WebChat 正常路径会先逐块流正文,再发 blocks=[] 的 final 终止帧；
        // final-with-content 的早拒绝路径也存在。两者都按本次连接累积出的最终正文断言。
        finalText = answerText.trim()
        if (
          ALLOW_LEDGER_COST_EVIDENCE &&
          REQUIRE_COST &&
          exactText() &&
          !sawCost &&
          !sawError &&
          !ledgerCostGrace
        ) {
          ledgerCostGrace = setTimeout(
            () => finish('ledger-cost-evidence-required'),
            LEDGER_COST_GRACE_MS,
          )
        }
      }
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
  const result = await attempt()
  if (result.sawError) { console.error(`turn-canary: TURN_FAILED ${result.sawError}`); process.exit(1) }
  const criteriaMet = result.finalText === '2' && result.sawFinal && (result.sawCost || !REQUIRE_COST)
  if (criteriaMet) {
    console.log(`turn-canary: TURN_OK model=${MODEL} exact_text=2 final=${result.sawFinal} cost_charged=${result.sawCost}`)
    process.exit(0)
  }
  if (
    ALLOW_LEDGER_COST_EVIDENCE &&
    REQUIRE_COST &&
    result.reason === 'ledger-cost-evidence-required' &&
    result.finalText === '2' &&
    result.sawFinal &&
    !result.sawCost
  ) {
    console.log(`turn-canary: TURN_LEDGER_PROOF_REQUIRED session=${peerId} model=${MODEL}`)
    process.exit(3)
  }
  if (result.reason === 'closed' && !result.sawText && !result.sawFinal) {
    // bridge 在容器冷启动期间会直接关连接("container not ready",可能发生在
    // sys 帧之后):只要还没出任何正文/收尾信号,close 一律视为冷启动重连。真正的
    // turn 失败由错误帧显式暴露,turn 出了一半再断则落到下面的硬失败(不当冷启动重试)。
    console.log(`turn-canary: attempt ${i}/${ATTEMPTS} closed without text/final (container starting?), retrying`)
    await new Promise((s) => setTimeout(s, 6000))
    continue
  }
  // 出了部分信号但判据不齐 = 真故障,精确点名缺哪一条,不再重试掩盖。
  const missing = []
  if (!result.sawText) missing.push('text')
  else if (result.finalText !== '2') missing.push(`exact_text(期望“2”,实际${JSON.stringify(result.finalText).slice(0, 120)})`)
  if (!result.sawFinal) missing.push('final(isFinal 收尾帧)')
  if (REQUIRE_COST && !result.sawCost) missing.push('cost_charged(计费到账)')
  console.error(`turn-canary: TURN_INCOMPLETE after attempt ${i} (resolve=${result.reason}; 缺:${missing.join(', ') || '<none>'}; final=${result.sawFinal} cost=${result.sawCost})`)
  process.exit(1)
}
console.error('turn-canary: retries exhausted (container never became ready)')
process.exit(1)
