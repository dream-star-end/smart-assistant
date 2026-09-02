import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const patcherUrl = pathToFileURL(resolve(
  process.cwd(),
  'packages/commercial/agent-sandbox/scripts/patch-cursor-agent-sand.mjs',
)).href

test('Cursor Agent Sand build helper stays outside the hot-config platform bundle', () => {
  assert.equal(existsSync(resolve(
    process.cwd(),
    'packages/commercial/agent-sandbox/scripts/patch-cursor-agent-sand.mjs',
  )), true)
  assert.equal(existsSync(resolve(
    process.cwd(),
    'packages/commercial/agent-sandbox/platform-runtime/bin/patch-cursor-agent-sand.mjs',
  )), false)
})

test('Cursor Agent Sand patch is env-gated and scopes headers away from AgentService', async () => {
  const patcher = await import(patcherUrl) as {
    SAND_PATCH_MARKER: string
    patchCursorAgentSource(source: string): string
  }
  const anchor = 's.header.set("x-cursor-client-version",`cli-${h}${A}`),s.header.set("x-cursor-client-type",m)'
  const patched = patcher.patchCursorAgentSource(`before;${anchor};after`)
  assert.match(patched, /OPENCLAUDE_CURSOR_SAND_MODE===\"1\"/)
  assert.match(patched, /ChatService\|InferenceService\|AiService/)
  assert.match(patched, /x-sand-box-namespace\",\"prod/)
  assert.match(patched, /e\?\"sand\":m/)
  assert.match(patched, new RegExp(patcher.SAND_PATCH_MARKER))
  assert.doesNotMatch(patched, /Headers\.prototype/)
})

test('Cursor Agent Sand patch fails closed on missing, duplicate, or already-patched anchors', async () => {
  const patcher = await import(patcherUrl) as {
    patchCursorAgentSource(source: string): string
  }
  const anchor = 's.header.set("x-cursor-client-version",`cli-${h}${A}`),s.header.set("x-cursor-client-type",m)'
  assert.throws(() => patcher.patchCursorAgentSource('no anchor'), /anchor count=0/)
  assert.throws(() => patcher.patchCursorAgentSource(anchor + anchor), /anchor count=2/)
  assert.throws(
    () => patcher.patchCursorAgentSource(`${anchor}/*OPENCLAUDE_SCOPED_SAND_V1*/`),
    /already present/,
  )
})
