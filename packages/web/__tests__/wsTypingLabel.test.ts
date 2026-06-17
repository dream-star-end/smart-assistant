/**
 * Tests for `_computeTypingLabel` — the pure escalation-ladder decision behind
 * the typing indicator's label text + single style class. Extracted by source
 * slicing (websocket.js carries browser-only deps and can't be imported under
 * node) — same column-0 closing-brace trick as the sibling wsPartialJsonDelta
 * test, plus pulling the three threshold consts so the rungs use real values.
 *
 * Ladder (priority high→low):
 *   compacting → stale-danger(>=5min) → stale-warn(>=90s) →
 *   generating(>=10s) → 思考中(>=5s) → 思考中(<5s / cold-hint)
 *
 * The `generating` rung is the 2026-06 addition: a neutral "正在生成内容" reassurance
 * for upstreams that buffer tool input (e.g. glm-5.2 / 火山方舟 Write/Edit, which
 * flush the whole tool_use only at turn end) so a 10-40s silent window reads as
 * "working", not "frozen". Model-agnostic — keyed on silence, not on model.
 *
 * Run: npx tsx --test packages/web/__tests__/wsTypingLabel.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const WS_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'websocket.js'),
  'utf-8',
)

function extractTopLevelFn(source: string, name: string): string {
  const lines = source.split('\n')
  const headerIdx = lines.findIndex((l) =>
    new RegExp(`^(export\\s+)?function\\s+${name}\\s*\\(`).test(l),
  )
  if (headerIdx === -1) throw new Error(`function ${name} not found`)
  let endIdx = headerIdx + 1
  for (; endIdx < lines.length; endIdx++) {
    if (/^\}\s*$/.test(lines[endIdx])) break
  }
  return lines
    .slice(headerIdx, endIdx + 1)
    .join('\n')
    .replace(/^export\s+/, '')
}

// The fn closes over three module-level thresholds; pull their declarations so
// the extracted source uses the real source values (keeps the test in lockstep
// with the thresholds instead of hard-coding copies that could silently drift).
function extractConst(source: string, name: string): string {
  const m = source.match(new RegExp(`^const\\s+${name}\\s*=\\s*[^\\n]+$`, 'm'))
  if (!m) throw new Error(`const ${name} not found`)
  return m[0]
}

const _consts = ['STALE_WARN_MS', 'STALE_DANGER_MS', 'STALE_GENERATING_MS']
  .map((n) => extractConst(WS_SRC, n))
  .join('\n')
const _fnSrc = extractTopLevelFn(WS_SRC, '_computeTypingLabel')
type LabelArg = {
  name: string
  secs: number
  silenceMs: number
  turnStatus?: string | null
  hint?: string
}
const _computeTypingLabel = new Function(
  `${_consts}\n${_fnSrc}\nreturn _computeTypingLabel;`,
)() as (a: LabelArg) => { text: string; cls: string }

const NAME = 'AI'
const ESCALATION_CLASSES = ['', 'generating', 'stale-warn', 'stale-danger', 'compacting']

describe('_computeTypingLabel — escalation ladder', () => {
  it('cls is always exactly one known escalation class', () => {
    for (const silenceMs of [0, 5_000, 10_000, 90_000, 300_000]) {
      const r = _computeTypingLabel({ name: NAME, secs: 30, silenceMs })
      assert.ok(ESCALATION_CLASSES.includes(r.cls), `unexpected cls=${r.cls}`)
    }
  })

  it('<5s with no hint → plain 思考中 (no elapsed, no class)', () => {
    const r = _computeTypingLabel({ name: NAME, secs: 3, silenceMs: 3_000 })
    assert.equal(r.text, 'AI 思考中')
    assert.equal(r.cls, '')
  })

  it('<5s with cold-start hint → hint appended, no class', () => {
    const r = _computeTypingLabel({
      name: NAME,
      secs: 3,
      silenceMs: 0,
      hint: ' · 容器首次加载中,稍候',
    })
    assert.equal(r.text, 'AI 思考中 · 容器首次加载中,稍候')
    assert.equal(r.cls, '')
  })

  it('>=5s streaming normally → 思考中 (Ns), no class', () => {
    const r = _computeTypingLabel({ name: NAME, secs: 30, silenceMs: 2_000 })
    assert.equal(r.text, 'AI 思考中 (30s)')
    assert.equal(r.cls, '')
  })

  it('just under generating threshold (9.9s silence) → still 思考中', () => {
    const r = _computeTypingLabel({ name: NAME, secs: 12, silenceMs: 9_999 })
    assert.equal(r.cls, '')
    assert.match(r.text, /思考中 \(12s\)/)
  })

  it('>=10s silence → generating: neutral "正在生成内容,请稍候" + generating class', () => {
    const r = _computeTypingLabel({ name: NAME, secs: 14, silenceMs: 10_000 })
    assert.equal(r.cls, 'generating')
    assert.equal(r.text, 'AI 正在生成内容,请稍候 (14s)')
    // Reassuring, NOT a stall warning — must not surface the "无新数据" diagnostic.
    assert.doesNotMatch(r.text, /无新数据/)
  })

  it('>=90s silence → stale-warn 深度思考中 with 无新数据 diagnostic (not generating)', () => {
    const r = _computeTypingLabel({ name: NAME, secs: 95, silenceMs: 90_000 })
    assert.equal(r.cls, 'stale-warn')
    assert.match(r.text, /深度思考中/)
    assert.match(r.text, /90s 无新数据/)
  })

  it('>=5min silence → stale-danger 处理时间较长 (not generating/stale-warn)', () => {
    const r = _computeTypingLabel({ name: NAME, secs: 320, silenceMs: 300_000 })
    assert.equal(r.cls, 'stale-danger')
    assert.match(r.text, /处理时间较长,仍在思考中/)
    assert.match(r.text, /300s 无新数据/)
  })

  it('compacting wins over every silence rung', () => {
    const r = _computeTypingLabel({
      name: NAME,
      secs: 400,
      silenceMs: 600_000,
      turnStatus: 'compacting',
    })
    assert.equal(r.cls, 'compacting')
    assert.match(r.text, /正在压缩上下文/)
  })
})
