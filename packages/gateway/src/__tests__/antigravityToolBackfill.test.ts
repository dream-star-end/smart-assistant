import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'
import { AntigravityAdapter } from '../engine/antigravityAdapter.js'
import type { EngineEvent } from '../engine/engineEvents.js'
import {
  AntigravityToolBackfiller,
  hasFileDiffBody,
  isBackfillableAntigravityFileTool,
} from '../engine/antigravityToolBackfill.js'

const CONV_ID = '78d3074f-9421-4f3b-ad4c-44ad1c995de0'

function setupBrain(): { root: string; transcriptPath: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'oc-agy-backfill-'))
  const logsDir = join(root, CONV_ID, '.system_generated', 'logs')
  mkdirSync(logsDir, { recursive: true })
  const transcriptPath = join(logsDir, 'transcript_full.jsonl')
  return {
    root,
    transcriptPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

describe('AntigravityToolBackfiller (OCV5-812)', () => {
  it('backfills edit_file and write_file body fields in FIFO order across repeated edits to the same file', () => {
    const { root, transcriptPath, cleanup } = setupBrain()
    try {
      const line1 = JSON.stringify({
        step_index: 12,
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          {
            name: 'edit_file',
            args: { Path: '/w/app.ts', Target: 'const a = 1', Replacement: 'const a = 2' },
          },
          {
            name: 'edit_file',
            args: { Path: '/w/app.ts', Target: 'const b = 1', Replacement: 'const b = 3' },
          },
          {
            name: 'write_file',
            args: { Path: '/w/new.ts', Content: 'export const ok = true\n', Overwrite: true },
          },
        ],
      })
      writeFileSync(transcriptPath, `${line1}\n`, 'utf8')

      const backfiller = new AntigravityToolBackfiller({ brainDir: root, conversationId: CONV_ID })

      const first = backfiller.tryBackfill({
        toolUseId: 't-13',
        nativeName: 'edit_file',
        productInput: { file_path: '/w/app.ts' },
        stepIndex: 13,
        minStepIndex: 10,
      })
      assert.deepEqual(first, {
        file_path: '/w/app.ts',
        old_string: 'const a = 1',
        new_string: 'const a = 2',
      })

      // Idempotent: retrying same toolUseId returns null and does not pop the next edit.
      assert.equal(
        backfiller.tryBackfill({
          toolUseId: 't-13',
          nativeName: 'edit_file',
          productInput: { file_path: '/w/app.ts' },
          stepIndex: 13,
          minStepIndex: 10,
        }),
        null,
      )

      const second = backfiller.tryBackfill({
        toolUseId: 't-14',
        nativeName: 'edit_file',
        productInput: { file_path: '/w/app.ts' },
        stepIndex: 14,
        minStepIndex: 10,
      })
      assert.deepEqual(second, {
        file_path: '/w/app.ts',
        old_string: 'const b = 1',
        new_string: 'const b = 3',
      })

      const writeRes = backfiller.tryBackfill({
        toolUseId: 't-15',
        nativeName: 'write_file',
        productInput: { file_path: '/w/new.ts' },
        stepIndex: 15,
        minStepIndex: 10,
      })
      assert.deepEqual(writeRes, {
        file_path: '/w/new.ts',
        content: 'export const ok = true\n',
      })

      backfiller.dispose()
    } finally {
      cleanup()
    }
  })

  it('Q1/Q3: isolates resumed turns by minStepIndex and handles delayed flush + split JSONL lines', () => {
    const { root, transcriptPath, cleanup } = setupBrain()
    try {
      // Historical edit from an earlier turn (step_index 4 < minStepIndex 20).
      const oldLine = JSON.stringify({
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'edit_file', args: { Path: '/w/same.ts', Target: 'OLD_TURN', Replacement: 'OLD_NEW' } },
        ],
      })
      writeFileSync(transcriptPath, `${oldLine}\n`, 'utf8')

      const backfiller = new AntigravityToolBackfiller({ brainDir: root, conversationId: CONV_ID })

      // At ACTIVE, current turn's planner line has not flushed yet -> must NOT borrow old turn's edit.
      assert.equal(
        backfiller.tryBackfill({
          toolUseId: 't-22',
          nativeName: 'edit_file',
          productInput: { file_path: '/w/same.ts' },
          stepIndex: 22,
          minStepIndex: 20,
        }),
        null,
      )

      // Partial line write (no trailing newline yet) must buffer safely without crashing or losing the record.
      const newLine = JSON.stringify({
        step_index: 21,
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'edit_file', args: { Path: '/w/same.ts', Target: 'cur1', Replacement: 'cur2' } },
        ],
      })
      const mid = Math.floor(newLine.length / 2)
      appendFileSync(transcriptPath, newLine.slice(0, mid), 'utf8')
      assert.equal(
        backfiller.tryBackfill({
          toolUseId: 't-22',
          nativeName: 'edit_file',
          productInput: { file_path: '/w/same.ts' },
          stepIndex: 22,
          minStepIndex: 20,
        }),
        null,
      )

      // Flush remainder + newline -> retry at DONE succeeds cleanly.
      appendFileSync(transcriptPath, `${newLine.slice(mid)}\n`, 'utf8')
      const matched = backfiller.tryBackfill({
        toolUseId: 't-22',
        nativeName: 'edit_file',
        productInput: { file_path: '/w/same.ts' },
        stepIndex: 22,
        minStepIndex: 20,
      })
      assert.deepEqual(matched, {
        file_path: '/w/same.ts',
        old_string: 'cur1',
        new_string: 'cur2',
      })
      backfiller.dispose()
    } finally {
      cleanup()
    }
  })

  it('Q2: enforces per-field and total size caps, skips inputs that already carry body, and rejects symlinks', () => {
    const { root, transcriptPath, cleanup } = setupBrain()
    try {
      const huge = 'x'.repeat(200)
      const line = JSON.stringify({
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'write_file', args: { Path: '/w/big.ts', Content: huge } },
          { name: 'edit_file', args: { Path: '/w/ok.ts', Target: 'a', Replacement: 'b' } },
        ],
      })
      writeFileSync(transcriptPath, `${line}\n`, 'utf8')

      const backfiller = new AntigravityToolBackfiller({
        brainDir: root,
        conversationId: CONV_ID,
        maxFieldChars: 100,
        maxTotalChars: 150,
      })

      // Oversized write skipped safely.
      assert.equal(
        backfiller.tryBackfill({
          toolUseId: 't-6',
          nativeName: 'write_file',
          productInput: { file_path: '/w/big.ts' },
          stepIndex: 6,
          minStepIndex: 0,
        }),
        null,
      )

      // Already-populated input is never overwritten.
      assert.equal(hasFileDiffBody('edit_file', { file_path: '/w/ok.ts', old_string: 'already', new_string: 'here' }), true)
      assert.equal(
        backfiller.tryBackfill({
          toolUseId: 't-7',
          nativeName: 'edit_file',
          productInput: { file_path: '/w/ok.ts', old_string: 'already', new_string: 'here' },
          stepIndex: 7,
          minStepIndex: 0,
        }),
        null,
      )

      // Symlinked transcript_full.jsonl is refused.
      const outside = join(root, 'outside.jsonl')
      writeFileSync(outside, `${line}\n`, 'utf8')
      const conv2 = '11111111-2222-3333-4444-555555555555'
      const logs2 = join(root, conv2, '.system_generated', 'logs')
      mkdirSync(logs2, { recursive: true })
      symlinkSync(outside, join(logs2, 'transcript_full.jsonl'))

      const symBackfiller = new AntigravityToolBackfiller({ brainDir: root, conversationId: conv2 })
      assert.equal(
        symBackfiller.tryBackfill({
          toolUseId: 't-8',
          nativeName: 'edit_file',
          productInput: { file_path: '/w/ok.ts' },
          stepIndex: 8,
          minStepIndex: 0,
        }),
        null,
      )

      assert.equal(isBackfillableAntigravityFileTool('edit_file'), true)
      assert.equal(isBackfillableAntigravityFileTool('run_command'), false)
      backfiller.dispose()
      symBackfiller.dispose()
    } finally {
      cleanup()
    }
  })

  it('B1: preserves strict 1-to-1 slot attribution across oversized, pre-populated, and late-flushed calls on same path', () => {
    const { root, transcriptPath, cleanup } = setupBrain()
    try {
      // Case 1: Same planner batch writes same path twice: #0 oversized (A), #1 valid (B).
      // Call #0 MUST stay null and NEVER steal B; Call #1 gets B.
      const batch1 = JSON.stringify({
        step_index: 10,
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'write_file', args: { Path: '/w/same.ts', Content: 'A'.repeat(200) } },
          { name: 'write_file', args: { Path: '/w/same.ts', Content: 'B_VALID' } },
        ],
      })
      writeFileSync(transcriptPath, `${batch1}\n`, 'utf8')

      const bf1 = new AntigravityToolBackfiller({
        brainDir: root,
        conversationId: CONV_ID,
        maxFieldChars: 100,
        maxTotalChars: 150,
      })
      assert.equal(
        bf1.tryBackfill({
          toolUseId: 'c-11',
          nativeName: 'write_file',
          productInput: { file_path: '/w/same.ts' },
          stepIndex: 11,
          minStepIndex: 0,
        }),
        null,
      )
      assert.deepEqual(
        bf1.tryBackfill({
          toolUseId: 'c-12',
          nativeName: 'write_file',
          productInput: { file_path: '/w/same.ts' },
          stepIndex: 12,
          minStepIndex: 0,
        }),
        { file_path: '/w/same.ts', content: 'B_VALID' },
      )
      bf1.dispose()

      // Case 2: Call #0 already carries body in parameters; Call #1 is trimmed.
      // Call #1 MUST get slot #1 (SECOND), NEVER slot #0 (FIRST).
      const batch2 = JSON.stringify({
        step_index: 20,
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'edit_file', args: { Path: '/w/p.ts', Target: 'FIRST_OLD', Replacement: 'FIRST_NEW' } },
          { name: 'edit_file', args: { Path: '/w/p.ts', Target: 'SECOND_OLD', Replacement: 'SECOND_NEW' } },
        ],
      })
      writeFileSync(transcriptPath, `${batch2}\n`, 'utf8')
      const bf2 = new AntigravityToolBackfiller({ brainDir: root, conversationId: CONV_ID })
      assert.equal(
        bf2.tryBackfill({
          toolUseId: 'c-21',
          nativeName: 'edit_file',
          productInput: { file_path: '/w/p.ts', old_string: 'FIRST_OLD', new_string: 'FIRST_NEW' },
          stepIndex: 21,
          minStepIndex: 20,
        }),
        null,
      )
      assert.deepEqual(
        bf2.tryBackfill({
          toolUseId: 'c-22',
          nativeName: 'edit_file',
          productInput: { file_path: '/w/p.ts' },
          stepIndex: 22,
          minStepIndex: 20,
        }),
        { file_path: '/w/p.ts', old_string: 'SECOND_OLD', new_string: 'SECOND_NEW' },
      )
      bf2.dispose()

      // Case 3: Call #0 finishes before transcript flushes (stays null); then both planner lines flush;
      // Call #1 MUST get slot #1 (B), NEVER late-arriving slot #0 (A).
      writeFileSync(transcriptPath, '', 'utf8')
      const bf3 = new AntigravityToolBackfiller({ brainDir: root, conversationId: CONV_ID })
      assert.equal(
        bf3.tryBackfill({
          toolUseId: 'c-31',
          nativeName: 'edit_file',
          productInput: { file_path: '/w/late.ts' },
          stepIndex: 31,
          minStepIndex: 30,
        }),
        null,
      )
      appendFileSync(
        transcriptPath,
        `${JSON.stringify({
          step_index: 30,
          type: 'PLANNER_RESPONSE',
          tool_calls: [{ name: 'edit_file', args: { Path: '/w/late.ts', Target: 'A1', Replacement: 'A2' } }],
        })}\n${JSON.stringify({
          step_index: 32,
          type: 'PLANNER_RESPONSE',
          tool_calls: [{ name: 'edit_file', args: { Path: '/w/late.ts', Target: 'B1', Replacement: 'B2' } }],
        })}\n`,
        'utf8',
      )
      assert.deepEqual(
        bf3.tryBackfill({
          toolUseId: 'c-33',
          nativeName: 'edit_file',
          productInput: { file_path: '/w/late.ts' },
          stepIndex: 33,
          minStepIndex: 30,
        }),
        { file_path: '/w/late.ts', old_string: 'B1', new_string: 'B2' },
      )
      bf3.dispose()

      // Case 4 (inode rotation mid-turn): once slots exist, file replacement fails closed (returns null, never misattributes A to B).
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          step_index: 40,
          type: 'PLANNER_RESPONSE',
          tool_calls: [{ name: 'write_file', args: { Path: '/w/rot.ts', Content: 'A_OLD' } }],
        })}\n`,
        'utf8',
      )
      const bf4 = new AntigravityToolBackfiller({ brainDir: root, conversationId: CONV_ID })
      assert.deepEqual(
        bf4.tryBackfill({
          toolUseId: 'c-41',
          nativeName: 'write_file',
          productInput: { file_path: '/w/rot.ts' },
          stepIndex: 41,
          minStepIndex: 40,
        }),
        { file_path: '/w/rot.ts', content: 'A_OLD' },
      )
      // Atomically replace file with a strictly distinct inode containing both A and B.
      const replacementPath = `${transcriptPath}.rotated`
      writeFileSync(
        replacementPath,
        `${JSON.stringify({
          step_index: 40,
          type: 'PLANNER_RESPONSE',
          tool_calls: [{ name: 'write_file', args: { Path: '/w/rot.ts', Content: 'A_OLD' } }],
        })}\n${JSON.stringify({
          step_index: 42,
          type: 'PLANNER_RESPONSE',
          tool_calls: [{ name: 'write_file', args: { Path: '/w/rot.ts', Content: 'B_NEW' } }],
        })}\n`,
        'utf8',
      )
      renameSync(replacementPath, transcriptPath)
      assert.equal(
        bf4.tryBackfill({
          toolUseId: 'c-43',
          nativeName: 'write_file',
          productInput: { file_path: '/w/rot.ts' },
          stepIndex: 43,
          minStepIndex: 40,
        }),
        null,
      )
      bf4.dispose()
    } finally {
      cleanup()
    }
  })

  it('B2: resumed turn with >8 MiB prior history backfills a single new write on the very first attempt', () => {
    const { root, transcriptPath, cleanup } = setupBrain()
    try {
      // Seed >9 MiB of historical turns before the resumed launch.
      const padLine = `${JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'x'.repeat(64 * 1024) })}\n`
      const repeats = Math.ceil((9 * 1024 * 1024) / padLine.length)
      writeFileSync(transcriptPath, padLine.repeat(repeats), 'utf8')

      const backfiller = new AntigravityToolBackfiller({ brainDir: root, conversationId: CONV_ID })
      backfiller.captureStartOffset()

      // Resumed turn appends a single tiny 1-char write after >9 MiB of history.
      appendFileSync(
        transcriptPath,
        `${JSON.stringify({
          step_index: 500,
          type: 'PLANNER_RESPONSE',
          tool_calls: [{ name: 'write_file', args: { Path: '/w/tiny.ts', Content: 'z' } }],
        })}\n`,
        'utf8',
      )

      const filled = backfiller.tryBackfill({
        toolUseId: 't-501',
        nativeName: 'write_file',
        productInput: { file_path: '/w/tiny.ts' },
        stepIndex: 501,
        minStepIndex: 499,
      })
      assert.deepEqual(filled, { file_path: '/w/tiny.ts', content: 'z' })
      backfiller.dispose()
    } finally {
      cleanup()
    }
  })

  it('E2E AntigravityAdapter: backfills trimmed edit_file diff on delayed flush and preserves single tool_use_detected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-agy-e2e-backfill-'))
    const prevHome = process.env.OPENCLAUDE_HOME
    const prevBin = process.env.OC_ANTIGRAVITY_CLI_BIN
    try {
      const cliBin = join(dir, 'fake-agy.cjs')
      // Simulate Antigravity CLI emitting trimmed edit_file ACTIVE first, flushing transcript_full.jsonl
      // before DONE, then emitting DONE + final answer.
      writeFileSync(
        cliBin,
        `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const convId = '${CONV_ID}'
let buf = ''
let ran = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  if (!ran && buf.includes('\\n')) {
    ran = true
    const writeLine = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
    writeLine({ event: 'init', conversation_id: convId })
    writeLine({ event: 'step_update', step_update: { conversation_id: convId, step_index: 1, step_type: 'user_input', state: 'DONE' } })
    writeLine({
      event: 'step_update',
      step_update: {
        conversation_id: convId,
        step_index: 3,
        step_type: 'tool',
        state: 'ACTIVE',
        tool_info: { name: 'edit_file', parameters: { Path: '/w/demo.ts' } },
      },
    })
    setTimeout(() => {
      const logsDir = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'brain', convId, '.system_generated', 'logs')
      fs.mkdirSync(logsDir, { recursive: true })
      fs.writeFileSync(
        path.join(logsDir, 'transcript_full.jsonl'),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          tool_calls: [{ name: 'edit_file', args: { Path: '/w/demo.ts', Target: 'oldLine()', Replacement: 'newLine()' } }],
        }) + '\\n',
      )
      writeLine({
        event: 'step_update',
        step_update: {
          conversation_id: convId,
          step_index: 3,
          step_type: 'tool',
          state: 'DONE',
          tool_info: { name: 'edit_file', parameters: { Path: '/w/demo.ts' }, output: 'Made 1 replacement in /w/demo.ts starting at line 1 (+1/-1 lines).' },
        },
      })
      writeLine({ event: 'step_update', step_update: { conversation_id: convId, step_index: 4, step_type: 'agent_response', state: 'DONE', text_delta: 'done' } })
      writeLine({ event: 'result', result: { conversation_id: convId, status: 'SUCCESS', response: 'done', num_turns: 1 } })
    }, 30)
  }
})
`,
        'utf8',
      )
      chmodSync(cliBin, 0o755)
      process.env.OPENCLAUDE_HOME = join(dir, 'oc-home')
      process.env.OC_ANTIGRAVITY_CLI_BIN = cliBin
      mkdirSync(join(dir, 'oc-home'), { recursive: true })

      const adapter = new AntigravityAdapter({
        sessionKey: 'agent:main:webchat:dm:backfill-e2e',
        agentId: 'main',
        agentBaseDir: dir,
        model: 'antigravity-gemini-4-neon',
        config: { gateway: { port: 18789, accessToken: '' }, auth: {} } as unknown as OpenClaudeConfig,
      })
      const token = 'b'.repeat(64)
      adapter.setAntigravityRoute({
        baseUrl: `http://127.0.0.1:18789/internal/v5/antigravity-relay/route/${token}`,
        routeToken: token,
        accessToken: 'ya29.test',
        accessTokenExpiresAt: '2026-12-01T00:00:00Z',
      })

      const events: EngineEvent[] = []
      const run = adapter.submitTurn({
        input: 'edit demo.ts',
        onEvent: (e) => events.push(e),
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      await adapter.waitForOutputDrain()

      assert.equal(summary?.isError, false, summary?.errorDetail)
      assert.equal(events.filter((e) => e.kind === 'tool_use_detected').length, 1)

      const toolUseBlocks = events.filter(
        (e): e is Extract<EngineEvent, { kind: 'block' }> =>
          e.kind === 'block' && e.block.kind === 'tool_use',
      )
      assert.equal(toolUseBlocks.length, 2, 'must emit initial tool_use plus one backfilled update before tool_result')
      const lastToolUse = toolUseBlocks.at(-1)!.block
      assert.equal(lastToolUse.kind, 'tool_use')
      assert.deepEqual(lastToolUse.inputJson, {
        file_path: '/w/demo.ts',
        old_string: 'oldLine()',
        new_string: 'newLine()',
      })

      assert.equal(summary?.tools.length, 1)
      assert.deepEqual(summary?.tools[0]?.inputJson, {
        file_path: '/w/demo.ts',
        old_string: 'oldLine()',
        new_string: 'newLine()',
      })
    } finally {
      if (prevHome === undefined) delete process.env.OPENCLAUDE_HOME
      else process.env.OPENCLAUDE_HOME = prevHome
      if (prevBin === undefined) delete process.env.OC_ANTIGRAVITY_CLI_BIN
      else process.env.OC_ANTIGRAVITY_CLI_BIN = prevBin
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
