/**
 * 契约锚 — gateway 侧一切 turn 级错误码必须 ∈ protocol turnErrorTaxonomy(唯一
 * 权威语义表)。三处 key 集合靠本测试同源,不靠 import 同一份文案:
 *   1. classifyRunError 的产出码(provider 原文粗分类);
 *   2. wire OutboundError.code 枚举(前端按码渲染红卡 + CTA);
 *   3. tape _errorCode 新写入的小写语义码(回看/遥测细分);
 *   4. legacy 大写控制码经 normalizeTurnErrorCode 归一后仍是已知语义码。
 *
 * 新增错误码时,若忘了同步加进 protocol TURN_ERROR_TAXONOMY,本测试即红。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/turnErrorTaxonomyContract.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  OutboundError,
  isKnownTurnErrorCode,
  normalizeTurnErrorCode,
} from '@openclaude/protocol'
import { classifyRunError } from '../errorClassify.js'
import { _tapeErrorCodeForGenericFailure } from '../sessionManager.js'

/** 用代表性错误串驱动 classifyRunError,收集所有非 unknown 产出码(行为断言,
 *  不读源码正则)。每类各喂一条已知命中该码的串。 */
const CLASSIFY_SAMPLES: Array<{ input: string; code: string }> = [
  { input: '402 INSUFFICIENT_CREDITS: balance=1 required=9', code: 'insufficient_credits' },
  { input: '429 Too Many Requests', code: 'rate_limited' },
  { input: 'Selected model is at capacity. Please try a different model.', code: 'model_capacity' },
  { input: 'Anthropic returned 502 Bad Gateway', code: 'upstream_failed' },
]

describe('turnErrorTaxonomy 契约 — classifyRunError 产出码', () => {
  it('每个代表串真的命中预期码(锚定驱动集有效)', () => {
    for (const s of CLASSIFY_SAMPLES) {
      assert.equal(classifyRunError(s.input).code, s.code, `sample: ${s.input}`)
    }
  })

  it('所有非 unknown 产出码 ∈ TURN_ERROR_TAXONOMY', () => {
    for (const s of CLASSIFY_SAMPLES) {
      const { code } = classifyRunError(s.input)
      assert.ok(isKnownTurnErrorCode(code), `classify code 不在 taxonomy: ${code}`)
    }
  })

  it("unknown 不进 taxonomy(caller 压成 upstream_failed 后才上 wire)", () => {
    assert.equal(classifyRunError('TypeError: boom').code, 'unknown')
    assert.equal(isKnownTurnErrorCode('unknown'), false)
    assert.equal(isKnownTurnErrorCode('upstream_failed'), true)
  })
})

describe('turnErrorTaxonomy 契约 — wire OutboundError.code 枚举', () => {
  it('OutboundError.code 每个字面量 ∈ TURN_ERROR_TAXONOMY', () => {
    const wireCodes = (OutboundError as any).properties.code.anyOf.map(
      (s: { const: string }) => s.const,
    ) as string[]
    assert.ok(wireCodes.length >= 4, 'wire 枚举应至少 4 个码')
    for (const code of wireCodes) {
      assert.ok(isKnownTurnErrorCode(code), `wire code 不在 taxonomy: ${code}`)
    }
    // model_capacity 是本批新增 wire 码,显式钉死其在枚举里(防被摘掉)。
    assert.ok(wireCodes.includes('model_capacity'))
  })
})

describe('turnErrorTaxonomy 契约 — tape 新写入语义码', () => {
  it('generic 失败细分出的小写语义码 ∈ taxonomy', () => {
    // 驱动真实 tape 细分函数(不复制其逻辑),命中的语义码必须都是已知码。
    for (const s of CLASSIFY_SAMPLES) {
      const tapeCode = _tapeErrorCodeForGenericFailure(s.input)
      assert.equal(tapeCode, s.code)
      assert.ok(isKnownTurnErrorCode(tapeCode), `tape code 不在 taxonomy: ${tapeCode}`)
    }
  })

  it("unknown 明细保持大写 'ENGINE_ERROR'(值域不变,归一后仍 known)", () => {
    const tapeCode = _tapeErrorCodeForGenericFailure('TypeError: boom')
    assert.equal(tapeCode, 'ENGINE_ERROR')
    assert.ok(isKnownTurnErrorCode(normalizeTurnErrorCode(tapeCode)))
  })
})

describe('turnErrorTaxonomy 契约 — 免单码不得进 errorClass 细分路径(审计 R9)', () => {
  // 来源:commercial internalTurnWaive.ts —— 按大写 tape `_errorCode` 精确匹配的
  // 自动免单集(LIVENESS_TIMEOUT/IDLE_TIMEOUT/NO_RESPONSE/PHANTOM_TURN)。硬编码
  // 在此(不跨包 import commercial),用途是防未来把这些码搬进 gateway 的
  // classifyRunError / errorClass 细分产出路径 —— 那会让"平台故障自动免单"与
  // "用户可见细分错误"两套语义落在同一码上打架(免单查询按大写精确匹配存量,
  // 细分路径按小写语义码派生 UX;两者归一后必须不相交)。
  const WAIVE_UPPERCASE_CODES = ['LIVENESS_TIMEOUT', 'IDLE_TIMEOUT', 'NO_RESPONSE', 'PHANTOM_TURN']

  it('细分路径产出的小写语义码集合与免单码归一后无交集', () => {
    // tape 新写入的小写语义码 = errorClass 细分路径能产出的全部非 unknown 码。
    // 用本文件的代表性驱动集 + 真实 tape 细分函数收集(不复制其正则)。
    const detailedLowerCodes = new Set<string>()
    for (const s of CLASSIFY_SAMPLES) {
      const cls = classifyRunError(s.input).code
      if (cls !== 'unknown') detailedLowerCodes.add(cls)
      const tapeCode = _tapeErrorCodeForGenericFailure(s.input)
      // 细分路径产出的**小写**语义码才算(大写 ENGINE_ERROR 兜底不属于细分,跳过)。
      if (tapeCode === tapeCode.toLowerCase()) detailedLowerCodes.add(tapeCode)
    }
    for (const raw of WAIVE_UPPERCASE_CODES) {
      const norm = normalizeTurnErrorCode(raw) // 归一到小写语义码
      assert.ok(
        !detailedLowerCodes.has(norm),
        `免单码 ${raw} 归一为 ${norm} 落入了 errorClass 细分产出集(会与免单查询抢语义)`,
      )
    }
  })
})

describe('turnErrorTaxonomy 契约 — legacy 大写控制码归一', () => {
  const LEGACY_CODES = [
    'ENGINE_ERROR',
    'AUTH_ERROR',
    'NO_RESPONSE',
    'PHANTOM_TURN',
    'IDLE_TIMEOUT',
    'LIVENESS_TIMEOUT',
    'TURN_LIMIT',
    'USER_CANCELLED',
  ]

  it('每个 legacy 大写码 normalizeTurnErrorCode 后 ∈ taxonomy', () => {
    for (const raw of LEGACY_CODES) {
      const norm = normalizeTurnErrorCode(raw)
      assert.ok(
        isKnownTurnErrorCode(norm),
        `legacy ${raw} 归一到 ${norm} 不在 taxonomy`,
      )
    }
  })
})
