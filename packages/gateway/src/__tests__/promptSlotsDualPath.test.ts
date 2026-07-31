/**
 * buildPromptContext — dual-path 注入契约(env-gated remote fetch vs provider hook)。
 *
 * 设计契约(改前先改测试):
 *   - env 全缺(personal 路径)→ setLiteratureSkillProvider / setModelHintProvider hook 被调
 *   - env 齐(v3 容器路径)→ hook **不**被调,master 返回的 slot 内容被注入
 *   - env 齐 + master MODEL_HINT slot 携带 canonicalModelId → applied[].meta.model_id == canonicalModelId
 *     (即使 ctx.model 入参是带恶意 alias 的长 raw 字串)
 *
 * 用真实 http.createServer 起本机 master,fetchPlatformSlotsFromMaster 走真实 undici 出站。
 * OPENCLAUDE_HOME 隔离 MemoryStore 防污染。
 *
 * 跑法:npx tsx --test src/__tests__/promptSlotsDualPath.test.ts
 */
import * as assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'

// 必须在 promptSlots import 之前设 OPENCLAUDE_HOME
const TEST_HOME = mkdtempSync(join(tmpdir(), 'dualpath-home-'))
process.env.OPENCLAUDE_HOME = TEST_HOME

const {
  buildPromptContext,
  setLiteratureSkillProvider,
  setModelHintProvider,
} = await import('../promptSlots.js')

const TOKEN = 'oc-v3.1.deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567'

let server: Server
let baseUrl = ''
/** 当前 test 期望服务端返的 JSON。每个 test 自己改。 */
let mockResponse: { status: number; body: string } = {
  status: 200,
  body: '{"slots":[]}',
}
/** master 收到的请求记录。用于断言 hook 未被绕过为 master 调用。 */
let captured: { url?: string; authorization?: string } = {}

before(async () => {
  server = createServer((req, res) => {
    captured.url = req.url
    captured.authorization = req.headers.authorization
    res.statusCode = mockResponse.status
    res.setHeader('content-type', 'application/json')
    res.end(mockResponse.body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  baseUrl = `http://127.0.0.1:${port}`
})

after(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

afterEach(() => {
  // 清理 hook + env + capture,防交叉污染
  setLiteratureSkillProvider(null)
  setModelHintProvider(null)
  delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL
  delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
  captured = {}
  mockResponse = { status: 200, body: '{"slots":[]}' }
})

describe('buildPromptContext — env-absent (personal hook path)', () => {
  it('CCB 与 Codex 都只注入一次通用交付契约', async () => {
    for (const provider of ['anthropic', 'codex-native']) {
      const result = await buildPromptContext({
        agentId: `execution-contract-${provider}`,
        provider,
        model: provider === 'codex-native' ? 'gpt-5.6-sol' : 'claude-sonnet-4-6',
      })
      assert.equal(
        result.content.match(/## 交付范围、工具效率与失败自愈/g)?.length,
        1,
        `${provider} 应只注入一次通用交付契约`,
      )
      assert.match(result.content, /实际缩短关键路径/)
      assert.match(result.content, /明确要求的完整任务仍须完整交付/)
    }
  })

  it('两个 hook 都被调,literature hook 返回的内容进 applied', async () => {
    // 不设 env -> personal 路径
    let litCalls = 0
    let hintCalls = 0
    setLiteratureSkillProvider(async () => {
      litCalls++
      return { name: 'SKILLS_LITERATURE', content: 'PERSONAL_LITERATURE' }
    })
    setModelHintProvider(() => {
      hintCalls++
      return { id: 'm1', text: 'PERSONAL_HINT' }
    })
    const result = await buildPromptContext({
      agentId: 'dualpath-personal',
      model: 'm1',
    })
    assert.equal(litCalls, 1, 'literature hook must be called when env absent')
    assert.equal(hintCalls, 1, 'model_hint hook must be called when env absent')
    assert.ok(
      result.applied.some((s) => s.name === 'SKILLS_LITERATURE'),
      'SKILLS_LITERATURE must appear in applied',
    )
    assert.match(result.content, /PERSONAL_LITERATURE/)
    assert.match(result.content, /PERSONAL_HINT/)
    // 网络层不能被触发 — env 缺时 fetchPlatformSlotsFromMaster 直接返 null
    assert.equal(captured.url, undefined, 'master must NOT be called when env absent')
  })
})

describe('buildPromptContext — env-present (v3 remote path)', () => {
  it('master 返 SKILLS_LITERATURE + MODEL_HINT → hook 不被调,远端内容进 applied', async () => {
    process.env.OPENCLAUDE_V3_MASTER_BASE_URL = baseUrl
    process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = TOKEN
    mockResponse = {
      status: 200,
      body: JSON.stringify({
        slots: [
          { name: 'SKILLS_LITERATURE', content: 'REMOTE_LITERATURE_BODY' },
          {
            name: 'MODEL_HINT',
            content: 'REMOTE_HINT_BODY',
            canonicalModelId: 'canonical-m1',
          },
        ],
      }),
    }
    let litHookCalls = 0
    let hintHookCalls = 0
    setLiteratureSkillProvider(async () => {
      litHookCalls++
      return { name: 'SKILLS_LITERATURE', content: 'SHOULD_NOT_APPEAR_LITERATURE' }
    })
    setModelHintProvider(() => {
      hintHookCalls++
      return { id: 'should-not-leak', text: 'SHOULD_NOT_APPEAR_HINT' }
    })

    const result = await buildPromptContext({
      agentId: 'dualpath-v3',
      model: 'raw-input-model-id',
    })

    assert.equal(litHookCalls, 0, 'literature hook MUST NOT be called when env present')
    assert.equal(hintHookCalls, 0, 'model_hint hook MUST NOT be called when env present')

    assert.ok(captured.url, 'master must be called')
    assert.ok(captured.url!.startsWith('/internal/v3/platform-prompt-slots'))
    assert.match(captured.url!, /model=raw-input-model-id/)
    assert.equal(captured.authorization, `Bearer ${TOKEN}`)

    // remote 内容进 content
    assert.match(result.content, /REMOTE_LITERATURE_BODY/)
    assert.match(result.content, /REMOTE_HINT_BODY/)
    // hook 内容**不**出现 — 验证 dual-path 互斥
    assert.doesNotMatch(result.content, /SHOULD_NOT_APPEAR_LITERATURE/)
    assert.doesNotMatch(result.content, /SHOULD_NOT_APPEAR_HINT/)

    // applied 包含两个 slot
    const names = result.applied.map((s) => s.name)
    assert.ok(names.includes('SKILLS_LITERATURE'))
    assert.ok(names.includes('MODEL_HINT'))
  })

  it('master MODEL_HINT canonicalModelId → applied.meta.model_id(防 raw 入参 cardinality)', async () => {
    process.env.OPENCLAUDE_V3_MASTER_BASE_URL = baseUrl
    process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = TOKEN
    mockResponse = {
      status: 200,
      body: JSON.stringify({
        slots: [
          {
            name: 'MODEL_HINT',
            content: 'hint body',
            canonicalModelId: 'canonical-short',
          },
        ],
      }),
    }
    const result = await buildPromptContext({
      agentId: 'dualpath-meta',
      // raw 入参带恶意尾巴 + 日期 alias,模拟 cardinality 攻击
      model: 'canonical-short-20260101-evil-AAAAAAAAAA',
    })
    const hint = result.applied.find((s) => s.name === 'MODEL_HINT')
    assert.ok(hint, 'MODEL_HINT must be emitted')
    assert.ok(hint!.meta, 'meta must be present for MODEL_HINT')
    assert.equal(
      hint!.meta!.model_id,
      'canonical-short',
      'meta.model_id MUST come from master canonicalModelId, NOT raw input model',
    )
  })

  it('master 返非 200 → 两个 slot 都缺席,但不回退到 hook', async () => {
    process.env.OPENCLAUDE_V3_MASTER_BASE_URL = baseUrl
    process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = TOKEN
    mockResponse = { status: 500, body: 'oops' }
    let litHookCalls = 0
    setLiteratureSkillProvider(async () => {
      litHookCalls++
      return { name: 'SKILLS_LITERATURE', content: 'HOOK_FALLBACK' }
    })
    const result = await buildPromptContext({
      agentId: 'dualpath-fail-soft',
      model: 'm1',
    })
    assert.equal(litHookCalls, 0, 'hook MUST NOT be invoked as fallback')
    assert.equal(
      result.applied.some((s) => s.name === 'SKILLS_LITERATURE'),
      false,
      'SKILLS_LITERATURE must be absent when master errors out',
    )
    assert.equal(
      result.applied.some((s) => s.name === 'MODEL_HINT'),
      false,
      'MODEL_HINT must be absent when master errors out',
    )
    assert.doesNotMatch(result.content, /HOOK_FALLBACK/)
  })

  it('master 返空 slots[] → 两个 slot 都缺席(env 主导 dead hook)', async () => {
    process.env.OPENCLAUDE_V3_MASTER_BASE_URL = baseUrl
    process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = TOKEN
    mockResponse = { status: 200, body: '{"slots":[]}' }
    setLiteratureSkillProvider(async () => ({
      name: 'SKILLS_LITERATURE',
      content: 'HOOK_LIT',
    }))
    const result = await buildPromptContext({
      agentId: 'dualpath-empty',
      model: 'm1',
    })
    assert.equal(
      result.applied.some((s) => s.name === 'SKILLS_LITERATURE'),
      false,
    )
    assert.doesNotMatch(result.content, /HOOK_LIT/)
  })
})
