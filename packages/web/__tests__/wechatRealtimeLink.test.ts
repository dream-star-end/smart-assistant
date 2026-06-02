import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const MAIN_JS = readFileSync(resolve(import.meta.dirname, '..', 'public/modules/main.js'), 'utf-8')

describe('WeChat realtime link boot session selection', () => {
  it('applies ?session from local state before server sync can fail', () => {
    assert.match(
      MAIN_JS,
      /function _applyBootRequestedSessionIfPresent\(\)[\s\S]+state\.sessions\.has\(_bootRequestedSessionId\)[\s\S]+state\.currentSessionId = requestedSessionId[\s\S]+refreshWebchatHelloForCurrentSession\(\)/,
      'main.js must have a local-state helper that selects the requested wsess and refreshes WS hello',
    )
    assert.match(
      MAIN_JS,
      /else createSession\(undefined, \{ bootPlaceholder: !!state\.token \}\)\n  _applyBootRequestedSessionIfPresent\(\)/,
      'boot must apply the requested session immediately after IDB load, before background server sync',
    )
  })

  it('keeps the post-sync path for sessions that only arrive from server sync', () => {
    assert.match(
      MAIN_JS,
      /function _selectSessionAfterServerSync\(\)[\s\S]+const requestedPresent = !!_bootRequestedSessionId && state\.sessions\.has\(_bootRequestedSessionId\)[\s\S]+if \(requestedPresent\) \{[\s\S]+_applyBootRequestedSessionIfPresent\(\)[\s\S]+return \{ currentChanged, updated \}/,
      'post-sync selection must still consume ?session when the wsess was not present in IDB but arrives from server',
    )
  })

  it('honors ?session before deleting an empty boot placeholder', () => {
    const idxRequested = MAIN_JS.indexOf('const requestedPresent')
    const idxApply = MAIN_JS.indexOf('if (requestedPresent)')
    const idxPrune = MAIN_JS.indexOf('state.sessions.delete(current.id)')
    assert.ok(idxRequested >= 0 && idxApply >= 0 && idxPrune >= 0)
    assert.ok(idxRequested < idxApply)
    assert.ok(idxApply < idxPrune, '?session must be consumed before pruning boot placeholders')
  })
})
