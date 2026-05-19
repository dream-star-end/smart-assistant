/**
 * SKILLS_LITERATURE slot — buildLiteratureSkillSlot + setLiteratureSkillProvider 行为契约。
 *
 * 设计契约(改前先改测试):
 *   - 无 provider 注入 → 永远 null(personal 默认状态)
 *   - provider 返 null → null(commercial admin disabled / token 未配)
 *   - provider 返非对象 / 缺 name / 缺 content → null(防御外部脏数据)
 *   - provider 返 content 为空白 → null(trim 后空)
 *   - provider 抛错 → null + warn(不能拖死 prompt 构建,与 modelHint 同型契约)
 *   - provider 返合法 PromptSlot → 透传 name + trimmed content
 *
 *   - buildPromptContext 顺序:SKILLS_LITERATURE 必须出现在 SKILLS 之后、MEMORY 之前
 *   - 无 provider 时 buildPromptContext 不出现 SKILLS_LITERATURE,纯净 fallback
 *
 * 测试隔离:每个 test 后 setLiteratureSkillProvider(null) 防交叉污染(模块级状态)。
 */
import * as assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

// 在 ../promptSlots.js 之前设置 OPENCLAUDE_HOME,storage paths.ts 启动时读这个 env,
// 之后调 MemoryStore 才会落到 tmp 路径而不是真实 HOME。这样下面"造 MEMORY slot"
// 的测试能可控地 emit MEMORY,锁住 SKILLS_LITERATURE < MEMORY 的顺序契约。
const TEST_HOME = mkdtempSync(join(tmpdir(), 'literature-slot-home-'))
process.env.OPENCLAUDE_HOME = TEST_HOME

const {
  buildLiteratureSkillSlot,
  buildPromptContext,
  setLiteratureSkillProvider,
} = await import('../promptSlots.js')

afterEach(() => {
  setLiteratureSkillProvider(null)
})

describe('buildLiteratureSkillSlot', () => {
  it('returns null when no provider is registered', async () => {
    setLiteratureSkillProvider(null)
    const slot = await buildLiteratureSkillSlot()
    assert.equal(slot, null)
  })

  it('returns null when provider returns null (disabled / token unset)', async () => {
    setLiteratureSkillProvider(async () => null)
    const slot = await buildLiteratureSkillSlot()
    assert.equal(slot, null)
  })

  it('returns null when provider returns a non-object (defensive)', async () => {
    // @ts-expect-error — 故意构造脏数据
    setLiteratureSkillProvider(async () => 'just a string')
    const slot = await buildLiteratureSkillSlot()
    assert.equal(slot, null)
  })

  it('returns null when provider returns object missing name', async () => {
    // @ts-expect-error — 故意构造脏数据
    setLiteratureSkillProvider(async () => ({ content: 'no name' }))
    const slot = await buildLiteratureSkillSlot()
    assert.equal(slot, null)
  })

  it('returns null when provider returns object with empty name', async () => {
    setLiteratureSkillProvider(async () => ({ name: '', content: 'body' }))
    const slot = await buildLiteratureSkillSlot()
    assert.equal(slot, null)
  })

  it('returns null when provider returns object missing content', async () => {
    // @ts-expect-error — 故意构造脏数据
    setLiteratureSkillProvider(async () => ({ name: 'SKILLS_LITERATURE' }))
    const slot = await buildLiteratureSkillSlot()
    assert.equal(slot, null)
  })

  it('returns null when provider returns whitespace-only content', async () => {
    setLiteratureSkillProvider(async () => ({ name: 'SKILLS_LITERATURE', content: '   \n\t  ' }))
    const slot = await buildLiteratureSkillSlot()
    assert.equal(slot, null)
  })

  it('returns null when provider throws (does NOT crash prompt build)', async () => {
    setLiteratureSkillProvider(async () => {
      throw new Error('db down')
    })
    const slot = await buildLiteratureSkillSlot()
    assert.equal(slot, null)
  })

  it('returns slot with provider-supplied name + trimmed content when valid', async () => {
    const raw = '\n\n  # SKILLS_LITERATURE body  \n'
    setLiteratureSkillProvider(async () => ({ name: 'SKILLS_LITERATURE', content: raw }))
    const slot = await buildLiteratureSkillSlot()
    assert.ok(slot)
    assert.equal(slot!.name, 'SKILLS_LITERATURE')
    assert.equal(slot!.content, '# SKILLS_LITERATURE body')
  })
})

describe('buildPromptContext literature slot ordering', () => {
  it('no SKILLS_LITERATURE in applied when provider not registered (personal default)', async () => {
    setLiteratureSkillProvider(null)
    const result = await buildPromptContext({ agentId: 'nonexistent-agent-for-test' })
    const names = result.applied.map((s) => s.name)
    assert.equal(names.includes('SKILLS_LITERATURE'), false)
  })

  it('SKILLS_LITERATURE出现在 TOOLS 之前(MEMORY 之前层),且在 SKILLS 之后(若 SKILLS 存在)', async () => {
    // 契约:SKILLS → SKILLS_LITERATURE → (MEMORY) → TOOLS → MODEL_HINT → RESEARCH → REPO
    setLiteratureSkillProvider(async () => ({
      name: 'SKILLS_LITERATURE',
      content: '# 平台技能: 文献检索',
    }))
    const result = await buildPromptContext({ agentId: 'nonexistent-agent-for-test' })
    const names = result.applied.map((s) => s.name)
    const litIdx = names.indexOf('SKILLS_LITERATURE')
    const toolsIdx = names.indexOf('TOOLS')
    assert.notEqual(litIdx, -1, 'SKILLS_LITERATURE must be emitted when provider returns slot')
    assert.notEqual(toolsIdx, -1, 'TOOLS slot must always be emitted')
    assert.ok(
      litIdx < toolsIdx,
      `SKILLS_LITERATURE (${litIdx}) must come before TOOLS (${toolsIdx})`,
    )
    // SKILLS 可能 null(nonexistent agent 没 skills),只有存在时才校验顺序
    const skillsIdx = names.indexOf('SKILLS')
    if (skillsIdx !== -1) {
      assert.ok(
        skillsIdx < litIdx,
        `SKILLS_LITERATURE (${litIdx}) must come after SKILLS (${skillsIdx})`,
      )
    }
  })

  it('SKILLS_LITERATURE 出现在 MEMORY 之前(造 MEMORY slot 真实锁住顺序)', async () => {
    // NIT 强化:之前测试只锁了 SKILLS_LITERATURE < TOOLS,没法验证 MEMORY 位置。
    // 在 OPENCLAUDE_HOME 下手写 MEMORY.md fixture,触发 buildMemorySlot 真 emit。
    const agentId = 'literature-slot-mem-test'
    const agentDir = join(TEST_HOME, 'agents', agentId)
    mkdirSync(join(agentDir, 'memory'), { recursive: true })
    writeFileSync(
      join(agentDir, 'MEMORY.md'),
      '- [test-mem-entry](dummy.md) — fixture for slot ordering test\n',
      'utf-8',
    )

    setLiteratureSkillProvider(async () => ({
      name: 'SKILLS_LITERATURE',
      content: '# 平台技能: 文献检索',
    }))
    const result = await buildPromptContext({ agentId })
    const names = result.applied.map((s) => s.name)
    const litIdx = names.indexOf('SKILLS_LITERATURE')
    const memIdx = names.indexOf('MEMORY')
    assert.notEqual(litIdx, -1, 'SKILLS_LITERATURE must be emitted')
    assert.notEqual(memIdx, -1, 'MEMORY must be emitted given the fixture')
    assert.ok(
      litIdx < memIdx,
      `SKILLS_LITERATURE (${litIdx}) must come before MEMORY (${memIdx})`,
    )
  })

  it('content 实际包含 provider 返回的文本', async () => {
    setLiteratureSkillProvider(async () => ({
      name: 'SKILLS_LITERATURE',
      content: '# 平台技能: 文献检索\nPOST /v3/literature/search',
    }))
    const result = await buildPromptContext({ agentId: 'nonexistent-agent-for-test' })
    assert.match(result.content, /平台技能: 文献检索/)
    assert.match(result.content, /POST \/v3\/literature\/search/)
  })
})
