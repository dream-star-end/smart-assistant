import assert from 'node:assert/strict'
import { test } from 'node:test'
// @ts-ignore -- plain ESM helper without types
import { launchJourneyBrowser } from '../lib/journey-browser.mjs'
// @ts-ignore -- plain ESM helper without types
import { waitJ5Delivered } from '../lib/journey-j5.mjs'

// 2026-10-08 smoke robustness: J5 anchored on our own user row; backend-proven bounded grace.
const MARKER = 'e2e journey canary abc123'
const PROBE = 'OC_ATTACH_abc123_secret'
const userRow = (t: string) => `<div data-testid="user-row"><div data-testid="message-text">${t}</div></div>`
const asst = (body: string, extra = '') => `<div data-testid="assistant-row"><div class="prose">${body}</div>${extra}</div>`
const SEND = '<button aria-label="发送">发送</button>'
const STOP = '<button aria-label="停止">停止</button>'

// `steps`: [ms, html] — the chat body is replaced at each time offset.
function page(steps: Array<[number, string]>, sidebar = '') {
  const js = steps.map(([ms, html]) => `setTimeout(()=>{document.getElementById('chat').innerHTML=${JSON.stringify(html)}},${ms});`).join('')
  return `<!doctype html><nav>${sidebar}</nav><main id="chat"></main><script>${js}</script>`
}

async function run(html: string, opts: Record<string, unknown> = {}) {
  const browser = await launchJourneyBrowser()
  const logs: string[] = []
  let evidence: unknown = null
  try {
    const p = await browser.newPage()
    await p.setContent(html)
    const started = Date.now()
    try {
      const r = await waitJ5Delivered(p, {
        marker: MARKER, probeToken: PROBE, turnWaitMs: 800, graceMs: 1_500, pollMs: 50,
        backendCheck: () => ({ checked: true, found: false, detail: 'n=0' }),
        log: (l: string) => logs.push(l), onEvidence: (e: unknown) => { evidence = e },
        ...opts,
      })
      return { ok: true as const, r, logs, evidence, ms: Date.now() - started }
    } catch (err) {
      return { ok: false as const, err: err as Error, logs, evidence, ms: Date.now() - started }
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

const goal = userRow('e2e-goal-x') + asst('我先读取完整请求', '<span>已停止生成</span>')

test('OCV5-334: a stopped goal row before our message and a shifting row count do not hide the reply', { timeout: 60_000 }, async () => {
  const r = await run(page([
    [0, goal + asst('placeholder') + userRow(MARKER) + STOP],
    // the goal turn's extra row disappears (count drops) while our reply streams, then finishes
    [200, goal + userRow(MARKER) + asst('OC_ATTACH', '<span class="caret-blink"></span>') + STOP],
    [400, goal + userRow(MARKER) + asst(PROBE) + SEND],
  ]))
  assert.equal(r.ok, true, r.ok ? '' : r.err.message)
  assert.deepEqual(r.logs, [])
})

test('only rows AFTER our user row count: an earlier finished row with the probe is not accepted', { timeout: 60_000 }, async () => {
  const r = await run(page([[0, asst(PROBE) + userRow(MARKER) + SEND]]))
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.err.message, /180|0\.8s 内未完成.*后端核对:n=0/)
})

test('marker only in the sidebar (no chat user row) never anchors', { timeout: 60_000 }, async () => {
  const r = await run(page([[0, goal + asst(PROBE) + SEND]], `<a>${MARKER}</a>`))
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.err.message, /内未完成/)
})

test('no backend proof at the deadline -> fails immediately, no grace', { timeout: 60_000 }, async () => {
  const r = await run(page([[0, userRow(MARKER) + asst('...', '<span class="caret-blink"></span>') + STOP]]), { graceMs: 30_000 })
  assert.equal(r.ok, false)
  assert.ok(r.ms < 10_000, `took ${r.ms}ms`)
  assert.deepEqual((r.evidence as any)?.backend, { checked: true, found: false, detail: 'n=0' })
})

test('backend has the probe reply and the UI settles in the grace window -> pass, recorded as slow_ui_settle', { timeout: 60_000 }, async () => {
  const r = await run(page([
    [0, userRow(MARKER) + asst('OC_ATTACH', '<span class="caret-blink"></span>') + STOP],
    [1_400, userRow(MARKER) + asst(PROBE) + SEND],
  ]), { backendCheck: () => ({ checked: true, found: true, detail: 'n=1' }) })
  assert.equal(r.ok, true, r.ok ? '' : r.err.message)
  assert.match(r.logs.join('\n'), /warn slow_ui_settle J5 ui_settled_ms_after_backend=\d+/)
})

test('backend has the probe reply but the UI never settles -> hard fail after the grace with evidence', { timeout: 60_000 }, async () => {
  const r = await run(page([[0, userRow(MARKER) + asst(PROBE, '<span class="caret-blink"></span>') + STOP]]),
    { backendCheck: () => ({ checked: true, found: true, detail: 'n=1' }) })
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.err.message, /UI 在宽限 1\.5s 内仍未收尾/)
  assert.ok((r.evidence as any).atDeadline && (r.evidence as any).atGraceEnd)
})

test('zero tolerance stays: failure signature, alert row and missing probe all fail', { timeout: 60_000 }, async () => {
  const sig = await run(page([[0, userRow(MARKER) + '<div>发送失败</div>' + SEND]]))
  assert.match(sig.ok ? '' : sig.err.message, /发送失败签名出现/)
  const alert = await run(page([[0, userRow(MARKER) + asst(PROBE, '<div role="alert">x</div>') + SEND]]))
  assert.match(alert.ok ? '' : alert.err.message, /错误\/空轮\/截断/)
  const noProbe = await run(page([[0, userRow(MARKER) + asst('我猜是 hello') + SEND]]))
  assert.match(noProbe.ok ? '' : noProbe.err.message, /未包含附件秘密探针/)
})
