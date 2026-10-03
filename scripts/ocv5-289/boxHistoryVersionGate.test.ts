import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withPinnedBoxHistoryVersion, PINNED_BOX_CLAUDE_VERSION } from './boxHistoryVersionGate.js'

test('mismatched real Box CLI version prevents both staging and inference', async () => {
  for (const observed of [undefined, '', '2.1.278 (Claude Code)', '2.1.281 (Claude Code)',
    '2.1.280 (Claude Code) extra']) {
    let stagedOrInferred = 0
    await assert.rejects(withPinnedBoxHistoryVersion(observed, async () => {
      stagedOrInferred++
    }), /BOX_HISTORY_CLI_VERSION_CHANGED/)
    assert.equal(stagedOrInferred, 0)
  }
})

test('exact verified version enters staging once', async () => {
  let calls = 0
  const value = await withPinnedBoxHistoryVersion(PINNED_BOX_CLAUDE_VERSION, async () => {
    calls++
    return 'allowed'
  })
  assert.equal(value, 'allowed')
  assert.equal(calls, 1)
})
