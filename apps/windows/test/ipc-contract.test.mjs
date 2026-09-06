import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  IPC_CHANNELS,
  LOCAL_HOST_ORIGIN,
  MAX_SHELL_COMMAND_ID_LENGTH,
  createLocalHostIpcHandler,
  isTrustedLocalHostEvent,
  isTrustedShellEvent,
  parseLocalHostCommand,
  parseShellCommand,
} from '../src/ipc-contract.mjs'

const srcDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')

test('IPC channel names are fixed narrow contracts', () => {
  assert.deepEqual(IPC_CHANNELS, {
    command: 'aurora:shell-command',
    state: 'aurora:shell-state',
    localHost: 'clarvy:local-host',
  })
  assert.equal(LOCAL_HOST_ORIGIN, 'app://clarvy-local')
})

test('parseShellCommand accepts only enumerated exact-shape commands', () => {
  for (const type of [
    'ready',
    'back',
    'forward',
    'reload',
    'home',
    'open-more-menu',
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

test('parseLocalHostCommand accepts the privileged whitelist and rejects extra keys', () => {
  for (const type of ['get-status', 'choose-workspace', 'fallback-cloud', 'start-enroll']) {
    assert.deepEqual(parseLocalHostCommand({ type }), { type })
  }
  assert.deepEqual(parseLocalHostCommand({ type: 'set-workspace', path: 'C:\\work' }), {
    type: 'set-workspace',
    path: 'C:\\work',
  })
  assert.deepEqual(parseLocalHostCommand({ type: 'approve-op', id: 'op-1' }), {
    type: 'approve-op',
    id: 'op-1',
  })
  assert.equal(parseLocalHostCommand({ type: 'start-enroll', extra: true }), null)
  assert.equal(parseLocalHostCommand({ type: 'set-workspace' }), null)
  assert.equal(parseLocalHostCommand({ type: 'open-url' }), null)
})

test('isTrustedLocalHostEvent accepts app://clarvy-local and rejects product origins', () => {
  const local = trustedFixture('app://clarvy-local/index.html')
  assert.equal(isTrustedLocalHostEvent(local.event, local.webContents), true)
  const product = trustedFixture('https://claudeai.chat/')
  assert.equal(isTrustedLocalHostEvent(product.event, product.webContents), false)
  const shell = trustedFixture('app://aurora-shell/index.html')
  assert.equal(isTrustedLocalHostEvent(shell.event, shell.webContents), false)
})

test('createLocalHostIpcHandler rejects forged product frames for start-enroll and later ops', async () => {
  const local = trustedFixture('app://clarvy-local/index.html')
  const started = []
  const audits = []
  const handler = createLocalHostIpcHandler({
    getLocalWebContents: () => local.webContents,
    enrollment: {
      start: async () => {
        started.push('start')
        return { enrollmentId: 'id', authUrl: 'https://claudeai.chat/desktop/enroll' }
      },
    },
    audit: (entry) => audits.push(entry),
  })

  for (const url of ['https://claudeai.chat/', 'app://aurora-shell/index.html']) {
    const forged = trustedFixture(url)
    for (const payload of [{ type: 'start-enroll' }, { type: 'approve-op', id: 'op-1' }, { type: 'set-workspace', path: 'C:\\w' }, { type: 'choose-workspace' }]) {
      const result = await handler(forged.event, payload)
      assert.equal(result.ok, false, url)
      assert.equal(result.error, 'forbidden', url)
    }
  }
  assert.deepEqual(started, [])
  assert.equal(audits.some((entry) => entry.event === 'ipc_rejected'), true)
})

test('createLocalHostIpcHandler allows trusted local start-enroll and gates not-implemented ops', async () => {
  const local = trustedFixture('app://clarvy-local/index.html')
  const handler = createLocalHostIpcHandler({
    getLocalWebContents: () => local.webContents,
    enrollment: {
      start: async () => ({ enrollmentId: 'enroll-1', authUrl: 'https://claudeai.chat/desktop/enroll?enrollment_id=enroll-1' }),
      getStatus: () => ({ phase: 'idle', hasIdentity: false, enrollmentId: null }),
    },
  })

  const started = await handler(local.event, { type: 'start-enroll' })
  assert.deepEqual(started, {
    ok: true,
    enrollmentId: 'enroll-1',
    authUrl: 'https://claudeai.chat/desktop/enroll?enrollment_id=enroll-1',
  })

  const status = await handler(local.event, { type: 'get-status' })
  assert.equal(status.ok, true)
  assert.equal(status.status.phase, 'idle')

  const approve = await handler(local.event, { type: 'approve-op', id: 'op-1' })
  assert.deepEqual(approve, { ok: false, error: 'not-implemented' })
  const workspace = await handler(local.event, { type: 'set-workspace', path: 'C:\\work' })
  assert.deepEqual(workspace, { ok: false, error: 'not-implemented' })
})

test('product preload and product WebContentsView do not expose clarvy:local-host', async () => {
  const [productView, shellPreload, localPreload] = await Promise.all([
    readFile(path.join(srcDirectory, 'product-view.mjs'), 'utf8'),
    readFile(path.join(srcDirectory, 'shell-preload.cjs'), 'utf8'),
    readFile(path.join(srcDirectory, 'local-preload.cjs'), 'utf8'),
  ])
  assert.equal(productView.includes('clarvy:local-host'), false)
  assert.equal(productView.includes('preload'), true)
  assert.equal(shellPreload.includes('clarvy:local-host'), false)
  assert.equal(shellPreload.includes('clarvyLocalHost'), false)
  assert.equal(localPreload.includes("exposeInMainWorld('clarvyLocalHost'"), true)
  assert.equal(localPreload.includes('clarvy:local-host'), true)
})
