import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createLocalHostIpcHandler } from '../src/ipc-contract.mjs'
import { createApprovalController } from '../src/host/workspace/approval.mjs'
import { createWorkspaceStore } from '../src/host/workspace/workspaces.mjs'

function trustedFixture(url = 'app://clarvy-local/index.html') {
  const mainFrame = { url, parent: null }
  const webContents = { mainFrame, isDestroyed: () => false }
  return { event: { sender: webContents, senderFrame: mainFrame }, webContents, mainFrame }
}

test('forged product frames cannot set-workspace, choose-workspace, or approve-op', async () => {
  const local = trustedFixture()
  const audits = []
  const handler = createLocalHostIpcHandler({
    getLocalWebContents: () => local.webContents,
    audit: (entry) => audits.push(entry),
    workspace: {
      setWorkspace: async () => ({ ok: true, roots: ['/nope'] }),
      chooseWorkspace: async () => ({ ok: true, roots: ['/nope'] }),
    },
    approval: { approve: () => ({ ok: true, approved: true }), deny: () => ({ ok: true, approved: false }) },
  })
  for (const url of ['https://claudeai.chat/', 'app://aurora-shell/index.html']) {
    const forged = trustedFixture(url)
    for (const payload of [
      { type: 'set-workspace', path: 'C:\\w' },
      { type: 'choose-workspace' },
      { type: 'approve-op', id: 'op-1' },
    ]) {
      const result = await handler(forged.event, payload)
      assert.equal(result.ok, false, url)
      assert.equal(result.error, 'forbidden', url)
    }
  }
  assert.equal(audits.some((entry) => entry.event === 'ipc_rejected'), true)
})

test('trusted local-host window can set-workspace, choose-workspace, and approve-op', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clarvy-ipc-ws-'))
  const filePath = path.join(directory, 'workspaces.json')
  try {
    const local = trustedFixture()
    const store = createWorkspaceStore({ filePath })
    const prompted = []
    const approval = createApprovalController({
      setTimer: (fn) => ({ fn, cleared: false }),
      clearTimer: (handle) => {
        if (handle) handle.cleared = true
      },
      prompt: async (request) => {
        prompted.push(request.id)
      },
    })
    const handler = createLocalHostIpcHandler({
      getLocalWebContents: () => local.webContents,
      workspace: {
        setWorkspace: (rootPath) => store.setWorkspace(rootPath),
        chooseWorkspace: async () => store.setWorkspace('/tmp/chosen-proj'),
      },
      approval,
    })

    const setResult = await handler(local.event, { type: 'set-workspace', path: '/tmp/proj' })
    assert.equal(setResult.ok, true)
    assert.deepEqual(setResult.roots, ['/tmp/proj'])

    const chosen = await handler(local.event, { type: 'choose-workspace' })
    assert.equal(chosen.ok, true)
    assert.equal(chosen.roots[0], '/tmp/chosen-proj')

    const pending = approval.requestApproval({ kind: 'rm-rf', detail: { path: '/tmp/proj' } })
    await Promise.resolve()
    assert.equal(prompted.length, 1)
    const approved = await handler(local.event, { type: 'approve-op', id: prompted[0] })
    assert.equal(approved.ok, true)
    assert.equal(approved.approved, true)
    assert.equal((await pending).approved, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
