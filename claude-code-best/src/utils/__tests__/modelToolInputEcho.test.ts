import { describe, expect, test } from 'bun:test'
import { BashTool } from '@claude-code-best/builtin-tools/tools/BashTool/BashTool.js'
import { FileWriteTool } from '@claude-code-best/builtin-tools/tools/FileWriteTool/FileWriteTool.js'
import {
  createAssistantMessage,
  MODEL_TOOL_INPUT_KEY,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
} from '../messages'
import { getCwd } from '../cwd'
import type { AssistantMessage, Message } from '../../types/message'

// OCV5-509 (commercial u4, 2026-10-17): the model wrote
// `cd <session cwd> && oc-memory …`; the CLI ran it as `oc-memory …` and sent
// that back as history. The Box route compares the echoed call with the model's
// own and refused the continuation as BOX_TOOL_RESULT_MISMATCH.

const tools = [BashTool, FileWriteTool]

function ingest(name: string, input: Record<string, unknown>) {
  return normalizeContentFromAPI(
    [{ type: 'tool_use', id: 'toolu_509', name, input: JSON.stringify(input) }] as never,
    tools,
  )
}

function echoed(messages: Message[]) {
  const sent = normalizeMessagesForAPI(messages, tools)
  return (sent[0] as AssistantMessage).message!.content![0] as unknown as Record<string, unknown>
}

describe('OCV5-509 tool input echo', () => {
  test('a Bash call shortened to run in place is echoed to the API exactly as the model wrote it', () => {
    const model = { command: `cd ${getCwd()} && ls -la`, description: 'list' }
    const stored = ingest('Bash', model)[0] as unknown as Record<string, unknown>
    expect((stored.input as { command: string }).command).toBe('ls -la')
    const block = echoed([createAssistantMessage({ content: [stored] as never })])
    expect(block.input).toEqual(model)
    expect(MODEL_TOOL_INPUT_KEY in block).toBe(false)
  })

  test('an input the CLI leaves alone carries no copy and is echoed unchanged', () => {
    const model = { command: 'ls', description: 'list' }
    const stored = ingest('Bash', model)[0] as unknown as Record<string, unknown>
    expect(MODEL_TOOL_INPUT_KEY in stored).toBe(false)
    expect(echoed([createAssistantMessage({ content: [stored] as never })]).input).toEqual(model)
  })

  test('the model input survives a transcript round trip and never reaches the API', () => {
    const model = { file_path: '/tmp/a.ts', content: 'const a = 1  \n' }
    const stored = ingest('Write', model)[0] as unknown as Record<string, unknown>
    expect((stored.input as { content: string }).content).toBe('const a = 1\n')
    const message = JSON.parse(JSON.stringify(
      createAssistantMessage({ content: [stored] as never }),
    )) as Message
    const block = echoed([message])
    expect(block.input).toEqual(model)
    expect(MODEL_TOOL_INPUT_KEY in block).toBe(false)
  })
})
