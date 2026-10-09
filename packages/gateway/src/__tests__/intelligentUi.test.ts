/**
 * Intelligent UI(OCV5-361)gateway 侧契约:
 *   - INTELLIGENT_UI 在 master slot 白名单内;
 *   - 只对 webchat 会话注入,位置在 TOOLS 之后、MODEL_HINT 之前;master 不下发(开关关)→ 不存在;
 *   - 「是否该注入」的期望值:非 webchat 恒 false、拉取失败 undefined、5 秒缓存;
 *   - 重启判定:只有 runner 记录了 boolean 且与期望(boolean)不一致才重启。
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

const { buildPromptContext, fetchPlatformSlotsFromMaster, fetchPlatformSlotsFromMasterDetailed, isWebchatSessionKey, INTELLIGENT_UI_SLOT } =
  await import('../promptSlots.js')
const { getDesiredIntelligentUi, intelligentUiNeedsRestart, __resetIntelligentUiDesiredCacheForTests } = await import(
  '../intelligentUiDesired.js'
)

const TOKEN = 'oc-v3.1.deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567'
const WEB = 'agent:main:webchat:dm:abc123'

let server: Server
let baseUrl = ''
let mock: { status: number; body: string } = { status: 200, body: '{"slots":[]}' }
let hits = 0

before(async () => {
  server = createServer((_req, res) => {
    hits += 1
    res.statusCode = mock.status
    res.setHeader('content-type', 'application/json')
    res.end(mock.body)
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
  it('webchat + master sends it → present after TOOLS and before MODEL_HINT', async () => {
    mock = { status: 200, body: withIui([{ name: 'MODEL_HINT', content: 'HINT_BODY', canonicalModelId: 'm1' }]) }
    const r = await buildPromptContext({ agentId: 'iui-web', sessionKey: WEB, model: 'm1' })
    const names = r.applied.map((a) => a.name)
    assert.ok(names.includes(INTELLIGENT_UI_SLOT), `applied: ${names.join(',')}`)
    assert.ok(names.indexOf('TOOLS') < names.indexOf(INTELLIGENT_UI_SLOT))
    assert.ok(names.indexOf(INTELLIGENT_UI_SLOT) < names.indexOf('MODEL_HINT'))
    assert.match(r.content, /IUI_PROTOCOL_MARKER/)
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
    assert.equal(await getDesiredIntelligentUi(WEB, { now }), true)
    mock = { status: 200, body: '{"slots":[]}' }
    t += 4_000
    assert.equal(await getDesiredIntelligentUi(WEB, { now }), true, 'cached')
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
  it('restarts only on a known mismatch', () => {
    assert.equal(intelligentUiNeedsRestart(true, false), true)
    assert.equal(intelligentUiNeedsRestart(false, true), true)
    assert.equal(intelligentUiNeedsRestart(true, true), false)
    assert.equal(intelligentUiNeedsRestart(false, false), false)
    assert.equal(intelligentUiNeedsRestart(undefined, true), false, 'per-turn engines do not record')
    assert.equal(intelligentUiNeedsRestart(true, undefined), false, 'fetch failure')
  })
})
