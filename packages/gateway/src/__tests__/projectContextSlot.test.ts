/**
 * Bound project context injects instructions/assets; flag-off keeps legacy.
 * Run: npx tsx --test packages/gateway/src/__tests__/projectContextSlot.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'oc-projctx-slot-'))
process.env.OPENCLAUDE_HOME = TEST_HOME
process.env.OC_PROJECT_CONTEXT = '1'
delete process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR
delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL
delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN

const { buildProjectSlot, buildProjectMemorySlot, buildSkillsSlot } = await import('../promptSlots.js')

describe('projectContext injection', () => {
  it('uses resolved context assets/instructions without sessionId', async () => {
    const slot = await buildProjectSlot({
      agentId: 'stage-implement',
      projectContext: {
        boardProjectId: '11111111-1111-4111-8111-111111111111',
        chatProjectId: 'chat-1',
        name: 'TEST',
        instructions: 'board instructions',
        assets: [
          {
            id: 'a1',
            projectId: 'chat-1',
            source: 'upload',
            sessionId: null,
            name: 'spec.md',
            url: '/api/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md',
            containerPath: '/home/agent/.openclaude/uploads/spec.md',
            mime: 'text/markdown',
            sizeBytes: 3,
            digest: 'aa',
            excerpt: 'hello',
            pinned: true,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        assetsRevision: 2,
        bound: true,
      },
    })
    assert.ok(slot)
    assert.match(slot.content, /board instructions/)
    assert.match(slot.content, /spec\.md/)
    assert.match(slot.content, /hello/)
  })

  it('flag-off equivalent: no projectContext and no session → no PROJECT slot', async () => {
    const slot = await buildProjectSlot({ agentId: 'main' })
    assert.equal(slot, null)
  })

  it('SKILLS builder accepts projectId without throwing', async () => {
    const slot = await buildSkillsSlot({
      agentId: 'stage-implement',
      projectId: '11111111-1111-4111-8111-111111111111',
    })
    // overlay dir may be empty
    if (slot) assert.equal(slot.name, 'SKILLS')
  })

  it('unbound session does not get PROJECT_MEMORY', async () => {
    const slot = await buildProjectMemorySlot({
      agentId: 'main',
      projectContext: {
        boardProjectId: null,
        chatProjectId: 'chat-1',
        name: 'unbound',
        instructions: 'x',
        assets: [],
        assetsRevision: 0,
        bound: false,
      },
    })
    assert.equal(slot, null)
  })
})
