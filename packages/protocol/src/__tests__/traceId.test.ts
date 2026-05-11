/**
 * V3 S12e trace id primitive 测试 — 含与 Go ParseTraceIDCandidate 共享 fixture
 * (packages/protocol/testdata/trace-id-cases.json,CG1 同时产物)。
 *
 * 用 node:test runner(项目其余测试一致;tsx --test 调用)。
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  TRACE_ID_HEADER,
  TRACE_ID_REGEX,
  newTraceId,
  parseTraceIdCandidate,
  type TraceIdIssue,
} from '../traceId.js'

interface ParseCase {
  name: string
  rawType: 'null' | 'number' | 'boolean' | 'object' | 'array' | 'string'
  raw: unknown
  expectOk: boolean
  expectIssue?: TraceIdIssue
}
interface HeaderArrayCase {
  name: string
  raw: unknown[]
  expectOk: boolean
  expectIssue?: TraceIdIssue
}
interface Fixture {
  parseCases: ParseCase[]
  headerArrayCases: HeaderArrayCase[]
}

const fixtureUrl = new URL('../../testdata/trace-id-cases.json', import.meta.url)
const fixture: Fixture = JSON.parse(readFileSync(fixtureUrl, 'utf-8'))

describe('newTraceId', () => {
  it('produces 32-char strings that match TRACE_ID_REGEX, with no collisions across 1000 draws', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const id = newTraceId()
      assert.equal(id.length, 32, `unexpected length: ${id}`)
      assert.match(id, TRACE_ID_REGEX)
      assert.ok(!seen.has(id), `duplicate id at draw ${i}: ${id}`)
      seen.add(id)
    }
  })
})

describe('parseTraceIdCandidate (shared fixture)', () => {
  for (const c of fixture.parseCases) {
    it(c.name, () => {
      const result = parseTraceIdCandidate(c.raw)
      if (c.expectOk) {
        assert.equal(result.ok, true, `expected ok=true, got: ${JSON.stringify(result)}`)
        if (result.ok) {
          assert.equal(result.traceId, c.raw)
        }
      } else {
        assert.equal(result.ok, false)
        if (!result.ok) {
          assert.equal(result.issue, c.expectIssue)
        }
      }
    })
  }
})

describe('parseTraceIdCandidate (header array unwrap pattern)', () => {
  // 模拟 Node HTTP API 多值头(`string | string[] | undefined`)的调用方
  // 标准处理:先取第一个元素,再过 parseTraceIdCandidate。fixture 共享给 Go。
  function unwrapHeader(raw: unknown): unknown {
    if (Array.isArray(raw)) return raw[0]
    return raw
  }
  for (const c of fixture.headerArrayCases) {
    it(c.name, () => {
      const result = parseTraceIdCandidate(unwrapHeader(c.raw))
      if (c.expectOk) {
        assert.equal(result.ok, true)
      } else {
        assert.equal(result.ok, false)
        if (!result.ok) {
          assert.equal(result.issue, c.expectIssue)
        }
      }
    })
  }
})

describe('parseTraceIdCandidate (explicit undefined — JSON cannot represent)', () => {
  it('undefined → missing (same code path as null)', () => {
    const result = parseTraceIdCandidate(undefined)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.issue, 'missing')
  })
})

describe('TRACE_ID_HEADER', () => {
  it('is the canonical lowercase header name used across master / node-agent / gateway', () => {
    // 字面值断言:防 typo / 改名误伤。Go 端读 "X-Openclaude-Trace-Id"
    // 经 CanonicalMIMEHeaderKey 等价;Node http.req.headers 已是小写键。
    assert.equal(TRACE_ID_HEADER, 'x-openclaude-trace-id')
    // 小写 invariant:Node req.headers 键全小写,header 字面值必须匹配
    assert.equal(TRACE_ID_HEADER, TRACE_ID_HEADER.toLowerCase())
  })
})
