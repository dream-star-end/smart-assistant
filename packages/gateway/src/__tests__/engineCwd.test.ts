/**
 * Webchat project cwd vs session-repo overlay.
 * Run: npx tsx --test packages/gateway/src/__tests__/engineCwd.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'oc-engine-cwd-'))
process.env.OPENCLAUDE_HOME = TEST_HOME
process.env.OC_PROJECT_CONTEXT = '1'

const { decideEngineCwd } = await import('../engineCwd.js')
const { resolveChatRunWorkspace } = await import('../projectWorkspace.js')
const { resolveProjectCwd } = await import('@openclaude/storage')

const ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('decideEngineCwd', () => {
  it('bound session without repo uses project workspace', () => {
    const d = decideEngineCwd({
      agentBaseDir: '/home/agent/.openclaude/workspace/projects/' + ID,
      repoSnapshot: null,
      projectBound: true,
    })
    assert.equal(d.source, 'project_workspace')
    assert.equal(d.sessionRepoOverlay, false)
    assert.equal(d.cwd, d.agentBaseDir)
  })

  it('ready session-repo overlays project workspace (allowed)', () => {
    const d = decideEngineCwd({
      agentBaseDir: '/home/agent/.openclaude/workspace/projects/' + ID,
      repoSnapshot: { status: 'ready', workspaceDir: '/home/agent/.openclaude/repos/s1/1' },
      projectBound: true,
    })
    assert.equal(d.source, 'session_repo')
    assert.equal(d.sessionRepoOverlay, true)
    assert.equal(d.cwd, '/home/agent/.openclaude/repos/s1/1')
  })

  it('unready repo does not overlay', () => {
    const d = decideEngineCwd({
      agentBaseDir: '/tmp/project-ws',
      repoSnapshot: { status: 'cloning', workspaceDir: '/home/agent/.openclaude/repos/s1/1' },
      projectBound: true,
    })
    assert.equal(d.source, 'project_workspace')
    assert.equal(d.cwd, '/tmp/project-ws')
  })
})

describe('resolveChatRunWorkspace', () => {
  it('flag-off is unbound default', async () => {
    const r = await resolveChatRunWorkspace({
      sessionId: 'sess',
      env: { OC_PROJECT_CONTEXT: '0' },
    })
    assert.equal(r.bound, false)
    assert.equal(r.projectId, null)
    assert.equal(r.cwdSource, 'default')
  })

  it('bound isolated spec uses workspace/projects/<id>, never data projects/', async () => {
    const r = await resolveChatRunWorkspace({
      boardProjectId: ID,
      env: { OC_PROJECT_CONTEXT: '1', OPENCLAUDE_HOME: TEST_HOME },
      getBoardProject: () => ({ workspaceSpec: { kind: 'isolated' } }),
    })
    assert.equal(r.bound, true)
    assert.equal(r.projectId, ID)
    assert.equal(r.cwdSource, 'project_workspace')
    assert.ok(r.workspaceCwd)
    assert.match(r.workspaceCwd ?? '', /workspace[\\/]projects/)
    assert.equal(r.workspaceCwd?.includes(`${join('projects', ID)}`) && !r.workspaceCwd.includes('workspace'), false)
    const check = resolveProjectCwd({ kind: 'isolated' }, ID)
    assert.equal(check.ok, true)
  })
})
