import assert from 'node:assert/strict'

import {
  AutoDreamStructuredOutputCollector,
  validateProposal,
} from '../packages/gateway/src/autoDream.js'

const proposal = {
  upserts: [],
  deletes: [],
  summary: '没有新的稳定记忆',
}

const collector = new AutoDreamStructuredOutputCollector()
collector.accept({
  kind: 'block',
  block: {
    kind: 'tool_use',
    toolName: 'StructuredOutput',
    inputJson: {},
    partial: false,
  },
})
collector.accept({ kind: 'usage', usage: { totalTokens: 21 } })
collector.accept({
  kind: 'call_usage',
  call: {
    callId: 'auto-dream-deploy-gate',
    targetIds: ['structured-output'],
    usage: { totalTokens: 21 },
  },
})
collector.accept({
  kind: 'block',
  block: {
    kind: 'tool_result',
    toolName: 'StructuredOutput',
    isError: false,
  },
})
collector.accept({
  kind: 'final',
  meta: { stopReason: 'tool_use', structuredOutput: proposal },
})

const validated = validateProposal(collector.finish(), {
  rendered: [],
  versions: new Map(),
  metadata: new Map(),
})
assert.deepEqual(validated.upserts, [])
assert.deepEqual(validated.deletes, [])

console.log('✓ Auto-Dream usage/call_usage sidebands preserve structured output')
