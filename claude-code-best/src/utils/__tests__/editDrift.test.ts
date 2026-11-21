import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EDIT_DRIFT_REMIND_THRESHOLD,
  applyEditDriftToToolResultBlock,
  editDriftScopeId,
  editDriftTurnIdFromMessages,
  resetEditDriftStateForTests,
} from '../editDrift'

const FILE = '/workspace/plot_growth.py'
const OTHER = '/workspace/other.py'
const here = dirname(fileURLToPath(import.meta.url))

function edit(
  opts: {
    file?: string
    toolName?: string
    scopeId?: string
    turnId?: string
    normalizePath?: (filePath: string) => string
  } = {},
) {
  const file = opts.file ?? FILE
  const block = {
    type: 'tool_result' as const,
    content: `The file ${file} has been updated successfully.`,
  }
  const reminder = applyEditDriftToToolResultBlock(block, {
    toolName: opts.toolName ?? 'Edit',
    input: { file_path: file },
    scopeId: opts.scopeId ?? editDriftScopeId('session-a', undefined),
    turnId: opts.turnId ?? 'user-1',
    normalizePath: opts.normalizePath,
  })
  return { block, reminder }
}

beforeEach(() => {
  resetEditDriftStateForTests()
})

describe('edit drift reminder', () => {
  test('threshold constant is 10', () => {
    expect(EDIT_DRIFT_REMIND_THRESHOLD).toBe(10)
  })

  test('the 9th edit of a file does not remind', () => {
    let last = edit()
    for (let i = 0; i < 8; i++) last = edit()
    expect(last.reminder).toBeNull()
    expect(last.block.content).toBe(
      `The file ${FILE} has been updated successfully.`,
    )
  })

  test('the 10th edit reminds once and later edits stay quiet', () => {
    for (let i = 0; i < 9; i++) edit()
    const tenth = edit()
    expect(tenth.reminder).toContain('<system-reminder>')
    expect(tenth.reminder).toContain(
      `第 ${EDIT_DRIFT_REMIND_THRESHOLD} 次修改 ${FILE}`,
    )
    expect(tenth.reminder).toContain('用户最初的目标')
    expect(tenth.reminder).toContain('原地打转')
    expect(tenth.reminder).toContain('先交付当前版本')
    expect(tenth.reminder).toContain('还没解决的问题')
    expect(tenth.reminder).toContain('</system-reminder>')
    expect(String(tenth.block.content)).toContain(
      'has been updated successfully.',
    )
    expect(String(tenth.block.content)).toContain(tenth.reminder ?? '')

    for (let i = 0; i < 5; i++) {
      const later = edit()
      expect(later.reminder).toBeNull()
      expect(later.block.content).toBe(
        `The file ${FILE} has been updated successfully.`,
      )
    }
  })

  test('different files are counted separately', () => {
    for (let i = 0; i < 10; i++) edit({ file: FILE })
    for (let i = 0; i < 9; i++) {
      expect(edit({ file: OTHER }).reminder).toBeNull()
    }
    expect(edit({ file: OTHER }).reminder).toContain(OTHER)
    expect(edit({ file: FILE }).reminder).toBeNull()
  })

  test('a new user turn clears the count', () => {
    for (let i = 0; i < 10; i++) edit({ turnId: 'user-1' })
    expect(edit({ turnId: 'user-2' }).reminder).toBeNull()
    for (let i = 0; i < 8; i++) edit({ turnId: 'user-2' })
    expect(edit({ turnId: 'user-2' }).reminder).toContain('第 10 次')
  })

  test('subagents do not share counts with the main thread', () => {
    const main = editDriftScopeId('session-a', undefined)
    const sub = editDriftScopeId('session-a', 'agent-sub')
    expect(main).not.toBe(sub)
    for (let i = 0; i < 9; i++) {
      expect(edit({ scopeId: main }).reminder).toBeNull()
    }
    expect(edit({ scopeId: sub }).reminder).toBeNull()
    expect(edit({ scopeId: main }).reminder).toContain('第 10 次')
    for (let i = 0; i < 8; i++) {
      expect(edit({ scopeId: sub }).reminder).toBeNull()
    }
    expect(edit({ scopeId: sub }).reminder).toContain('第 10 次')
    expect(edit({ scopeId: main }).reminder).toBeNull()
  })

  test('Edit, Write, and MultiEdit share one file count', () => {
    const tools = [
      'Edit',
      'Write',
      'MultiEdit',
      'Edit',
      'Write',
      'MultiEdit',
      'Edit',
      'Write',
      'Edit',
    ]
    for (const toolName of tools) {
      expect(edit({ toolName }).reminder).toBeNull()
    }
    expect(edit({ toolName: 'Write' }).reminder).toContain('第 10 次')
  })

  test('Read and Bash do not count as edits', () => {
    for (let i = 0; i < 12; i++) {
      expect(edit({ toolName: 'Read' }).reminder).toBeNull()
      expect(edit({ toolName: 'Bash' }).reminder).toBeNull()
    }
    for (let i = 0; i < 9; i++) edit()
    expect(edit().reminder).toContain('第 10 次')
  })

  test('an edit with no file path does not count', () => {
    const block = { content: 'ok' }
    expect(
      applyEditDriftToToolResultBlock(block, {
        toolName: 'Edit',
        input: {},
        scopeId: editDriftScopeId('session-a', undefined),
        turnId: 'user-1',
      }),
    ).toBeNull()
    expect(block.content).toBe('ok')
    for (let i = 0; i < 9; i++) edit()
    expect(edit().reminder).toContain('第 10 次')
  })

  test('relative and absolute paths of the same file share a count', () => {
    const normalizePath = (filePath: string) =>
      filePath.startsWith('/')
        ? filePath
        : `/workspace/${filePath.replace(/^\.\//, '')}`
    for (let i = 0; i < 9; i++) {
      edit({
        file: i % 2 === 0 ? './plot_growth.py' : '/workspace/plot_growth.py',
        normalizePath,
      })
    }
    const tenth = edit({ file: './plot_growth.py', normalizePath })
    expect(tenth.reminder).toContain('/workspace/plot_growth.py')
    expect(tenth.reminder).toContain('第 10 次')
  })

  test('appends the reminder without dropping array text', () => {
    for (let i = 0; i < 9; i++) edit()
    const block = { content: [{ type: 'text', text: 'updated' }] }
    const reminder = applyEditDriftToToolResultBlock(block, {
      toolName: 'Edit',
      input: { file_path: FILE },
      scopeId: editDriftScopeId('session-a', undefined),
      turnId: 'user-1',
    })
    expect(reminder).toContain('第 10 次')
    expect(block.content[0]?.text).toContain('updated')
    expect(block.content[0]?.text).toContain('<system-reminder>')
  })

  test('turn id follows the latest real user message', () => {
    const first = {
      type: 'user',
      uuid: 'user-1',
      message: { content: 'fix the plot' },
    }
    const toolResult = {
      type: 'user',
      uuid: 'tool-result-1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }],
      },
    }
    const meta = {
      type: 'user',
      uuid: 'meta-1',
      isMeta: true,
      message: { content: 'injected' },
    }
    expect(
      editDriftTurnIdFromMessages([
        first,
        { type: 'assistant', uuid: 'a1' },
        toolResult,
        meta,
      ]),
    ).toBe('user-1')
    expect(
      editDriftTurnIdFromMessages([
        first,
        toolResult,
        {
          type: 'user',
          uuid: 'user-2',
          message: { content: 'try a different scale' },
        },
      ]),
    ).toBe('user-2')
  })

  test('successful tool execution is where the reminder is attached', () => {
    const src = readFileSync(
      join(here, '../../services/tools/toolExecution.ts'),
      'utf8',
    )
    expect(src).toContain('applyEditDriftToToolResultBlock')
    expect(src).toContain(
      'editDriftTurnIdFromMessages(toolUseContext.messages)',
    )
    expect(src).toContain('normalizePath: expandPath')
  })
})
