import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { isCurrentEvidenceTool } from '../memoryTurnObserver.js'

describe('memory freshness evidence classifier', () => {
  test('accepts authoritative live checks', () => {
    assert.equal(
      isCurrentEvidenceTool({
        toolName: 'Bash',
        inputPreview: JSON.stringify({ command: 'curl -fsS http://127.0.0.1:18790/healthz' }),
      }),
      true,
    )
    assert.equal(
      isCurrentEvidenceTool({
        toolName: 'Read',
        inputPreview: JSON.stringify({ file_path: '/opt/openclaude/MANIFEST.json' }),
      }),
      true,
    )
    assert.equal(isCurrentEvidenceTool({ toolName: 'WebSearch', inputPreview: '{}' }), true)
  })

  test('does not mistake memory lookup for current evidence', () => {
    assert.equal(
      isCurrentEvidenceTool({
        toolName: 'Bash',
        inputPreview: JSON.stringify({ command: 'oc-memory core-search "当前版本"' }),
      }),
      false,
    )
    assert.equal(
      isCurrentEvidenceTool({
        toolName: 'Read',
        inputPreview: JSON.stringify({
          file_path: '/home/agent/.openclaude/agents/main/memory/release.md',
        }),
      }),
      false,
    )
  })
})
