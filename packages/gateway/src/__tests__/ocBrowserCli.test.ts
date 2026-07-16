import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseOcBrowserCommand } from '../ocBrowserCli.js'

function ok(argv: string[]) {
  const p = parseOcBrowserCommand(argv)
  assert.equal(p.ok, true, `expected ok for ${argv.join(' ')}: ${p.ok ? '' : p.message}`)
  if (!p.ok) throw new Error('unreachable')
  return p
}
function err(argv: string[], exitCode: number) {
  const p = parseOcBrowserCommand(argv)
  assert.equal(p.ok, false)
  if (p.ok) throw new Error('unreachable')
  assert.equal(p.exitCode, exitCode)
  return p
}

describe('parseOcBrowserCommand — dispatch & usage', () => {
  it('no command → usage error (2)', () => assert.match(err([], 2).message, /Usage: oc-browser/))
  it('help → exit 0', () => assert.equal(parseOcBrowserCommand(['help']).ok, false))
  it('unknown command → usage error (2)', () =>
    assert.match(err(['frob'], 2).message, /unknown command 'frob'/))
  it('subcommand --help → usage, exit 0 (agent 高频探索动作,不算用法错误)', () =>
    assert.match(err(['click', '--help'], 0).message, /Usage: oc-browser/))
  it('subcommand -h → usage, exit 0', () =>
    assert.match(err(['type', '-h'], 0).message, /Usage: oc-browser/))
})

describe('parseOcBrowserCommand — tool/arg mapping', () => {
  it('navigate --url', () => {
    const p = ok(['navigate', '--url', 'https://a'])
    assert.equal(p.tool, 'browser_navigate')
    assert.deepEqual(p.args, { url: 'https://a' })
  })
  it('navigate --url=value form', () => {
    assert.deepEqual(ok(['navigate', '--url=https://b']).args, { url: 'https://b' })
  })
  it('navigate without --url → usage (2)', () =>
    assert.match(err(['navigate'], 2).message, /requires --url/))

  it('snapshot → empty args', () => {
    const p = ok(['snapshot'])
    assert.equal(p.tool, 'browser_snapshot')
    assert.deepEqual(p.args, {})
  })

  it('click --ref --element', () => {
    const p = ok(['click', '--ref', 'e5', '--element', 'Submit button'])
    assert.equal(p.tool, 'browser_click')
    assert.deepEqual(p.args, { ref: 'e5', element: 'Submit button' })
  })
  it('click missing --element → usage (2)', () =>
    assert.match(err(['click', '--ref', 'e5'], 2).message, /requires --element/))

  it('type with --submit boolean', () => {
    const p = ok(['type', '--ref', 'e1', '--element', 'box', '--text', 'hi', '--submit'])
    assert.deepEqual(p.args, { ref: 'e1', element: 'box', text: 'hi', submit: true })
  })
  it('boolean flag given a value → usage (2)', () =>
    assert.match(
      err(['type', '--ref', 'e1', '--element', 'b', '--text', 't', '--submit=1'], 2).message,
      /takes no value/,
    ))

  it('press-key --key', () =>
    assert.deepEqual(ok(['press-key', '--key', 'Enter']).args, { key: 'Enter' }))

  it('screenshot maps --path→filename and --full-page→fullPage', () => {
    const p = ok(['screenshot', '--path', '/tmp/x.png', '--full-page'])
    assert.equal(p.tool, 'browser_take_screenshot')
    assert.deepEqual(p.args, { filename: '/tmp/x.png', fullPage: true })
  })
  it('screenshot with no flags → empty args', () => assert.deepEqual(ok(['screenshot']).args, {}))

  it('wait-for --time coerces to number', () => {
    assert.deepEqual(ok(['wait-for', '--time', '3']).args, { time: 3 })
  })
  it('wait-for --time non-number → usage (2)', () =>
    assert.match(err(['wait-for', '--time', 'soon'], 2).message, /must be a number/))
})

describe('parseOcBrowserCommand — strictness', () => {
  it('unknown flag → usage (2)', () =>
    assert.match(err(['navigate', '--url', 'x', '--bogus'], 2).message, /unknown flag --bogus/))
  it('value flag without value → usage (2)', () =>
    assert.match(err(['navigate', '--url'], 2).message, /requires a value/))
  it('unexpected positional → usage (2)', () =>
    assert.match(err(['snapshot', 'extra'], 2).message, /unexpected argument/))
  it('--json sets asJson and is not a tool arg', () => {
    const p = ok(['snapshot', '--json'])
    assert.equal(p.asJson, true)
    assert.deepEqual(p.args, {})
  })
})
