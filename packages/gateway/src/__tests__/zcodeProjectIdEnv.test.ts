/**
 * B6: ZCode platform MCP env carries OPENCLAUDE_PROJECT_ID.
 * Run: npx tsx --test packages/gateway/src/__tests__/zcodeProjectIdEnv.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

describe('ZCode OPENCLAUDE_PROJECT_ID overlay', () => {
  it('zcodeAdapter passes projectId into createZcodePlatformArtifacts', () => {
    const adapter = readFileSync(join(here, '../engine/zcodeAdapter.ts'), 'utf8')
    assert.match(adapter, /projectId: this\.opts\.projectId/)
    const platform = readFileSync(join(here, '../engine/zcodePlatform.ts'), 'utf8')
    assert.match(platform, /OPENCLAUDE_PROJECT_ID: input\.projectId/)
  })
})
