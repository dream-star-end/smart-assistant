/**
 * 科研 agent 共享协议测试:
 *   1) 核心 schema(NormalizedDocument / QuoteHandle / EvidenceManifest /
 *      ReportSchema)Value.Check 编解码;拒越界/缺字段。
 *   2) checkManifestStructuralInvariants 的 4 条引用闭合不变量(I1~I4)。
 *
 * 引用接地的**权威**校验(quote 是否真为权威 span 子串、identifier 是否命中)
 * 由 master oc-cite 用 research_documents 铸造,不在协议层测;这里只测结构契约。
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Value } from '@sinclair/typebox/value'

import {
  type EvidenceManifest,
  EvidenceManifest as EvidenceManifestSchema,
  NormalizedDocument,
  QuoteHandle,
  ReportSchema,
  checkManifestStructuralInvariants,
} from '../research.js'

// ── fixtures ──────────────────────────────────────────────────────────

function baseDoc(): unknown {
  return {
    docId: 'doc-sha-1',
    contentSha256: 'abc',
    lang: 'en',
    title: 'A paper',
    spans: [
      { spanId: 's1', sectionPath: ['1'], charStart: 0, charEnd: 20, text: 'Hello world example.' },
    ],
    references: [{ raw: 'Smith 2020', doi: '10.1/x', year: 2020 }],
  }
}

/** verified claim 完整闭合的合法 manifest。 */
function validManifest(): EvidenceManifest {
  return {
    sources: [
      { id: 'src1', title: 'A paper', authors: [{ name: 'Smith' }], doi: '10.1/x', identifiersVerified: true },
    ],
    quotes: [
      { id: 'q1', sourceId: 'src1', docId: 'doc-sha-1', spanId: 's1', charStart: 0, charEnd: 5, text: 'Hello' },
    ],
    claims: [
      { id: 'c1', text: 'Greeting exists.', supports: [{ quoteId: 'q1' }], status: 'verified' },
    ],
    coverage: { verifiedClaims: 1, totalClaims: 1 },
    gates: {
      quoteFirst: { passed: true, checked: 1, failed: 0 },
      claimBound: { passed: true, checked: 1, failed: 0 },
      identifier: { passed: true, checked: 1, failed: 0 },
      retraction: { passed: true, checked: 1, failed: 0 },
    },
  }
}

// ── schema 编解码 ─────────────────────────────────────────────────────

describe('research protocol schemas', () => {
  it('NormalizedDocument: 合法文档通过', () => {
    assert.equal(Value.Check(NormalizedDocument, baseDoc()), true)
  })

  it('NormalizedDocument: 缺 spans 拒', () => {
    const bad = { docId: 'd', contentSha256: 'a', lang: 'en', title: 't', references: [] }
    assert.equal(Value.Check(NormalizedDocument, bad), false)
  })

  it('QuoteHandle: 合法句柄通过;缺 text 拒', () => {
    const q = { id: 'q1', sourceId: 's1', docId: 'd1', spanId: 'sp1', charStart: 0, charEnd: 4, text: 'abcd' }
    assert.equal(Value.Check(QuoteHandle, q), true)
    const { text, ...noText } = q
    assert.equal(Value.Check(QuoteHandle, noText), false)
  })

  it('EvidenceManifest: 合法 manifest 通过', () => {
    assert.equal(Value.Check(EvidenceManifestSchema, validManifest()), true)
  })

  it('ReportSchema: csl 限定枚举', () => {
    const r = {
      title: 'T',
      sections: [{ id: 's', heading: 'H', level: 1, bodyMd: 'x', claimRefs: [] }],
      figures: [],
      bibliography: ['src1'],
      csl: 'gb-t-7714-2015',
    }
    assert.equal(Value.Check(ReportSchema, r), true)
    assert.equal(Value.Check(ReportSchema, { ...r, csl: 'mla' }), false)
  })
})

// ── 引用闭合不变量 ────────────────────────────────────────────────────

describe('checkManifestStructuralInvariants', () => {
  it('合法 manifest 通过', () => {
    const res = checkManifestStructuralInvariants(validManifest())
    assert.equal(res.ok, true, res.violations.join('; '))
  })

  it('I1: claim 引用不存在的 quote → 违例', () => {
    const m = validManifest()
    m.claims[0].supports = [{ quoteId: 'ghost' }]
    const res = checkManifestStructuralInvariants(m)
    assert.equal(res.ok, false)
    assert.ok(res.violations.some((v) => v.startsWith('I1')))
  })

  it('I2: verified claim 无 support → 违例', () => {
    const m = validManifest()
    m.claims[0].supports = []
    // coverage 仍记 1 verified,但无 support
    const res = checkManifestStructuralInvariants(m)
    assert.equal(res.ok, false)
    assert.ok(res.violations.some((v) => v.startsWith('I2')))
  })

  it('I3: quote 指向不存在的 source → 违例', () => {
    const m = validManifest()
    m.quotes[0].sourceId = 'ghost'
    const res = checkManifestStructuralInvariants(m)
    assert.equal(res.ok, false)
    assert.ok(res.violations.some((v) => v.startsWith('I3')))
  })

  it('I4: coverage.verifiedClaims 与实际不符 → 违例', () => {
    const m = validManifest()
    m.coverage.verifiedClaims = 5
    const res = checkManifestStructuralInvariants(m)
    assert.equal(res.ok, false)
    assert.ok(res.violations.some((v) => v.startsWith('I4')))
  })

  it('unsupported claim 不要求 support(fail-closed 红标仍是合法结构)', () => {
    const m = validManifest()
    m.claims[0].status = 'unsupported'
    m.claims[0].supports = []
    m.coverage.verifiedClaims = 0
    const res = checkManifestStructuralInvariants(m)
    assert.equal(res.ok, true, res.violations.join('; '))
  })
})
