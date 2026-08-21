/**
 * Grok CLI → product tool-card mapping. No network, no spawn.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/grokToolNormalize.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  decodeGrokUtf8Bytes,
  grokProductToolInput,
  grokProductToolName,
  grokProductToolOutput,
} from '../engine/grokToolNormalize.js'

describe('grokProductToolName', () => {
  test('maps Grok Build builtins onto existing product cards', () => {
    assert.equal(grokProductToolName('run_terminal_command'), 'Bash')
    assert.equal(grokProductToolName('GrokBuild:read_file'), 'Read')
    assert.equal(grokProductToolName('search_replace', { path: 'a.ts', old_string: 'a', new_string: 'b' }), 'Edit')
    assert.equal(grokProductToolName('search_replace', { path: 'a.ts', old_string: '', new_string: 'hello' }), 'Write')
    assert.equal(grokProductToolName('grep'), 'Grep')
    assert.equal(grokProductToolName('list_dir'), 'Glob')
    assert.equal(grokProductToolName('web_search'), 'WebSearch')
    assert.equal(grokProductToolName('web_fetch'), 'WebFetch')
    assert.equal(grokProductToolName('todo_write'), 'TodoWrite')
    assert.equal(grokProductToolName('spawn_subagent'), 'Task')
    assert.equal(grokProductToolName('ask_user_question'), 'AskUserQuestion')
  })

  test('leaves MCP names and unknown tools alone', () => {
    assert.equal(grokProductToolName('mcp__openclaude-memory__skill_search'), 'mcp__openclaude-memory__skill_search')
    assert.equal(
      grokProductToolName('openclaude-memory__skill_search'),
      'mcp__openclaude-memory__skill_search',
    )
    assert.equal(grokProductToolName('mystery_tool'), 'mystery_tool')
    assert.equal(
      grokProductToolName('call_mcp_tool', { server: 'browser', tool_name: 'browser_navigate' }),
      'mcp__browser__browser_navigate',
    )
  })
})

describe('grokProductToolInput', () => {
  test('lifts Grok path/command aliases onto product field names', () => {
    assert.deepEqual(
      grokProductToolInput('run_terminal_command', { command: 'uname -a', description: 'os' }),
      { command: 'uname -a', description: 'os' },
    )
    assert.equal(
      (grokProductToolInput('read_file', { path: 'a.ts', offset: 1 }) as { file_path: string }).file_path,
      'a.ts',
    )
    assert.equal(
      (grokProductToolInput('search_replace', {
        path: 'a.ts',
        old_string: 'old',
        new_string: 'new',
      }) as { file_path: string; old_string: string }).file_path,
      'a.ts',
    )
    assert.equal(
      (grokProductToolInput('web_search', { search_term: 'rust' }) as { query: string }).query,
      'rust',
    )
  })
})

describe('grokProductToolOutput', () => {
  test('decodes Bash ToolOutput byte arrays into UTF-8 text', () => {
    const linux = Buffer.from('Linux 6.8.0\n')
    const raw = { type: 'Bash', output: [...linux] }
    assert.equal(grokProductToolOutput(raw), 'Linux 6.8.0\n')
    assert.equal(grokProductToolOutput(JSON.stringify(raw)), 'Linux 6.8.0\n')
  })

  test('joins stderr and non-zero exit without dumping the tagged JSON', () => {
    const raw = {
      type: 'Bash',
      output: [...Buffer.from('ok')],
      stderr: [...Buffer.from('warn')],
      exit_code: 1,
    }
    assert.match(grokProductToolOutput(raw), /ok/)
    assert.match(grokProductToolOutput(raw), /warn/)
    assert.match(grokProductToolOutput(raw), /exit 1/)
    assert.equal(grokProductToolOutput(raw).includes('"type"'), false)
  })

  test('prefers file content / prompt summaries over tagged JSON', () => {
    assert.equal(
      grokProductToolOutput({ type: 'FileContent', content: 'export const x = 1\n', absolute_path: '/a.ts' }),
      'export const x = 1\n',
    )
    assert.equal(
      grokProductToolOutput({ type: 'WebSearch', summary_for_prompt: 'three hits' }),
      'three hits',
    )
  })

  test('leaves ordinary objects that are not byte envelopes as JSON', () => {
    assert.equal(grokProductToolOutput({ lines: 42 }), '{"lines":42}')
  })
})

describe('decodeGrokUtf8Bytes', () => {
  test('rejects mixed arrays so grep match lists are not treated as bytes', () => {
    assert.equal(decodeGrokUtf8Bytes([{ path: 'a.ts' }]), null)
    assert.equal(decodeGrokUtf8Bytes([300]), null)
    assert.equal(decodeGrokUtf8Bytes([]), '')
  })
})
