/** Interactive Box sessions (box-claude-*) take their Box exec endpoint from the master instead of the
 * container's Cursor credential pool, which only publishes accounts whose Sand relay is installed (a relay
 * this route never uses). cursor-* (Sand inference) keeps the pool. OCV5-378, operator decision 2026-10-12. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoxExecTargetError } from '../engine/boxLoginClient.js'
import { cursorBoxCcFromMaster, writeBoxCcControlFile } from '../engine/cursorBoxCc.js'
import { masterBoxCredentialSelection, type CursorCredentialSelection } from '../engine/cursorCredentialSelection.js'
import { CursorRoutingAdapter } from '../engine/cursorRoutingAdapter.js'

const MASTER = 'http://172.31.0.1:18892'
const ENV = { OC_CURSOR_SAND_BOX_CC: '1', ANTHROPIC_BASE_URL: MASTER, OPENCLAUDE_V3_MASTER_BASE_URL: MASTER }
const TARGET = { accountId: '25', execUrl: 'https://box.example.cursorvm.com/agent.v1.ControlService/Exec', execToken: 'T0K', networkToken: 'N3T' }

test('only box-claude rows on a local container with the master route take the master Box', () => {
  assert.equal(cursorBoxCcFromMaster('box-claude-haiku-5-5', false, ENV), true)
  assert.equal(cursorBoxCcFromMaster('box-claude-opus-5-5', false, ENV), true)
  assert.equal(cursorBoxCcFromMaster('cursor-grok-4.7-high', false, ENV), false, 'Sand inference keeps the pool')
  assert.equal(cursorBoxCcFromMaster('box-claude-haiku-5-5', true, ENV), false, 'remote execution target')
  assert.equal(cursorBoxCcFromMaster('box-claude-haiku-5-5', false, { ...ENV, OC_CURSOR_SAND_BOX_CC: '0' }), false)
  assert.equal(cursorBoxCcFromMaster('box-claude-haiku-5-5', false, { OC_CURSOR_SAND_BOX_CC: '1' }), false, 'no master route: pool path')
})

function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v }
  return fn().finally(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })
}

test('a box-claude session never asks the pool, at creation or at later turns; its resume ids are unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'box-master-route-'))
  try {
    await withEnv(ENV, async () => {
      let asked = 0
      const selector = (() => { asked++; throw new Error('CURSOR_CREDENTIAL_SELECTION_FAILED:oc-cursor: Cursor CLI is not enabled for this account') }) as never
      const router = new CursorRoutingAdapter({ sessionKey: 'agent:main:test:box-master', agentId: 'main', agentBaseDir: dir,
        config: {} as never, model: 'box-claude-haiku-5-5' }, selector)
      assert.equal(router.currentVariant, 'sand-box-cc')
      assert.equal(router.currentCredentialForTest.masterBox, true)
      await router.refreshVariantForTest()
      assert.equal(asked, 0, 'the empty pool is never consulted')
      // Chats that ran on the pool route keep resuming: same variant, same resume-id prefix.
      assert.equal(router.isResumeIdCompatible('sand-box-cc:3bdc1a6e-63e3-4a3b-a29f-9aeb4e08c1cd'), true)
      await router.shutdown()
      // cursor-* still selects from the pool (and still fails cleanly when it is empty).
      assert.throws(() => new CursorRoutingAdapter({ sessionKey: 'agent:main:test:sand', agentId: 'main', agentBaseDir: dir,
        config: {} as never, model: 'cursor-grok-4.7-high' }, selector), /Cursor CLI is not enabled/)
      assert.equal(asked, 1)
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the control file carries the master endpoint and account; an unavailable answer is retried once, a refusal never', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'box-master-control-'))
  try {
    const selection: CursorCredentialSelection = masterBoxCredentialSelection()
    let calls = 0
    const path = await writeBoxCcControlFile({ selection, sessionKey: 'agent:main:web:x', dir, retryDelayMs: 1,
      requestExecTarget: async () => { calls++; if (calls === 1) throw new BoxExecTargetError('BOX_EXEC_TARGET_UNAVAILABLE'); return TARGET } })
    assert.equal(calls, 2)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    const control = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual({ execUrl: control.execUrl, execToken: control.execToken, networkToken: control.networkToken, accountId: control.accountId,
      remoteClaude: control.remoteClaude, cwd: control.cwd },
      { execUrl: TARGET.execUrl, execToken: 'T0K', networkToken: 'N3T', accountId: '25', remoteClaude: '/home/box/.local/bin/claude', cwd: '/workspace' })
    assert.match(control.fifo, /^\/tmp\/oc-box-cc-[a-f0-9]{16}\.fifo$/)
    let refused = 0
    await assert.rejects(writeBoxCcControlFile({ selection, sessionKey: 'agent:main:web:y', dir, retryDelayMs: 1,
      requestExecTarget: async () => { refused++; throw new BoxExecTargetError('BOX_EXEC_NOT_ENTITLED') } }), /BOX_EXEC_NOT_ENTITLED/)
    assert.equal(refused, 1)
    let down = 0
    await assert.rejects(writeBoxCcControlFile({ selection, sessionKey: 'agent:main:web:z', dir, retryDelayMs: 1,
      requestExecTarget: async () => { down++; throw new BoxExecTargetError('BOX_EXEC_TARGET_UNAVAILABLE') } }), /BOX_EXEC_TARGET_UNAVAILABLE/)
    assert.equal(down, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
