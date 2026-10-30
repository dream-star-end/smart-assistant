/**
 * INC-20261029-SESSION-WS-BOUNDARY (#1238): an isolated_v1 session answered "delete test" by searching
 * workspace/ and offering a sibling conversation's file. The fix is a rule in the TOOLS slot; this proves
 * it reaches the prompt every engine actually receives (buildPromptContext), in both cache layouts.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

// storage paths read OPENCLAUDE_HOME at import time; keep the real HOME untouched.
process.env.OPENCLAUDE_HOME = mkdtempSync(join(tmpdir(), 'session-ws-boundary-home-'))
const { buildPromptContext } = await import('../promptSlots.js')

// Every provider passed to buildPromptContext by the engine adapters and the CCB/Codex runners.
const PROVIDERS = ['ccb', 'claude-subscription', 'codex-native', 'antigravity', 'grok', 'zcode', 'cursor']

describe('session workspace boundary in the assembled prompt (#1238)', () => {
  test('every engine prompt keeps file search and deletion inside the current conversation', async () => {
    for (const provider of PROVIDERS) {
      for (const cacheLayout of ['legacy', 'static-first'] as const) {
        const { content } = await buildPromptContext({ agentId: 'session-ws-boundary-test', provider, cacheLayout })
        const where = `${provider}/${cacheLayout}`
        assert.match(content, /## 会话工作区边界/, where)
        assert.match(content, /不属于当前对话的 `workspace\/sessions\/\*` 目录都是用户的\*\*其它对话\*\*/, where)
        assert.match(content, /不要搜索、列出、修改或删除其它对话目录里的文件/, where)
        assert.match(content, /\*\*不要\*\*把其它对话的文件当作删除\/修改候选/, where)
      }
    }
  })
})
