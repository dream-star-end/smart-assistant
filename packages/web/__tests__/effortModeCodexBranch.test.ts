import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

/**
 * v1.0.200 — gpt-5.5 (codex provider) 接入思考深度选择器。
 *
 * effortMode.js 内部把 model → options / default / 是否暴露选择器 三件事拆给
 * `isOpus47Model` / `isDeepseekModel` / `isCodexModel` 三个 predicate 跟对应
 * options 常量。functional 测试需要 mock dom.js + state.js + localStorage(
 * 三层间接依赖),静态文本断言能直接锁住 codex 分支的接入点,任何回退或漂移
 * 都会立刻挂掉一条 CI:
 *   - isCodexModel predicate 存在且锚定 ^gpt-5.5$
 *   - CODEX_OPTIONS 四档(low/medium/high/xhigh),不暴露 max
 *   - getDefaultEffortForModel codex 分支默认 medium(对齐 codex CLI 自身默认)
 *   - getEffortOptionsForModel / modelSupportsExtraEffort 在 codex 分支都接入
 *
 * 后端协议契约(`InboundMessage.effortLevel` low/medium/high/xhigh/max 五档)
 * 不在这里测 — 它由 codexReasoningEffortConfig 的 unit test 锁。
 */

const EFFORT = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'effortMode.js'),
  'utf-8',
)

describe('effortMode.js — gpt-5.5 (codex) branch', () => {
  it('isCodexModel predicate 存在,exact-match `^gpt-5\\.5$`', () => {
    // 与 server.ts ALLOWED_INBOUND_MODELS 一致;不允许放过未来未声明的 gpt-5.5-*
    // alias 默默走 codex 分支(不同 alias 可能有不同默认 effort)。
    assert.match(
      EFFORT,
      /function\s+isCodexModel\s*\(\s*modelId\s*\)\s*\{[\s\S]{0,200}\/\^gpt-5\\\.5\$\/i\.test/,
      'isCodexModel 必须用 `/^gpt-5\\.5$/i.test(modelId || "")` 形式 exact-match',
    )
  })

  it('CODEX_OPTIONS 含 low/medium/high/xhigh 四档,不含 max', () => {
    // codex CLI 实测合法值 none/minimal/low/medium/high/xhigh — 我们前端不暴露
    // none/minimal/max,避免"伪选项"(none/minimal 用户角度等同 low,max 在
    // 后端 codexReasoningEffortConfig 显式映射 xhigh)。
    const m = EFFORT.match(/const\s+CODEX_OPTIONS\s*=\s*\[([\s\S]*?)\]/)
    assert.ok(m, '缺 CODEX_OPTIONS 数组')
    const body = m![1]
    for (const v of ['low', 'medium', 'high', 'xhigh']) {
      assert.match(body, new RegExp(`value:\\s*['"]${v}['"]`), `CODEX_OPTIONS 缺档位 ${v}`)
    }
    assert.ok(
      !/value:\s*['"]max['"]/.test(body),
      'CODEX_OPTIONS 不应暴露 max(后端 codexReasoningEffortConfig 会映射 xhigh)',
    )
  })

  it('getDefaultEffortForModel codex 分支返回 medium(对齐 codex CLI 自身默认)', () => {
    // 必须显式判 isCodexModel 后返回 'medium' 才能区别于 Opus 4.7 的兜底 'medium'
    // (虽然值相同,但语义上 codex 与 Opus 独立 — 任一改默认时另一不应被殃及)。
    const fnMatch = EFFORT.match(/function\s+getDefaultEffortForModel[\s\S]{0,400}\n\}/)
    assert.ok(fnMatch, '缺 getDefaultEffortForModel 函数')
    assert.match(
      fnMatch![0],
      /if\s*\(\s*isCodexModel\s*\(\s*modelId\s*\)\s*\)\s*return\s+['"]medium['"]/,
      'getDefaultEffortForModel 必须有 codex → medium 分支',
    )
  })

  it('getEffortOptionsForModel codex 分支返回 CODEX_OPTIONS', () => {
    const fnMatch = EFFORT.match(/function\s+getEffortOptionsForModel[\s\S]{0,400}\n\}/)
    assert.ok(fnMatch, '缺 getEffortOptionsForModel 函数')
    assert.match(
      fnMatch![0],
      /if\s*\(\s*isCodexModel\s*\(\s*modelId\s*\)\s*\)\s*return\s+CODEX_OPTIONS/,
      'getEffortOptionsForModel 必须有 codex → CODEX_OPTIONS 分支',
    )
  })

  it('modelSupportsExtraEffort 接入 isCodexModel', () => {
    // 这是"是否展示选择器"的总闸,漏接 isCodexModel 会导致 gpt-5.5 session
    // 看不到 effort trigger,选择器存在但失效。
    const fnMatch = EFFORT.match(/export\s+function\s+modelSupportsExtraEffort[\s\S]{0,400}\n\}/)
    assert.ok(fnMatch, '缺 modelSupportsExtraEffort 函数')
    assert.match(
      fnMatch![0],
      /isCodexModel\s*\(\s*modelId\s*\)/,
      'modelSupportsExtraEffort 必须 OR 上 isCodexModel(modelId)',
    )
  })
})

describe('effortMode.js — 火山 glm-5.1/glm-5.2 branch', () => {
  it('isGlmModel predicate 存在,exact-match `^glm-5\\.[12]$`', () => {
    // 与 protocol staticKeyProviders ark matchesRoute 一致;不放过未声明 glm 变体。
    assert.match(
      EFFORT,
      /function\s+isGlmModel\s*\(\s*modelId\s*\)\s*\{[\s\S]{0,260}\/\^glm-5\\\.\[12\]\$\/i\.test/,
      'isGlmModel 必须用 `/^glm-5\\.[12]$/i.test(modelId || "")` 形式 exact-match',
    )
  })

  it('GLM_OPTIONS 含 high/max 两档,不含 low/medium/xhigh', () => {
    const m = EFFORT.match(/const\s+GLM_OPTIONS\s*=\s*\[([\s\S]*?)\]/)
    assert.ok(m, '缺 GLM_OPTIONS 数组')
    const body = m![1]
    for (const v of ['high', 'max']) {
      assert.match(body, new RegExp(`value:\\s*['"]${v}['"]`), `GLM_OPTIONS 缺档位 ${v}`)
    }
    for (const v of ['low', 'medium', 'xhigh']) {
      assert.ok(
        !new RegExp(`value:\\s*['"]${v}['"]`).test(body),
        `GLM_OPTIONS 不应暴露 ${v}(火山 glm 产品只开放高/最高两档)`,
      )
    }
  })

  it('getDefaultEffortForModel glm 分支显式返回 max', () => {
    const fnMatch = EFFORT.match(/function\s+getDefaultEffortForModel[\s\S]{0,600}\n\}/)
    assert.ok(fnMatch, '缺 getDefaultEffortForModel 函数')
    assert.match(
      fnMatch![0],
      /if\s*\(\s*isGlmModel\s*\(\s*modelId\s*\)\s*\)\s*return\s+['"]max['"]/,
      'getDefaultEffortForModel 必须有 glm → max 分支',
    )
  })

  it('getEffortOptionsForModel glm 分支返回 GLM_OPTIONS', () => {
    const fnMatch = EFFORT.match(/function\s+getEffortOptionsForModel[\s\S]{0,400}\n\}/)
    assert.ok(fnMatch, '缺 getEffortOptionsForModel 函数')
    assert.match(
      fnMatch![0],
      /if\s*\(\s*isGlmModel\s*\(\s*modelId\s*\)\s*\)\s*return\s+GLM_OPTIONS/,
      'getEffortOptionsForModel 必须有 glm → GLM_OPTIONS 分支',
    )
  })

  it('modelSupportsExtraEffort 接入 isGlmModel', () => {
    const fnMatch = EFFORT.match(/export\s+function\s+modelSupportsExtraEffort[\s\S]{0,400}\n\}/)
    assert.ok(fnMatch, '缺 modelSupportsExtraEffort 函数')
    assert.match(
      fnMatch![0],
      /isGlmModel\s*\(\s*modelId\s*\)/,
      'modelSupportsExtraEffort 必须 OR 上 isGlmModel(modelId)',
    )
  })

  it('_optionsKey 纳入 value+label+hint(GLM/DeepSeek values 撞车,防 stale 菜单 DOM)', () => {
    const fnMatch = EFFORT.match(/function\s+_optionsKey[\s\S]{0,300}\n\}/)
    assert.ok(fnMatch, '缺 _optionsKey 函数')
    assert.match(
      fnMatch![0],
      /o\.value[\s\S]{0,40}o\.label[\s\S]{0,40}o\.hint/,
      '_optionsKey 必须纳入 value+label+hint(GLM/DeepSeek 同 values 切换否则不重建菜单)',
    )
  })
})
