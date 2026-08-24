import * as assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'oc-preview-'))
process.env.OPENCLAUDE_HOME = home
process.env.OC_PROJECT_CONTEXT = '1'
delete process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR

const { previewProjectContext } = await import('../projectContextPreview.js')
const { writeProjectInstructions } = await import('@openclaude/storage')

const ID = '12345678-1234-4234-8234-123456789012'

describe('project context preview', () => {
  it('redacts USER/SOUL and never returns a full prompt', async () => {
    await writeProjectInstructions(ID, 'board instructions for preview', 0)
    const out = await previewProjectContext({ boardProjectId: ID, agentId: 'preview-agent' })
    if (!('slots' in out)) {
      assert.fail('expected enabled preview')
    }
    assert.equal(out.enabled, true)
    assert.match(out.disclaimer, /仅审计/)
    const user = out.slots.find((s) => s.name === 'USER')
    if (user) {
      assert.equal(user.redacted, true)
      assert.equal(user.preview, null)
    }
    const joined = JSON.stringify(out)
    assert.doesNotMatch(joined, /oc-user-always/)
    assert.equal('content' in out, false)
  })
})
