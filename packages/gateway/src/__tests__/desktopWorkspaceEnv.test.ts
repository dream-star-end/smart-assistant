/**
 * Desktop Host OPENCLAUDE_ENGINE_CWD / OPENCLAUDE_ADD_DIRS overlay.
 * Unset → existing decideEngineCwd behavior.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { decideEngineCwd, resolveDesktopWorkspaceDir } from '../engineCwd.js'

describe('desktop workspace env overlay', () => {
  test('unset env returns empty and decideEngineCwd keeps agentBaseDir', () => {
    assert.equal(resolveDesktopWorkspaceDir({}, 'linux'), '')
    const decided = decideEngineCwd({ agentBaseDir: '/agents/main', projectBound: true })
    assert.equal(decided.cwd, '/agents/main')
    assert.equal(decided.source, 'project_workspace')
  })

  test('OPENCLAUDE_ENGINE_CWD wins when no ready session-repo', () => {
    const dir = resolveDesktopWorkspaceDir(
      { OPENCLAUDE_ENGINE_CWD: '/w/proj', OPENCLAUDE_ADD_DIRS: '/w/other' },
      'linux',
    )
    assert.equal(dir, '/w/proj')
    const decided = decideEngineCwd({
      agentBaseDir: '/agents/main',
      desktopWorkspaceDir: dir,
    })
    assert.equal(decided.cwd, '/w/proj')
    assert.equal(decided.source, 'project_workspace')
  })

  test('ready session-repo still overlays desktop cwd', () => {
    const decided = decideEngineCwd({
      agentBaseDir: '/agents/main',
      desktopWorkspaceDir: '/w/proj',
      repoSnapshot: { status: 'ready', workspaceDir: '/repos/cloned' },
    })
    assert.equal(decided.cwd, '/repos/cloned')
    assert.equal(decided.source, 'session_repo')
  })

  test('OPENCLAUDE_ADD_DIRS uses platform delimiter', () => {
    assert.equal(
      resolveDesktopWorkspaceDir({ OPENCLAUDE_ADD_DIRS: 'C:\\w\\a;C:\\w\\b' }, 'win32'),
      'C:\\w\\a',
    )
    assert.equal(
      resolveDesktopWorkspaceDir({ OPENCLAUDE_ADD_DIRS: '/a:/b' }, 'linux'),
      '/a',
    )
  })
})
