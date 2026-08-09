import assert from 'node:assert/strict'
import test from 'node:test'

import {
  IPC_CHANNELS,
  MAX_SHELL_COMMAND_ID_LENGTH,
  isTrustedShellEvent,
  parseShellCommand,
} from '../src/ipc-contract.mjs'

test('IPC channel names are fixed narrow contracts', () => {
  assert.deepEqual(IPC_CHANNELS, {
    command: 'aurora:shell-command',
    state: 'aurora:shell-state',
  })
})

test('parseShellCommand accepts only enumerated exact-shape commands', () => {
  for (const type of [
    'ready',
    'back',
    'forward',
    'reload',
    'home',
    'focus-product',
    'downloads-open',
    'downloads-close',
    'open-downloads-folder',
    'zoom-in',
    'zoom-out',
    'zoom-reset',
  ]) {
    assert.deepEqual(parseShellCommand({ type }), { type })
  }
  assert.equal(parseShellCommand({ type: 'home', url: 'https://attacker.invalid' }), null)
  assert.equal(parseShellCommand({ type: 'open-url' }), null)
  assert.equal(parseShellCommand(null), null)
})

test('parseShellCommand validates opaque download ids and their length', () => {
  const id = '018f47ac-2efe-7f0a-a123-0123456789ab'
  assert.deepEqual(parseShellCommand({ type: 'show-download', id }), {
    type: 'show-download',
    id,
  })
  assert.equal(parseShellCommand({ type: 'show-download', id: '../secret' }), null)
  assert.equal(parseShellCommand({ type: 'show-download', id: '' }), null)
  assert.equal(
    parseShellCommand({ type: 'show-download', id: 'a'.repeat(MAX_SHELL_COMMAND_ID_LENGTH + 1) }),
    null,
  )
  assert.equal(parseShellCommand({ type: 'show-download', id, path: 'C:\\secret.txt' }), null)
})

function trustedFixture(url = 'app://aurora-shell/index.html') {
  const mainFrame = { url, parent: null }
  const webContents = { mainFrame, isDestroyed: () => false }
  return { event: { sender: webContents, senderFrame: mainFrame }, webContents, mainFrame }
}

test('isTrustedShellEvent requires the exact shell sender, origin, and main frame', () => {
  const fixture = trustedFixture()
  assert.equal(isTrustedShellEvent(fixture.event, fixture.webContents), true)

  const wrongSender = { ...fixture.event, sender: { mainFrame: fixture.mainFrame } }
  assert.equal(isTrustedShellEvent(wrongSender, fixture.webContents), false)

  const childFrame = { url: fixture.mainFrame.url, parent: fixture.mainFrame }
  assert.equal(
    isTrustedShellEvent(
      { sender: fixture.webContents, senderFrame: childFrame },
      fixture.webContents,
    ),
    false,
  )
  assert.equal(
    isTrustedShellEvent(
      trustedFixture('app://aurora-shell.attacker.invalid/index.html').event,
      trustedFixture().webContents,
    ),
    false,
  )
})

test('isTrustedShellEvent rejects lookalike origins, credentials, and ports', () => {
  for (const url of [
    'https://aurora-shell/index.html',
    'app://aurora-shell.attacker.invalid/index.html',
    'app://user@aurora-shell/index.html',
    'app://aurora-shell:123/index.html',
  ]) {
    const fixture = trustedFixture(url)
    assert.equal(isTrustedShellEvent(fixture.event, fixture.webContents), false, url)
  }
})
