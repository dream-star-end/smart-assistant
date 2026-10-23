/**
 * Intelligent UI(OCV5-361)gateway 侧契约:
 *   - INTELLIGENT_UI 在 master slot 白名单内;
 *   - 只对 webchat 会话注入,位置在 TOOLS 之后、MODEL_HINT 之前;master 不下发(开关关)→ 不存在;
 *   - 「该注入什么」的期望值:INTELLIGENT_UI 段原文的指纹(没有 = false);非 webchat 恒 false、
 *     拉取失败 undefined、5 秒缓存;
 *   - 重启判定:只有 runner 记录了指纹(或 false)且与期望不一致才重启。段还在、内容变了(只切换
 *     输入预测 OCV5-375)也算不一致。
 *
 * 跑法:npx tsx --test src/__tests__/intelligentUi.test.ts
 */
import * as assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'iui-home-'))
process.env.OPENCLAUDE_HOME = TEST_HOME

const {
  buildPromptContext,
  fetchPlatformSlotsFromMaster,
  fetchPlatformSlotsFromMasterDetailed,
  isWebchatSessionKey,
  isWebRenderedIuiSessionKey,
  INTELLIGENT_UI_SLOT,
  intelligentUiFingerprint,
} = await import('../promptSlots.js')
const { getDesiredIntelligentUi, intelligentUiNeedsRestart, __resetIntelligentUiDesiredCacheForTests } = await import(
  '../intelligentUiDesired.js'
)

const TOKEN = 'oc-v3.1.deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567'
const WEB = 'agent:main:webchat:dm:abc123'

let server: Server
let baseUrl = ''
let mock: { status: number; body: string } = { status: 200, body: '{"slots":[]}' }
let hits = 0
let requestedUrls: string[] = []
let surfaceBodies: { webchat: string; taskboard: string } | null = null

before(async () => {
  server = createServer((req, res) => {
    requestedUrls.push(req.url ?? '/')
    hits += 1
    res.statusCode = mock.status
    res.setHeader('content-type', 'application/json')
    const content = surfaceBodies ? (new URL(req.url ?? '/', 'http://fixture').searchParams.get('surface') === 'taskboard' ? surfaceBodies.taskboard : surfaceBodies.webchat) : null
    res.end(content === null ? mock.body : JSON.stringify({ slots: [{ name: INTELLIGENT_UI_SLOT, content }] }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})
beforeEach(() => {
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = baseUrl
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = TOKEN
  __resetIntelligentUiDesiredCacheForTests()
  hits = 0
  requestedUrls = []
  surfaceBodies = null
})
afterEach(() => {
  delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL
  delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
  mock = { status: 200, body: '{"slots":[]}' }
})

const IUI_BODY = '# 交互式回答(Intelligent UI)\nIUI_PROTOCOL_MARKER'
const withIui = (extra: object[] = []) =>
  JSON.stringify({ slots: [...extra, { name: 'INTELLIGENT_UI', content: IUI_BODY }] })

describe('isWebchatSessionKey', () => {
  it('only agent:<aid>:webchat:* counts', () => {
    assert.equal(isWebchatSessionKey(WEB), true)
    assert.equal(isWebchatSessionKey('agent:main:wechat:dm:x'), false)
    assert.equal(isWebchatSessionKey('agent:main:cron:dm:job1'), false)
    assert.equal(isWebchatSessionKey('agent:main:delegate:main:1:n'), false)
    assert.equal(isWebchatSessionKey('agent:main:openai:dm:1'), false)
    assert.equal(isWebchatSessionKey('webchat:dm:x'), false)
    assert.equal(isWebchatSessionKey(undefined), false)
  })
})

describe('master slot fetch accepts INTELLIGENT_UI', () => {
  it('whitelisted and trimmed', async () => {
    mock = { status: 200, body: withIui() }
    const r = await fetchPlatformSlotsFromMaster({ agentId: 'main' })
    assert.deepEqual(r, [{ name: INTELLIGENT_UI_SLOT, content: IUI_BODY }])
  })

  it('detailed fetch distinguishes empty from failure', async () => {
    mock = { status: 200, body: '{"slots":[]}' }
    assert.deepEqual(await fetchPlatformSlotsFromMasterDetailed({ agentId: 'main' }), { ok: true, slots: [] })
    mock = { status: 500, body: 'boom' }
    assert.deepEqual(await fetchPlatformSlotsFromMasterDetailed({ agentId: 'main' }), { ok: false, slots: [] })
    mock = { status: 200, body: 'not json' }
    assert.deepEqual(await fetchPlatformSlotsFromMasterDetailed({ agentId: 'main' }), { ok: false, slots: [] })
  })
})

describe('buildPromptContext places INTELLIGENT_UI for webchat only', () => {
  it('webchat + master sends it → present after SOUL, before AGENTS (on-demand preview index) and before MODEL_HINT', async () => {
    mock = { status: 200, body: withIui([{ name: 'MODEL_HINT', content: 'HINT_BODY', canonicalModelId: 'm1' }]) }
    const r = await buildPromptContext({ agentId: 'iui-web', sessionKey: WEB, model: 'm1' })
    const names = r.applied.map((a) => a.name)
    assert.ok(names.includes(INTELLIGENT_UI_SLOT), `applied: ${names.join(',')}`)
    assert.ok(names.indexOf('SOUL') < names.indexOf(INTELLIGENT_UI_SLOT), `applied: ${names.join(',')}`)
    assert.ok(names.indexOf(INTELLIGENT_UI_SLOT) < names.indexOf('AGENTS'), `applied: ${names.join(',')}`)
    assert.ok(names.indexOf(INTELLIGENT_UI_SLOT) < names.indexOf('MODEL_HINT'))
    // 正文里协议也在 htmlpreview 段之前(CLI 截断外置时模型常只读开头)
    assert.ok(r.content.indexOf('IUI_PROTOCOL_MARKER') < r.content.indexOf('oc-system skill ui-preview'))
    assert.match(r.content, /IUI_PROTOCOL_MARKER/)
    assert.equal(r.intelligentUi, intelligentUiFingerprint(IUI_BODY), 'fingerprint of the master text')
  })

  it('non-webchat sessions never get it even if master sends it', async () => {
    mock = { status: 200, body: withIui() }
    for (const sessionKey of ['agent:main:wechat:dm:x', 'agent:main:cron:dm:j', undefined]) {
      const r = await buildPromptContext({ agentId: 'iui-chan', sessionKey })
      assert.ok(!r.applied.some((a) => a.name === INTELLIGENT_UI_SLOT), String(sessionKey))
      assert.doesNotMatch(r.content, /IUI_PROTOCOL_MARKER/)
    }
  })

  it('switch off (master does not send it) → zero bytes of protocol', async () => {
    mock = { status: 200, body: '{"slots":[]}' }
    const r = await buildPromptContext({ agentId: 'iui-off', sessionKey: WEB })
    assert.ok(!r.applied.some((a) => a.name === INTELLIGENT_UI_SLOT))
    assert.doesNotMatch(r.content, /Intelligent UI/)
    assert.equal(r.intelligentUi, false)
  })
})

describe('getDesiredIntelligentUi', () => {
  it('non-webchat → false without calling master', async () => {
    assert.equal(await getDesiredIntelligentUi('agent:main:wechat:dm:x'), false)
    assert.equal(hits, 0)
  })

  it('webchat → reflects master and caches for 5s', async () => {
    let t = 1_000
    const now = () => t
    mock = { status: 200, body: withIui() }
    assert.equal(await getDesiredIntelligentUi(WEB, { now }), intelligentUiFingerprint(IUI_BODY))
    mock = { status: 200, body: '{"slots":[]}' }
    t += 4_000
    assert.equal(await getDesiredIntelligentUi(WEB, { now }), intelligentUiFingerprint(IUI_BODY), 'cached')
    assert.equal(hits, 1)
    t += 2_000
    assert.equal(await getDesiredIntelligentUi(WEB, { now }), false, 'refreshed after TTL')
    assert.equal(hits, 2)
  })

  it('fetch failure → undefined (never treated as off)', async () => {
    mock = { status: 503, body: '' }
    assert.equal(await getDesiredIntelligentUi(WEB), undefined)
  })

  it('personal path without master env → undefined', async () => {
    delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL
    assert.equal(await getDesiredIntelligentUi(WEB), undefined)
  })
})

describe('intelligentUiNeedsRestart', () => {
  const ON = intelligentUiFingerprint(IUI_BODY) as string
  // 组件协议还开着、只关了输入预测(OCV5-375):这一段还在,内容少了预测那部分。
  const ON_WITHOUT_PREDICTION = intelligentUiFingerprint(`${IUI_BODY}\n\n# 输入预测`) as string
  it('restarts only on a known mismatch', () => {
    assert.equal(intelligentUiNeedsRestart(ON, false), true)
    assert.equal(intelligentUiNeedsRestart(false, ON), true)
    assert.equal(intelligentUiNeedsRestart(ON, ON), false)
    assert.equal(intelligentUiNeedsRestart(false, false), false)
    assert.equal(intelligentUiNeedsRestart(undefined, ON), false, 'per-turn engines do not record')
    assert.equal(intelligentUiNeedsRestart(ON, undefined), false, 'fetch failure')
  })
  it('same slot, different content (one of its switches flipped) → restart', () => {
    assert.equal(intelligentUiNeedsRestart(ON_WITHOUT_PREDICTION, ON), true)
    assert.equal(intelligentUiNeedsRestart(ON, ON_WITHOUT_PREDICTION), true)
  })
  it('fingerprint is stable and false only when absent', () => {
    assert.equal(intelligentUiFingerprint(IUI_BODY), ON)
    assert.equal(intelligentUiFingerprint(undefined), false)
    assert.match(ON, /^[0-9a-f]{64}$/)
  })
})


const TASK = 'agent:main:taskboard:ticket:stage:run'
describe('taskboard IUI surface', () => {
  it('allows only canonical taskboard roots without changing webchat routing classification', () => {
    assert.equal(isWebRenderedIuiSessionKey(TASK), true)
    assert.equal(isWebchatSessionKey(TASK), false)
    assert.equal(isWebRenderedIuiSessionKey(WEB), true)
    for (const key of ['agent:main:delegate:main:1:n', 'agent:main:wechat:dm:x', 'agent:main:cron:dm:x', 'agent:main:taskboard:missing', undefined]) assert.equal(isWebRenderedIuiSessionKey(key), false)
  })
  it('injects the existing component slot and sends surface only for taskboard', async () => {
    mock = { status: 200, body: withIui() }
    const task = await buildPromptContext({ agentId: 'iui-task', sessionKey: TASK })
    assert.equal(task.intelligentUi, intelligentUiFingerprint(IUI_BODY))
    assert.ok(task.applied.some((slot) => slot.name === INTELLIGENT_UI_SLOT))
    assert.equal(new URL(requestedUrls[0]!, 'http://fixture').searchParams.get('surface'), 'taskboard')
    await fetchPlatformSlotsFromMasterDetailed({ agentId: 'main', sessionKey: WEB })
    assert.equal(new URL(requestedUrls.at(-1)!, 'http://fixture').searchParams.has('surface'), false)
  })
  it('caches webchat and taskboard fingerprints independently in either order', async () => {
    for (const order of [[WEB, TASK], [TASK, WEB]]) {
      __resetIntelligentUiDesiredCacheForTests()
      hits = 0
      surfaceBodies = { taskboard: 'COMPONENTS_ONLY', webchat: 'COMPONENTS_AND_PREDICTION' }
      for (const key of [...order, ...order]) {
        const value = await getDesiredIntelligentUi(key, { now: () => 1000 })
        assert.equal(value, intelligentUiFingerprint(key === TASK ? 'COMPONENTS_ONLY' : 'COMPONENTS_AND_PREDICTION'))
      }
      assert.equal(hits, 2)
    }
  })
})
