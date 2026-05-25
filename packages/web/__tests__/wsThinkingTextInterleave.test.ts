/**
 * codex-ui-unify wave — websocket.js thinking/text interleave fix.
 *
 * Codex emits reasoning (thinking_delta) and agentMessage (text_delta) in
 * arbitrary order across one turn. The handleStreamFrame loop has THREE
 * sites that clear `sess._streamingThinking = null`:
 *
 *   1. `if (block.kind === 'text')` — clear thinking to start a fresh text row
 *   2. `else if (block.kind === 'tool_use')` — both streams stop, tool card starts
 *   3. `else if (block.kind === 'tool_result')` — turn ends
 *
 * Sites 2 + 3 already drained pending RAF-throttled buffers before nulling
 * the ref; site 1 (text) did NOT, which silently dropped the last reasoning
 * fragment when codex interleaved reasoning→text. Codex review v2 also
 * flagged site 3 as missing a thinking flush (it only flushed assistant).
 *
 * This test is a **source contract test**: it parses websocket.js and
 * asserts that every `sess._streamingThinking = null` line is preceded
 * (within a small window) by a corresponding flush call. We deliberately
 * test the source structure rather than runtime behaviour because the
 * surrounding handler is a 200+ line block that depends on browser APIs
 * (DOM, IndexedDB, raf, etc.) we can't easily stub from node:test.
 *
 * Run: npx tsx --test packages/web/__tests__/wsThinkingTextInterleave.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const WS_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'websocket.js'),
  'utf-8',
)

describe('websocket.js — _streamingThinking flush-before-null invariant', () => {
  it('every `sess._streamingThinking = null` site in the streaming-block handler has a preceding flush', () => {
    const lines = WS_SRC.split('\n')
    // Indices (0-based) of every null-assignment line.
    const nullIdxs: number[] = []
    for (let i = 0; i < lines.length; i++) {
      if (/sess\._streamingThinking\s*=\s*null\b/.test(lines[i])) nullIdxs.push(i)
    }
    assert.ok(
      nullIdxs.length >= 3,
      `expected ≥3 _streamingThinking = null sites, got ${nullIdxs.length}`,
    )

    // For each null-site inside the streaming-block handler, look back up to
    // 20 lines for a flush call. We skip the turn-cleanup site at the END
    // of the handler (`turn/completed` / message_stop equivalent) which
    // resets state without needing a flush because the handler has already
    // closed the in-flight blocks via tool_use / tool_result / text events.
    //
    // Heuristic for "in-handler" vs "cleanup": the cleanup site is
    // surrounded by `for (const m of sess.messages)` / `clearTurnTiming` —
    // we identify by looking at the surrounding ~10 lines for those tokens.
    const flushRegex = /updateMessage\(\s*sess,\s*sess\._streamingThinking\s*,/
    for (const idx of nullIdxs) {
      const ctxBefore = lines.slice(Math.max(0, idx - 15), idx).join('\n')
      const ctxAround = lines
        .slice(Math.max(0, idx - 8), Math.min(lines.length, idx + 8))
        .join('\n')
      const isCleanup = /clearTurnTiming|for\s*\(const m of sess\.messages\)/.test(ctxAround)
      if (isCleanup) continue
      assert.match(
        ctxBefore,
        flushRegex,
        `_streamingThinking = null at line ${idx + 1} is not preceded by a flush within 15 lines.\n` +
          `Context:\n${ctxAround}`,
      )
    }
  })

  it('text branch flushes _streamingThinking before nulling (codex reasoning→text interleave fix)', () => {
    // Anchor: the `if (block.kind === 'text')` arm.
    const m = WS_SRC.match(
      /if\s*\(\s*block\.kind\s*===\s*['"]text['"]\s*\)\s*\{([\s\S]*?)sess\._streamingThinking\s*=\s*null/,
    )
    assert.ok(m, 'text branch + null assignment not found')
    const body = m![1]
    assert.match(
      body,
      /updateMessage\(\s*sess,\s*sess\._streamingThinking,\s*sess\._streamingThinking\.text/,
      'text branch must flush sess._streamingThinking before clearing it',
    )
  })

  it('tool_result branch flushes _streamingThinking before nulling (codex review v2 #2)', () => {
    // Anchor: `else if (block.kind === 'tool_result')` arm — capture from
    // its opening up to the `_streamingThinking = null`.
    const m = WS_SRC.match(
      /else\s+if\s*\(\s*block\.kind\s*===\s*['"]tool_result['"]\s*\)\s*\{([\s\S]*?)sess\._streamingThinking\s*=\s*null/,
    )
    assert.ok(m, 'tool_result branch + null assignment not found')
    const body = m![1]
    assert.match(
      body,
      /updateMessage\(\s*sess,\s*sess\._streamingThinking,\s*sess\._streamingThinking\.text/,
      'tool_result branch must flush sess._streamingThinking before clearing it',
    )
  })

  it('tool_use branch already had the flush (regression guard — do not delete the existing one)', () => {
    // The tool_use branch was the reference implementation that text +
    // tool_result are mirroring. Lock it down so a future refactor can't
    // accidentally remove it and quietly re-introduce the bug.
    const m = WS_SRC.match(
      /else\s+if\s*\(\s*block\.kind\s*===\s*['"]tool_use['"]\s*\)\s*\{([\s\S]*?)sess\._streamingThinking\s*=\s*null/,
    )
    assert.ok(m, 'tool_use branch + null assignment not found')
    const body = m![1]
    assert.match(
      body,
      /updateMessage\(\s*sess,\s*sess\._streamingThinking,\s*sess\._streamingThinking\.text/,
      'tool_use branch must keep flushing sess._streamingThinking before clearing it',
    )
  })
})
