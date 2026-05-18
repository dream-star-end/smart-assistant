import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
/**
 * Wave 7 maintainability cleanup invariants.
 *
 * Static-source checks that lock the 3 cleanups in place:
 *   A. main.js no longer imports 38 dead names.
 *   B. main.js no longer has the lightbox-specific Escape listener that was
 *      a subset of the main one.
 *   C. index.html has no inline event handlers (CSP-ready).
 *   D. agents.js wires #persona-model-preset via addEventListener('change'),
 *      replacing the old inline onchange.
 *
 * Run: npx tsx --test packages/web/__tests__/maintCleanup.test.ts
 */
import { describe, it } from 'node:test'

const PUBLIC = resolve(import.meta.dirname, '..', 'public')

function readPublicFile(name: string): string {
  return readFileSync(resolve(PUBLIC, name), 'utf-8')
}

describe('Wave 7 maintainability cleanup', () => {
  it('A. main.js does not import the 38 dead names', () => {
    const js = readPublicFile('modules/main.js')
    // Only check the import block region (everything before the first
    // non-import statement) — avoids false positives if any of these names
    // re-appear later as a real usage in unrelated future code.
    const importBlock = js.slice(0, js.indexOf('window.__ocBooted'))
    const dead = [
      'GROUP_ORDER',
      '_basename',
      '_cronHuman',
      'sessionGroup',
      'uuid',
      'isSending',
      'dbPut',
      'openDB',
      'effectiveTheme',
      '_imgHtml',
      'embedMediaUrls',
      'localPathToUrl',
      'classifyFile',
      'fileToDataURL',
      'fileToText',
      'removeAttachment',
      'renderAttachments',
      'initSpeech',
      'maybeNotify',
      'requestNotifyPermission',
      'loadBgTasks',
      'loadExecLog',
      'switchTasksTab',
      'renderAgentsManagementList',
      '_buildSessionItem',
      'deleteSession',
      'exportSessionMd',
      'hideContextMenu',
      'showContextMenu',
      'startInlineRename',
      '_buildMessageEl',
      'isAtBottom',
      'renderMetaInto',
      'addBgTask',
      'buildToolUseLabel',
      'completeBgTask',
      'setStatus',
      'updateMessage',
    ]
    for (const name of dead) {
      const re = new RegExp(`\\b${name}\\b`)
      assert.equal(
        re.test(importBlock),
        false,
        `main.js import block still references dead name "${name}"`,
      )
    }
  })

  it('B. main.js no longer has the lightbox-specific Escape listener', () => {
    const js = readPublicFile('modules/main.js')
    // The dead listener had a unique comment header — using it pinpoints
    // exactly the removed block and doesn't collide with the main Escape
    // listener at L762 or the Cmd/Ctrl+K listener at L2747.
    assert.equal(
      js.includes('Lightbox-specific Escape (separate listener'),
      false,
      'main.js still contains the obsolete "Lightbox-specific Escape" listener',
    )
  })

  it('C. index.html has no inline event handlers', () => {
    const html = readPublicFile('index.html')
    // Generalised match for `on<event>=` (onclick / onchange / onsubmit / ...).
    // Restrict to lowercase letters so we don't false-match `aria-onfoo` etc.
    const re = /\son[a-z]+\s*=/g
    const matches = html.match(re) || []
    assert.equal(
      matches.length,
      0,
      `index.html still has inline event handlers: ${matches.join(', ')}`,
    )
  })

  it('D. agents.js wires persona-model-preset via addEventListener', () => {
    const js = readPublicFile('modules/agents.js')
    assert.match(
      js,
      /persona-model-preset[\s\S]*?addEventListener\(\s*['"`]change['"`]/,
      'agents.js does not bind change listener on #persona-model-preset',
    )
  })
})
