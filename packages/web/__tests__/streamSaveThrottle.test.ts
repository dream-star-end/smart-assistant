import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const SESSIONS_JS = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'sessions.js'),
  'utf-8',
)
const WEBSOCKET_JS = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'websocket.js'),
  'utf-8',
)

function extractTopLevelFunction(source: string, name: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((line) =>
    new RegExp(`^export\\s+function\\s+${name}\\s*\\(`).test(line),
  )
  assert.notEqual(start, -1, `${name} should exist`)
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') {
      return lines
        .slice(start, i + 1)
        .join('\n')
        .replace(/^export\s+/, '')
    }
  }
  throw new Error(`closing brace not found for ${name}`)
}

function makeScheduleSaveHarness() {
  const src = extractTopLevelFunction(SESSIONS_JS, 'scheduleSave')
  const calls = { rebuild: 0, enqueue: 0 }
  const sess = { id: 's1', title: 'hello', messages: [{ role: 'assistant', text: 'partial' }] }
  const fn = new Function(
    'getSession',
    '_rebuildSearchIndex',
    '_saveTimers',
    '_enqueueSave',
    'console',
    `${src}; return scheduleSave;`,
  )(
    () => sess,
    () => calls.rebuild++,
    new Map(),
    () => calls.enqueue++,
    { warn() {} },
  ) as (s?: any, immediate?: boolean, opts?: { rebuildSearchIndex?: boolean }) => void
  return { fn, sess, calls }
}

describe('streaming save throttling', () => {
  it('scheduleSave preserves default search-index rebuild behavior', () => {
    const { fn, calls } = makeScheduleSaveHarness()
    fn(undefined, true)
    assert.equal(calls.rebuild, 1)
    assert.equal(calls.enqueue, 1)
  })

  it('scheduleSave can skip search-index rebuild for non-final streaming frames', () => {
    const { fn, sess, calls } = makeScheduleSaveHarness()
    fn(sess, true, { rebuildSearchIndex: false })
    assert.equal(calls.rebuild, 0)
    assert.equal(calls.enqueue, 1)
    assert.equal(sess._dirty, true)
    assert.equal(typeof sess.lastAt, 'number')
  })

  it('handleOutbound passes final-only search-index rebuild option to scheduleSave', () => {
    assert.match(
      WEBSOCKET_JS,
      /_deps\.scheduleSave\(sess,\s*!!frame\.isFinal,\s*\{\s*rebuildSearchIndex:\s*!!frame\.isFinal\s*\}\)/,
    )
  })
})
