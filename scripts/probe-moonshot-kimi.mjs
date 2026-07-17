// Moonshot「Kimi For Coding」直连探针 —— kimi-k3(api.kimi.com/coding,Anthropic 兼容)。
//
// 定位:staticKeyProviders 的 MOONSHOT_CODING 接入(2026-07-17)只实测了**非流式
// happy-path**;两块空白靠本脚本人工补测(见 docs/V5_DEV_PLAYBOOK.md 债表 "moonshot
// 直连仅验非流式 happy-path"):
//   (a) streaming 下 tool_use 的 input_json_delta 是否**真增量**到达(全缓冲=WARN);
//   (b) 主动打到限流拿一个**真实 429**,dump 错误信封形态,与 CCB Anthropic 错误解析器
//       (claude-code-best/src/services/api/errors.ts + withRetry.ts)的 429 期望**只读比对**。
//
// ⚠ 本脚本**不进 CI、不在批 G 执行**:要花真钱(真实 token 消耗)+ 打生产 moonshot key,
//    还会主动触发限流。**部署后由人工在 kl-mirror 上跑一次**,通过后销 G3(b) 债。
//
// 用法(kl-mirror,node >= 20,直连出口):
//   node scripts/probe-moonshot-kimi.mjs                 # 两个探针都跑
//   node scripts/probe-moonshot-kimi.mjs --stream-only   # 只跑 streaming 增量
//   node scripts/probe-moonshot-kimi.mjs --rate-only     # 只跑 429 信封比对
// 环境变量:
//   MOONSHOT_KEY_FILE   (默认 /root/.secrets/moonshot-coding-plan.key —— 路径写这里,key 不硬编码)
//   MOONSHOT_ENDPOINT   (默认 https://api.kimi.com/coding/v1/messages)
//   MOONSHOT_MODEL      (默认 kimi-k3)
//   MOONSHOT_RL_BURST   (429 探针每轮并发数,默认 32)
//   MOONSHOT_RL_ROUNDS  (429 探针最多轮数,默认 6;命中 429 立即停)
// 退出码:0=跑完(含 WARN/未能诱发 429 的软失败);1=传输/上游硬错;2=配置错(缺 key)。
import { readFileSync } from 'node:fs'

const KEY_FILE = process.env.MOONSHOT_KEY_FILE ?? '/root/.secrets/moonshot-coding-plan.key'
const ENDPOINT = process.env.MOONSHOT_ENDPOINT ?? 'https://api.kimi.com/coding/v1/messages'
const MODEL = process.env.MOONSHOT_MODEL ?? 'kimi-k3'
const RL_BURST = Number(process.env.MOONSHOT_RL_BURST ?? 32)
const RL_ROUNDS = Number(process.env.MOONSHOT_RL_ROUNDS ?? 6)

const args = new Set(process.argv.slice(2))
const runStream = !args.has('--rate-only')
const runRate = !args.has('--stream-only')

let apiKey
try {
  apiKey = readFileSync(KEY_FILE, 'utf8').trim()
} catch (err) {
  console.error(`probe-moonshot: cannot read key file ${KEY_FILE}: ${err.message}`)
  process.exit(2)
}
if (!apiKey) {
  console.error('probe-moonshot: empty key file')
  process.exit(2)
}

function baseHeaders() {
  // x-api-key 鉴权(Anthropic 原生风格,MOONSHOT_CODING.authScheme='x-api-key')。
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }
}

// ─── 探针 A:streaming input_json_delta 增量 ───────────────────────────────
// 强制 tool_choice=get_weather → 必产一个 tool_use 块,其 input JSON 以
// input_json_delta(partial_json)流式下发。收集各 delta 到达时刻/字节,判断是否增量。
async function probeStreaming() {
  console.log('\n=== 探针 A:streaming tool_use input_json_delta 增量 ===')
  const body = {
    model: MODEL,
    max_tokens: 1024,
    stream: true,
    // kimi-k3 默认思考;关思考让 tool_choice 强制更稳(MOONSHOT_CODING 实测 disabled 生效)。
    thinking: { type: 'disabled' },
    tools: [
      {
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        input_schema: {
          type: 'object',
          properties: {
            city: { type: 'string', description: 'City name' },
            units: { type: 'string', enum: ['celsius', 'fahrenheit'] },
          },
          required: ['city', 'units'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'get_weather' },
    messages: [
      {
        role: 'user',
        content:
          'What is the current weather in Paris in celsius? Call get_weather with a fully populated argument object.',
      },
    ],
  }

  let res
  try {
    res = await fetch(ENDPOINT, { method: 'POST', headers: baseHeaders(), body: JSON.stringify(body) })
  } catch (err) {
    console.error(`  TRANSPORT_ERROR: ${err.message}`)
    return { ok: false }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error(`  HTTP ${res.status} (streaming request rejected): ${text.slice(0, 400)}`)
    return { ok: false }
  }
  if (!res.body) {
    console.error('  no response body stream')
    return { ok: false }
  }

  const decoder = new TextDecoder()
  let buf = ''
  const deltas = [] // { at, bytes }
  const t0 = performance.now()
  let sawToolUseStart = false
  let assembled = ''

  const handleEvent = (raw) => {
    // SSE 帧:多行 "event: X" / "data: {...}";只关心 data 里的 JSON。
    for (const line of raw.split('\n')) {
      const s = line.trimStart()
      if (!s.startsWith('data:')) continue
      const payload = s.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let evt
      try {
        evt = JSON.parse(payload)
      } catch {
        continue
      }
      if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
        sawToolUseStart = true
      }
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta') {
        const frag = evt.delta.partial_json ?? ''
        deltas.push({ at: performance.now() - t0, bytes: Buffer.byteLength(frag, 'utf8') })
        assembled += frag
      }
    }
  }

  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        handleEvent(buf.slice(0, idx))
        buf = buf.slice(idx + 2)
      }
    }
    if (buf.trim()) handleEvent(buf)
  } catch (err) {
    console.error(`  STREAM_READ_ERROR: ${err.message}`)
    return { ok: false }
  }

  console.log(`  tool_use block started : ${sawToolUseStart}`)
  console.log(`  input_json_delta count : ${deltas.length}`)
  console.log(`  assembled input        : ${assembled.slice(0, 200)}`)
  if (deltas.length >= 2) {
    const gaps = deltas.slice(1).map((d, i) => Math.round(d.at - deltas[i].at))
    const spanMs = Math.round(deltas[deltas.length - 1].at - deltas[0].at)
    const distinctArrivals = new Set(gaps.filter((g) => g > 0)).size
    console.log(`  inter-delta gaps (ms)  : [${gaps.join(', ')}]  span=${spanMs}ms`)
    if (distinctArrivals >= 1 && spanMs > 0) {
      console.log('  RESULT: PASS — input_json_delta 增量到达(多帧、有时间跨度)')
    } else {
      console.log('  RESULT: WARN — 多帧但零时间跨度(疑一次 flush 拆帧,非真增量)')
    }
  } else if (deltas.length === 1) {
    console.log('  RESULT: WARN — 仅 1 个 input_json_delta:无法区分"全缓冲"与"输入过短";')
    console.log('          建议加大工具入参 schema/prompt 复测,或对照 CCB 侧 tool_stream 期望')
  } else {
    console.log('  RESULT: WARN — 无 input_json_delta(上游可能不流式下发 tool 入参 = 全缓冲)')
  }
  return { ok: true }
}

// ─── 探针 B:真实 429 错误信封 vs CCB Anthropic 解析器期望 ──────────────────
// CCB 侧对 429 的处理(claude-code-best/src/services/api/errors.ts
// getAssistantMessageFromError + classifyAPIError + withRetry.ts)期望的字段:见下方 checklist。
async function probeRateLimit() {
  console.log('\n=== 探针 B:主动触发 429 → 错误信封与 CCB 解析器期望比对 ===')
  const minimalBody = JSON.stringify({
    model: MODEL,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  })
  const oneShot = async () => {
    try {
      const r = await fetch(ENDPOINT, { method: 'POST', headers: baseHeaders(), body: minimalBody })
      return r
    } catch {
      return null
    }
  }

  let hit = null
  outer: for (let round = 1; round <= RL_ROUNDS && !hit; round++) {
    const results = await Promise.all(Array.from({ length: RL_BURST }, oneShot))
    for (const r of results) {
      if (r && r.status === 429) {
        hit = r
        console.log(`  induced 429 at round ${round}/${RL_ROUNDS} (burst=${RL_BURST})`)
        break outer
      }
    }
    // 消费掉非命中响应体,避免连接悬挂
    await Promise.all(results.map((r) => (r ? r.text().catch(() => '') : Promise.resolve(''))))
    console.log(`  round ${round}: no 429 yet`)
  }

  if (!hit) {
    console.log('  RESULT: WARN — 未能在配额内诱发 429(可增大 MOONSHOT_RL_BURST/ROUNDS 重试)')
    console.log('          未拿到真实信封 → 无法比对,债 G3(b) 仅完成 streaming 半边')
    return { ok: true, got429: false }
  }

  const bodyText = await hit.text().catch(() => '')
  let bodyJson = null
  try {
    bodyJson = JSON.parse(bodyText)
  } catch {
    /* 非 JSON */
  }
  const h = (name) => hit.headers.get(name)

  console.log('\n  --- 实际 429 信封 dump ---')
  console.log(`  status        : ${hit.status}`)
  console.log(`  content-type  : ${h('content-type')}`)
  console.log(`  body          : ${bodyText.slice(0, 500)}`)
  const errObj = bodyJson && typeof bodyJson === 'object' ? bodyJson.error : undefined
  console.log(`  error.type    : ${errObj?.type ?? '(none)'}`)
  console.log(`  error.message : ${errObj?.message ?? '(none)'}`)

  // CCB 解析器期望(只读比对,不抛):
  const innerMessage =
    errObj && typeof errObj.message === 'string' && errObj.message.length > 0
  const unifiedHeaders = [
    'anthropic-ratelimit-unified-representative-claim',
    'anthropic-ratelimit-unified-overage-status',
    'anthropic-ratelimit-unified-reset',
    'anthropic-ratelimit-unified-overage-reset',
    'anthropic-ratelimit-unified-overage-disabled-reason',
  ]
  const anyUnified = unifiedHeaders.some((n) => h(n) != null)
  const retryAfter = h('retry-after') ?? h('retry-after-ms')
  const shouldRetry = h('x-should-retry')

  const mark = (b) => (b ? '✓' : '✗')
  console.log('\n  --- 与 CCB Anthropic 解析器期望比对(getAssistantMessageFromError/classifyAPIError/withRetry) ---')
  console.log(
    `  ${mark(hit.status === 429)} status===429 —— classifyAPIError→'rate_limit' / categorizeRetryableAPIError→'rate_limit'`,
  )
  console.log(
    `  ${mark(innerMessage)} body 有 error.message(Anthropic 信封 {type:'error',error:{type,message}})`,
  )
  console.log(
    `      → 有:解析器 /"message":"([^"]*)"/ 提取内层文案;无:回退整串 error.message`,
  )
  console.log(
    `  ${mark(anyUnified)} anthropic-ratelimit-unified-* 头 —— 有:走订阅式 ClaudeAILimits 文案;无(第三方预期):走通用 "Request rejected (429)"`,
  )
  for (const n of unifiedHeaders) {
    const v = h(n)
    if (v != null) console.log(`        · ${n} = ${v}`)
  }
  console.log(
    `  ${mark(retryAfter != null)} retry-after / retry-after-ms 头 —— withRetry getRetryAfter 退避依据;无则用指数默认${retryAfter != null ? ` (=${retryAfter})` : ''}`,
  )
  console.log(
    `  ${mark(shouldRetry != null)} x-should-retry 头(可选)—— withRetry 尊重 'false' 停止重试${shouldRetry != null ? ` (=${shouldRetry})` : ''}`,
  )

  const envelopeOk = hit.status === 429 && innerMessage
  console.log(
    `\n  RESULT: ${envelopeOk ? 'PASS' : 'WARN'} — ${
      envelopeOk
        ? '429 + Anthropic 信封 error.message 齐,CCB 能提取内层文案并归类 rate_limit'
        : '信封与解析器期望有出入(见上 ✗ 项),需评估 CCB 侧兜底是否够'
    }`,
  )
  console.log(
    '  备注:第三方通常无 anthropic-ratelimit-unified-* 头 → CCB 会落到通用 "Request rejected (429) · <detail>",这是预期而非缺陷。',
  )
  return { ok: true, got429: true }
}

let hardError = false
if (runStream) {
  const r = await probeStreaming()
  if (!r.ok) hardError = true
}
if (runRate) {
  const r = await probeRateLimit()
  if (!r.ok) hardError = true
}
console.log('\nprobe-moonshot: done.')
process.exit(hardError ? 1 : 0)
