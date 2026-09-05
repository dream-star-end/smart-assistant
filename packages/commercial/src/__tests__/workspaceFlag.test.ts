import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  isResearchWorkspaceEnabled,
  libraryListProjectIdFromUrl,
} from '../research/workspaceFlag.js'

describe('OC_RESEARCH_WORKSPACE flag', () => {
  it('only 1/true/yes/on enable', () => {
    assert.equal(isResearchWorkspaceEnabled({}), false)
    assert.equal(isResearchWorkspaceEnabled({ OC_RESEARCH_WORKSPACE: '' }), false)
    assert.equal(isResearchWorkspaceEnabled({ OC_RESEARCH_WORKSPACE: '0' }), false)
    assert.equal(isResearchWorkspaceEnabled({ OC_RESEARCH_WORKSPACE: '1' }), true)
    assert.equal(isResearchWorkspaceEnabled({ OC_RESEARCH_WORKSPACE: 'true' }), true)
    assert.equal(isResearchWorkspaceEnabled({ OC_RESEARCH_WORKSPACE: 'YES' }), true)
    assert.equal(isResearchWorkspaceEnabled({ OC_RESEARCH_WORKSPACE: 'on' }), true)
  })

  it('library GET ?projectId= flag 关忽略', () => {
    assert.equal(libraryListProjectIdFromUrl('/api/me/research/library?projectId=p1', false), undefined)
    assert.equal(libraryListProjectIdFromUrl('/api/me/research/library?projectId=p1', true), 'p1')
    assert.equal(libraryListProjectIdFromUrl('/api/me/research/library?projectId=', true), undefined)
  })
})
