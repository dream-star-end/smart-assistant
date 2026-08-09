import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { projectSessionTape } from '../public/modules/sessionTape.js'

const syncSource = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'sync.js'),
  'utf8',
)

function extractFunction(name: string): string {
  const lines = syncSource.split('\n')
  const start = lines.findIndex((line) =>
    new RegExp(`^(?:export\\s+)?function\\s+${name}\\s*\\(`).test(line),
  )
  assert.notEqual(start, -1)
  let end = start + 1
  for (; end < lines.length; end++) if (/^}\s*$/.test(lines[end])) break
  return lines
    .slice(start, end + 1)
    .join('\n')
    .replace(/^export\s+/, '')
}

test('session tape projection restores user, streamed text, tool lifecycle and final metadata', () => {
  const rows = [
    {
      tapeSeq: 1,
      turnKey: 'turn-1',
      direction: 'inbound',
      ts: 100,
      frame: {
        type: 'inbound.message',
        clientMessage: { id: 'user-1', role: 'user', text: 'hello', ts: 100, status: 'sent' },
      },
    },
    {
      tapeSeq: 2,
      turnKey: 'turn-1',
      direction: 'outbound',
      ts: 110,
      frame: {
        type: 'outbound.message',
        turnId: 'srv-turn-1',
        blocks: [{ kind: 'text', blockId: 'answer', text: 'hello ' }],
        isFinal: false,
      },
    },
    {
      tapeSeq: 3,
      turnKey: 'turn-1',
      direction: 'outbound',
      ts: 120,
      frame: {
        type: 'outbound.message',
        turnId: 'srv-turn-1',
        blocks: [{ kind: 'text', blockId: 'answer', text: 'world' }],
        isFinal: false,
      },
    },
    {
      tapeSeq: 4,
      turnKey: 'turn-1',
      direction: 'outbound',
      ts: 130,
      frame: {
        type: 'outbound.message',
        turnId: 'srv-turn-1',
        blocks: [
          {
            kind: 'tool_use',
            blockId: 'tool-1',
            toolName: 'Bash',
            inputPreview: 'pwd',
            inputJson: { command: 'pwd' },
          },
        ],
        isFinal: false,
      },
    },
    {
      tapeSeq: 5,
      turnKey: 'turn-1',
      direction: 'outbound',
      ts: 140,
      frame: {
        type: 'outbound.message',
        turnId: 'srv-turn-1',
        blocks: [
          {
            kind: 'tool_result',
            blockId: 'tool-1:result',
            toolUseBlockId: 'tool-1',
            toolName: 'Bash',
            preview: '/tmp…',
            output: '/tmp\ncomplete output',
            outputJson: { stdout: '/tmp\ncomplete output' },
            isError: false,
          },
        ],
        isFinal: false,
      },
    },
    {
      tapeSeq: 6,
      turnKey: 'turn-1',
      direction: 'outbound',
      ts: 150,
      frame: {
        type: 'outbound.message',
        turnId: 'srv-turn-1',
        blocks: [],
        isFinal: true,
        meta: {
          inputTokens: 12,
          outputTokens: 8,
          cost: 0,
          usageStatus: 'observed',
          costStatus: 'unavailable',
        },
      },
    },
  ]

  const messages = projectSessionTape(rows)
  assert.equal(messages[0].id, 'user-1')
  assert.equal(messages[0].status, 'replied')
  const answer = messages.find((message) => message.role === 'assistant')
  assert.equal(answer?.text, 'hello world')
  assert.match(answer?.metaText || '', /订阅计费不可用/)
  assert.match(answer?.metaText || '', /in 12/)
  const tool = messages.find((message) => message.role === 'tool')
  assert.equal(tool?._completed, true)
  assert.equal(tool?.output, '/tmp\ncomplete output')
  assert.deepEqual(tool?.outputJson, { stdout: '/tmp\ncomplete output' })
})

test('session tape projection preserves a large exact tool input byte-for-byte', () => {
  const content = '无损内容'.repeat(3000)
  const projected = projectSessionTape([
    {
      tapeSeq: 1,
      turnKey: 'turn-large-input',
      direction: 'outbound',
      ts: 100,
      frame: {
        type: 'outbound.message',
        turnId: 'turn-large-input',
        blocks: [
          {
            kind: 'tool_use',
            blockId: 'large-write',
            toolName: 'Write',
            inputPreview: '{"file":"large.txt"',
            inputJson: { file: 'large.txt', content },
          },
        ],
        isFinal: false,
      },
    },
  ] as any)
  const tool = projected.find((message) => message.role === 'tool') as any
  assert.equal(tool.inputJson.content, content)
  assert.equal(Buffer.byteLength(tool.inputJson.content), Buffer.byteLength(content))
})

test('session tape projection is deterministic for unsorted pages and nested agent blocks', () => {
  const rows = [
    {
      tapeSeq: 3,
      turnKey: 'turn-a',
      direction: 'outbound',
      ts: 30,
      frame: {
        type: 'outbound.message',
        blocks: [
          { kind: 'text', parentToolUseId: 'agent-1', text: 'child answer' },
          {
            kind: 'tool_result',
            toolUseBlockId: 'agent-1',
            toolName: 'Agent',
            preview: 'done',
            isError: false,
          },
        ],
      },
    },
    {
      tapeSeq: 1,
      turnKey: 'turn-a',
      direction: 'inbound',
      ts: 10,
      frame: {
        type: 'inbound.message',
        clientMessage: { id: 'u-a', role: 'user', text: 'delegate', ts: 10 },
      },
    },
    {
      tapeSeq: 2,
      turnKey: 'turn-a',
      direction: 'outbound',
      ts: 20,
      frame: {
        type: 'outbound.message',
        blocks: [
          {
            kind: 'tool_use',
            blockId: 'agent-1',
            toolName: 'Agent',
            inputJson: { description: 'audit' },
          },
        ],
      },
    },
  ]

  const first = projectSessionTape(rows)
  const second = projectSessionTape([...rows].reverse())
  assert.deepEqual(second, first)
  const group = first.find((message) => message.role === 'agent-group')
  assert.equal(group?.text, 'audit')
  assert.equal(group?.childBlocks?.[0]?.text, 'child answer')
  assert.equal(group?._completed, true)
})

test('session tape projection restores permission settlement and workflow progress cards', () => {
  const messages = projectSessionTape([
    {
      tapeSeq: 1,
      turnKey: 'turn-sidecars',
      direction: 'outbound',
      ts: 10,
      frame: {
        type: 'outbound.permission_request',
        requestId: 'permission-1',
        toolName: 'Bash',
        inputPreview: 'echo ok',
      },
    },
    {
      tapeSeq: 2,
      turnKey: 'turn-sidecars',
      direction: 'outbound',
      ts: 20,
      frame: {
        type: 'outbound.permission_settled',
        requestId: 'permission-1',
        behavior: 'allow',
        reason: 'remote',
      },
    },
    {
      tapeSeq: 3,
      turnKey: 'turn-sidecars',
      direction: 'outbound',
      ts: 30,
      frame: {
        type: 'outbound.workflow_progress',
        taskId: 'workflow-1',
        stage: 'started',
        workflowName: 'Research',
        items: [{ type: 'workflow_phase', index: 0, title: 'Search' }],
      },
    },
    {
      tapeSeq: 4,
      turnKey: 'turn-sidecars',
      direction: 'outbound',
      ts: 40,
      frame: {
        type: 'outbound.workflow_progress',
        taskId: 'workflow-1',
        stage: 'updated',
        status: 'completed',
      },
    },
  ])
  const permission = messages.find((message) => message.role === 'permission')
  assert.equal(permission?._resolved, true)
  assert.equal(permission?._behavior, 'allow')
  const workflow = messages.find((message) => message.role === 'workflow-group')
  assert.equal(workflow?._wfStatus, 'completed')
  assert.equal(workflow?._wfPhases?.[0]?.title, 'Search')
})

test('taped IndexedDB snapshots always rehydrate cursors after reload', () => {
  const build = new Function(
    `${extractFunction('_copyLocalSessionRuntimeState')}\n${extractFunction('_serverTapeLastSeq')}\n${extractFunction('_buildSessionFromRemote')}\nreturn _buildSessionFromRemote`,
  )() as (remote: any, local: any, opts: { placeholder: boolean }) => any
  const remote = {
    id: 'session-reload',
    title: 'Tape',
    updatedAt: 10,
    messageCount: 2,
    tapeTurnCount: 1,
  }
  const local: any = {
    id: 'session-reload',
    messages: Array.from({ length: 8 }, (_, i) => ({ id: `m-${i}` })),
    _syncedAt: 10,
  }
  assert.equal(build(remote, local, { placeholder: true })._needsFetch, true)
  local._tapeFrames = [{ tapeSeq: 1 }]
  assert.notEqual(build(remote, local, { placeholder: true })._needsFetch, true)
})
