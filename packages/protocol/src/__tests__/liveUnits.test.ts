/**
 * In-flight tail-unit hydrate: design §9.1 + frozen blockers B1/B2/B3.
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  LIVE_UNITS_CHECKPOINT_MAX_BYTES,
  LIVE_UNITS_FIRST_PACK_MAX_BYTES,
  assembleLiveUnitsFromState,
  assembleLiveUnitsPage,
  choosePayloadRefSource,
  continueReduceLiveFrames,
  fallbackLiveUnitsPage,
  foldLiveUnitStateForCheckpoint,
  isLiveUnitsEnabled,
  parseLiveUnitCheckpoint,
  reduceLiveFrames,
  serveLiveUnits,
  type LiveFrameInput,
  type LiveUnit,
} from '../liveUnits.js'

const META = {
  streamClientMessageIds: ['cm-1'],
  openDispatch: true,
  hasTapeProjection: false,
  tapeProjectionVersion: 0,
}

function frame(
  recordId: string,
  frameSeq: number,
  block: Record<string, unknown>,
  extra: Partial<LiveFrameInput> = {},
): LiveFrameInput {
  return {
    recordId,
    streamKey: 'dispatch:00000000-0000-4000-8000-000000000001:1',
    clientMessageId: 'cm-1',
    payload: {
      type: 'outbound.message',
      sessionKey: 'agent:main:webchat:dm:sess',
      frameSeq,
      blocks: [block],
    },
    ...extra,
  }
}

function kb(n: number, ch = 'x'): string {
  return ch.repeat(n * 1024)
}

describe('isLiveUnitsEnabled', () => {
  it('defaults on and treats 0/false as off', () => {
    assert.equal(isLiveUnitsEnabled({} as NodeJS.ProcessEnv), true)
    assert.equal(isLiveUnitsEnabled({ OC_LIVE_FRAMES_UNITS: '0' } as NodeJS.ProcessEnv), false)
    assert.equal(isLiveUnitsEnabled({ OC_LIVE_FRAMES_UNITS: 'false' } as NodeJS.ProcessEnv), false)
    assert.equal(isLiveUnitsEnabled({ OC_LIVE_FRAMES_UNITS: '1' } as NodeJS.ProcessEnv), true)
  })
})

describe('§9.1 thinking interrupted by tool', () => {
  it('splits concatenated thinking around a tool card', () => {
    const frames = [
      frame('1', 1, { kind: 'thinking', text: 'aaa' }),
      frame('2', 2, { kind: 'thinking', text: 'bbb' }),
      frame('3', 3, { kind: 'tool_use', blockId: 't1', toolName: 'Bash', inputPreview: 'ls' }),
      frame('4', 4, { kind: 'thinking', text: 'ccc' }),
    ]
    const reduced = reduceLiveFrames(frames)
    assert.equal(reduced.ok, true)
    if (!reduced.ok) return
    const kinds = reduced.state.units.map((u) => u.kind)
    assert.deepEqual(kinds, ['thinking', 'tool', 'thinking'])
    assert.equal(reduced.state.units[0]?.text, 'aaabbb')
    assert.equal(reduced.state.units[2]?.text, 'ccc')
    assert.notEqual(reduced.state.units[0]?.text, 'bbb')
  })
})

describe('§9.1 delegate start + huge tool + done is not last-wins', () => {
  it('keeps the 746KB tool_result child after phase=done', () => {
    const huge = kb(746)
    const frames = [
      frame('1', 10, {
        kind: 'delegate_progress',
        runId: 'dlg-1',
        agentId: 'general-assistant',
        phase: 'start',
        goal: 'investigate',
        text: 'starting',
      }),
      frame('2', 20, {
        kind: 'delegate_progress',
        runId: 'dlg-1',
        phase: 'tool',
        block: {
          kind: 'tool_result',
          blockId: 'tu-1:result',
          toolUseBlockId: 'tu-1',
          toolName: 'Read',
          output: huge,
        },
      }),
      frame('3', 30, {
        kind: 'delegate_progress',
        runId: 'dlg-1',
        phase: 'done',
        text: 'all done summary',
      }),
    ]
    const reduced = reduceLiveFrames(frames)
    assert.equal(reduced.ok, true)
    if (!reduced.ok) return
    assert.equal(reduced.state.units.length, 1)
    const group = reduced.state.units[0]!
    assert.equal(group.kind, 'agent_group')
    assert.equal(group.completed, true)
    assert.equal(group.open, false)
    assert.equal(group.text, 'all done summary')
    const child = group.children?.find((c) => c.blockId === 'tu-1' || c.toolUseBlockId === 'tu-1')
    assert.ok(child, 'tool_result child must survive done')
    assert.equal(child?.output, huge)
    const served = serveLiveUnits(reduced.state, META, { n: 20, k: 20, previewMax: 64 * 1024 })
    const servedChild = served.units[0]?.children?.[0]
    assert.ok(servedChild)
    assert.notEqual(servedChild?.output, huge)
    assert.ok(typeof servedChild?.preview === 'string' && servedChild.preview.length > 0)
    assert.ok(servedChild?.payloadRef)
  })
})

describe('§9.1 leftover never in units / empty without open dispatch', () => {
  it('empty page helper has no resume', () => {
    const page = fallbackLiveUnitsPage({
      streamClientMessageIds: [],
      openDispatch: false,
      hasTapeProjection: true,
      tapeProjectionVersion: 1,
    })
    assert.equal(page.units.length, 0)
    assert.equal(page.degraded, 'fallback')
    assert.equal(page.resume, undefined)
  })
})

describe('§9.1 first pack includes open groups outside last-N', () => {
  it('unions open agent_group cards into the first pack', () => {
    const frames: LiveFrameInput[] = []
    frames.push(frame('g', 8, {
      kind: 'delegate_progress',
      runId: 'dlg-early',
      phase: 'start',
      goal: 'still running',
    }))
    for (let i = 1; i <= 30; i++) {
      frames.push(frame(String(100 + i), 100 + i, {
        kind: 'tool_use',
        blockId: `parent-${i}`,
        toolName: 'Bash',
        inputPreview: `t${i}`,
      }))
    }
    const reduced = reduceLiveFrames(frames)
    assert.equal(reduced.ok, true)
    if (!reduced.ok) return
    const page = serveLiveUnits(reduced.state, META, { n: 20 })
    assert.ok(page.units.some((u) => u.runId === 'dlg-early' && u.open))
    const ids = page.units.map((u) => u.id)
    assert.equal(new Set(ids).size, ids.length)
  })
})

describe('B1 reduce deadline is fallback, never a prefix resume', () => {
  it('over-cap returns degraded=fallback with no resume.frameSeq', () => {
    const frames = Array.from({ length: 400 }, (_, i) =>
      frame(String(i + 1), i + 1, { kind: 'thinking', text: `d${i}` }),
    )
    let t = 0
    const reduced = reduceLiveFrames(frames, {
      deadlineMs: 50,
      now: () => {
        t += 1
        return t === 1 ? 0 : 1_000
      },
    })
    assert.equal(reduced.ok, false)
    if (reduced.ok) return
    assert.equal(reduced.degraded, 'fallback')
    let t2 = 0
    const page = assembleLiveUnitsPage(frames, META, {
      deadlineMs: 50,
      now: () => {
        t2 += 1
        return t2 === 1 ? 0 : 10_000
      },
    })
    // assemble with an already-expired clock must not mint a prefix resume
    assert.equal(page.degraded, 'fallback')
    assert.equal(page.resume, undefined)
    assert.equal(page.throughFrameSeq, undefined)
  })

  it('reaching the true tail does mint resume.frameSeq', () => {
    const frames = [
      frame('10', 10, { kind: 'thinking', text: 'a' }),
      frame('11', 11, { kind: 'thinking', text: 'b' }),
    ]
    const page = assembleLiveUnitsPage(frames, META, { deadlineMs: 5_000 })
    assert.equal(page.degraded, false)
    assert.equal(page.resume?.frameSeq, 11)
    assert.equal(page.resume?.recordId, '11')
  })
})

describe('B2 reduce state is full fold; K window is serving-only', () => {
  it('cross-window tool_use + later tool_result still joins', () => {
    const frames: LiveFrameInput[] = []
    frames.push(frame('1', 1, {
      kind: 'delegate_progress',
      runId: 'dlg-x',
      phase: 'start',
      goal: 'cross window',
    }))
    for (let i = 0; i < 25; i++) {
      frames.push(frame(String(10 + i), 10 + i, {
        kind: 'delegate_progress',
        runId: 'dlg-x',
        phase: 'tool',
        block: {
          kind: 'tool_use',
          blockId: `tu-${i}`,
          toolName: 'Read',
          inputPreview: `file-${i}`,
        },
      }))
    }
    const prefix = reduceLiveFrames(frames)
    assert.equal(prefix.ok, true)
    if (!prefix.ok) return
    assert.equal(prefix.state.units[0]?.children?.length, 25)

    const resultFrame = frame('99', 99, {
      kind: 'delegate_progress',
      runId: 'dlg-x',
      phase: 'tool',
      block: {
        kind: 'tool_result',
        toolUseBlockId: 'tu-0',
        output: 'RESULT-FROM-OUTSIDE-WINDOW',
      },
    })
    const continued = continueReduceLiveFrames(prefix.state, [resultFrame])
    assert.equal(continued.ok, true)
    if (!continued.ok) return
    const full = reduceLiveFrames([...frames, resultFrame])
    assert.equal(full.ok, true)
    if (!full.ok) return
    const joined = continued.state.units[0]?.children?.find((c) => c.blockId === 'tu-0')
    const joinedFull = full.state.units[0]?.children?.find((c) => c.blockId === 'tu-0')
    assert.equal(joined?.output, 'RESULT-FROM-OUTSIDE-WINDOW')
    assert.equal(joinedFull?.output, 'RESULT-FROM-OUTSIDE-WINDOW')
    assert.equal(continued.state.units[0]?.children?.length, full.state.units[0]?.children?.length)

    const served = serveLiveUnits(continued.state, META, { n: 20, k: 20 })
    const servedGroup = served.units.find((u) => u.runId === 'dlg-x')
    assert.ok(servedGroup)
    assert.equal(servedGroup?.children?.length, 20)
    assert.equal(servedGroup?.nestedHasMoreBefore, true)
    assert.equal(
      servedGroup?.children?.some((c) => c.blockId === 'tu-0'),
      false,
      'serving K-window hides tu-0 but reduce state still has it',
    )
    assert.ok(continued.state.units[0]?.children?.some((c) => c.blockId === 'tu-0' && c.output === 'RESULT-FROM-OUTSIDE-WINDOW'))
  })

  it('catch-up 20 frames equals a full reduce', () => {
    const frames = Array.from({ length: 120 }, (_, i) =>
      frame(String(i + 1), i + 1, {
        kind: i % 3 === 0 ? 'tool_use' : 'thinking',
        ...(i % 3 === 0
          ? { blockId: `b-${i}`, toolName: 'Bash', inputPreview: 'x' }
          : { text: `h${i}` }),
      }),
    )
    const page = assembleLiveUnitsPage(frames.slice(0, 100), META, {}, frames.slice(100))
    const full = assembleLiveUnitsPage(frames, META, {})
    assert.equal(page.degraded, false)
    assert.equal(full.degraded, false)
    assert.equal(page.resume?.frameSeq, full.resume?.frameSeq)
    assert.equal(page.units.length, full.units.length)
    assert.deepEqual(
      page.units.map((u) => [u.id, u.kind, u.text, u.blockId]),
      full.units.map((u) => [u.id, u.kind, u.text, u.blockId]),
    )
  })
})

describe('B3 adversarial first-pack byte budget', () => {
  it('20 parent tools + 4 open groups ×20 children, each payload 8KB, trim to ≤512KB and keep open chrome', () => {
    const frames: LiveFrameInput[] = []
    let seq = 1
    let rec = 1
    const blob = kb(8)
    for (let g = 0; g < 4; g++) {
      const runId = `dlg-open-${g}`
      frames.push(frame(String(rec++), seq++, {
        kind: 'delegate_progress',
        runId,
        phase: 'start',
        goal: `goal-${g}`,
        agentId: `agent-${g}`,
      }))
      for (let c = 0; c < 20; c++) {
        frames.push(frame(String(rec++), seq++, {
          kind: 'delegate_progress',
          runId,
          phase: 'tool',
          block: {
            kind: 'tool_use',
            blockId: `${runId}-tu-${c}`,
            toolName: 'Read',
            inputJson: { body: blob },
          },
        }))
      }
    }
    for (let i = 0; i < 20; i++) {
      frames.push(frame(String(rec++), seq++, {
        kind: 'tool_use',
        blockId: `parent-${i}`,
        toolName: 'Read',
        inputJson: { body: blob },
      }))
    }
    const page = assembleLiveUnitsPage(frames, META, { n: 20, k: 20, maxBytes: LIVE_UNITS_FIRST_PACK_MAX_BYTES })
    const bytes = Buffer.byteLength(JSON.stringify(page), 'utf8')
    assert.ok(bytes <= LIVE_UNITS_FIRST_PACK_MAX_BYTES, `first pack ${bytes} exceeded 512KB`)
    const openGroups = page.units.filter((u) => u.kind === 'agent_group' && u.open)
    assert.equal(openGroups.length, 4, 'open group chrome must survive budget trim')
    assert.equal(page.degraded, false)
    assert.ok(page.resume?.frameSeq)
  })
})

describe('stable unit ids and payloadRef tape fallback', () => {
  it('before prepend does not duplicate ids already in the first pack', () => {
    const frames: LiveFrameInput[] = []
    frames.push(frame('g', 5, {
      kind: 'delegate_progress',
      runId: 'dlg-open',
      phase: 'start',
      goal: 'early open',
    }))
    for (let i = 0; i < 25; i++) {
      frames.push(frame(String(20 + i), 20 + i, {
        kind: 'tool_use',
        blockId: `later-${i}`,
        toolName: 'Bash',
        inputPreview: `n${i}`,
      }))
    }
    const reduced = reduceLiveFrames(frames)
    assert.equal(reduced.ok, true)
    if (!reduced.ok) return
    const first = serveLiveUnits(reduced.state, META, { n: 20 })
    assert.ok(first.beforeCursor)
    const older = serveLiveUnits(reduced.state, META, { n: 20, before: first.beforeCursor })
    const seen = new Set(first.units.map((u) => u.id))
    const dupes = older.units.filter((u) => seen.has(u.id))
    // open group may appear only in first pack; older pack must not re-send it
    assert.equal(dupes.length, 0)
    const merged = new Map<string, LiveUnit>()
    for (const u of [...older.units, ...first.units]) merged.set(u.id, u)
    assert.equal(merged.size, older.units.length + first.units.length)
  })

  it('payloadRef prefers live then falls back to tape after prune', () => {
    assert.equal(choosePayloadRefSource({ livePayload: { ok: 1 }, tapePayload: { ok: 2 } })?.source, 'live')
    assert.equal(choosePayloadRefSource({ livePayload: null, tapePayload: { ok: 2 } })?.source, 'tape')
    assert.equal(choosePayloadRefSource({ livePayload: null, tapePayload: null }), null)
  })
})

describe('PR3 checkpoint fold is full state, serving-only K/preview', () => {
  it('hit+catch-up equals full reduce, including cross-window tool_result', () => {
    const frames: LiveFrameInput[] = []
    frames.push(frame('1', 1, {
      kind: 'delegate_progress',
      runId: 'dlg-x',
      phase: 'start',
      goal: 'cross',
    }))
    for (let i = 0; i < 25; i++) {
      frames.push(frame(String(i + 2), i + 2, {
        kind: 'delegate_progress',
        runId: 'dlg-x',
        phase: 'tool',
        block: {
          kind: 'tool_use',
          blockId: `tu-${i}`,
          toolName: 'Read',
          inputPreview: `p${i}`,
        },
      }))
    }
    const prefix = reduceLiveFrames(frames)
    assert.equal(prefix.ok, true)
    if (!prefix.ok) return
    const folded = foldLiveUnitStateForCheckpoint(prefix.state)
    assert.ok(folded)
    const parsed = parseLiveUnitCheckpoint(JSON.parse(folded.json))
    assert.ok(parsed)
    assert.equal(parsed.units[0]?.children?.length, 25)

    const resultFrame = frame('99', 99, {
      kind: 'delegate_progress',
      runId: 'dlg-x',
      phase: 'tool',
      block: {
        kind: 'tool_result',
        toolUseBlockId: 'tu-0',
        output: 'RESULT-FROM-OUTSIDE-WINDOW',
      },
    })
    const continued = continueReduceLiveFrames(parsed, [resultFrame])
    assert.equal(continued.ok, true)
    if (!continued.ok) return
    const full = reduceLiveFrames([...frames, resultFrame])
    assert.equal(full.ok, true)
    if (!full.ok) return
    const joined = continued.state.units[0]?.children?.find((c) => c.blockId === 'tu-0')
    const joinedFull = full.state.units[0]?.children?.find((c) => c.blockId === 'tu-0')
    assert.equal(joined?.output, 'RESULT-FROM-OUTSIDE-WINDOW')
    assert.equal(joinedFull?.output, 'RESULT-FROM-OUTSIDE-WINDOW')
    assert.equal(continued.state.units[0]?.children?.length, full.state.units[0]?.children?.length)
    assert.equal(continued.state.throughFrameSeq, full.state.throughFrameSeq)

    const fromState = assembleLiveUnitsFromState(parsed, META, { n: 20, k: 20 }, [resultFrame])
    const fullPage = assembleLiveUnitsPage([...frames, resultFrame], META, { n: 20, k: 20 })
    assert.equal(fromState.resume?.frameSeq, fullPage.resume?.frameSeq)
    assert.equal(fromState.degraded, false)
  })

  it('payloadRef-izes oversized fields but keeps every child (no K window)', () => {
    const huge = kb(200)
    const frames = [
      frame('1', 1, {
        kind: 'delegate_progress',
        runId: 'dlg-big',
        phase: 'start',
        goal: 'big',
      }),
      frame('2', 2, {
        kind: 'delegate_progress',
        runId: 'dlg-big',
        phase: 'tool',
        block: {
          kind: 'tool_result',
          toolUseBlockId: 'tu-1',
          blockId: 'tu-1:result',
          toolName: 'Read',
          output: huge,
        },
      }),
    ]
    const reduced = reduceLiveFrames(frames)
    assert.equal(reduced.ok, true)
    if (!reduced.ok) return
    assert.equal(reduced.state.units[0]?.children?.[0]?.output, huge)
    const folded = foldLiveUnitStateForCheckpoint(reduced.state)
    assert.ok(folded)
    assert.ok(folded.json.length < huge.length)
    const child = folded.state.units[0]?.children?.[0]
    assert.ok(child)
    assert.notEqual(child.output, huge)
    assert.ok(typeof child.preview === 'string' && child.preview.length > 0)
    assert.ok(child.payloadRef)
    assert.equal(folded.state.units[0]?.children?.length, reduced.state.units[0]?.children?.length)
  })

  it('keeps every child of a large fold under the 8MB cap via short payloadRef stubs', () => {
    const frames: LiveFrameInput[] = [
      frame('1', 1, { kind: 'delegate_progress', runId: 'dlg-many', phase: 'start', goal: 'many' }),
    ]
    for (let i = 0; i < 80; i++) {
      frames.push(frame(String(i + 2), i + 2, {
        kind: 'delegate_progress',
        runId: 'dlg-many',
        phase: 'tool',
        block: {
          kind: 'tool_result',
          toolUseBlockId: `tu-${i}`,
          blockId: `tu-${i}:result`,
          toolName: 'Read',
          output: kb(8),
        },
      }))
    }
    const reduced = reduceLiveFrames(frames)
    assert.equal(reduced.ok, true)
    if (!reduced.ok) return
    assert.equal(reduced.state.units[0]?.children?.length, 80)
    const folded = foldLiveUnitStateForCheckpoint(reduced.state)
    assert.ok(folded)
    assert.ok(folded.json.length < LIVE_UNITS_CHECKPOINT_MAX_BYTES)
    assert.equal(folded.state.units[0]?.children?.length, 80)
    assert.ok(folded.state.units[0]?.children?.every((c) => c.payloadRef))
  })

  it('epoch mismatch and corrupt JSON fail closed to rebuild', () => {
    const reduced = reduceLiveFrames([frame('1', 1, { kind: 'thinking', text: 'x' })])
    assert.equal(reduced.ok, true)
    if (!reduced.ok) return
    const folded = foldLiveUnitStateForCheckpoint(reduced.state)
    assert.ok(folded)
    const parsed = JSON.parse(folded.json) as { reducerEpoch: string }
    parsed.reducerEpoch = '999'
    assert.equal(parseLiveUnitCheckpoint(parsed), null)
    assert.equal(parseLiveUnitCheckpoint({ reducerEpoch: '1', units: 'nope' }), null)
    assert.equal(parseLiveUnitCheckpoint(null), null)
    assert.equal(parseLiveUnitCheckpoint({}), null)
  })

  it('skips writes when even ref-folded JSON exceeds the hard cap', () => {
    const reduced = reduceLiveFrames([frame('1', 1, { kind: 'thinking', text: 'tiny' })])
    assert.equal(reduced.ok, true)
    if (!reduced.ok) return
    const skipped = foldLiveUnitStateForCheckpoint(reduced.state, { maxBytes: 8 })
    assert.equal(skipped, null)
    assert.ok(LIVE_UNITS_CHECKPOINT_MAX_BYTES >= 1024 * 1024)
  })
})

describe('BL1 delegate_task folds into one agent_group (web reducer parity)', () => {
  it('tool_use → delegate_progress → tool_result is one agent_group and zero extra tool cards', () => {
    const frames = [
      frame('1', 1, {
        kind: 'tool_use',
        blockId: 'tool-bl1',
        toolName: 'delegate_task',
        inputJson: { agentId: 'hidden-reviewer', goal: '审查草稿' },
      }),
      frame('2', 2, {
        kind: 'delegate_progress',
        runId: 'dlg-bl1',
        agentId: 'hidden-reviewer',
        goal: '审查草稿',
        phase: 'start',
      }),
      frame('3', 3, {
        kind: 'delegate_progress',
        runId: 'dlg-bl1',
        phase: 'text',
        block: { kind: 'text', text: 'child output' },
      }),
      frame('4', 4, {
        kind: 'tool_result',
        toolUseBlockId: 'tool-bl1',
        output: 'PASS',
      }),
    ]
    const reduced = reduceLiveFrames(frames)
    assert.equal(reduced.ok, true)
    if (!reduced.ok) return
    const kinds = reduced.state.units.map((u) => u.kind)
    assert.deepEqual(kinds, ['agent_group'])
    const group = reduced.state.units[0]!
    assert.equal(group.blockId, 'tool-bl1')
    assert.equal(group.runId, 'dlg-bl1')
    assert.equal(group.completed, true)
    assert.equal(group.open, false)
    assert.equal(group.output, 'PASS')
    assert.ok(group.children?.some((c) => c.kind === 'text' && c.text === 'child output'))
    assert.equal(reduced.state.units.filter((u) => u.kind === 'tool').length, 0)
  })

  it('send_to_agent running tool_result keeps the group open until phase=done', () => {
    const frames = [
      frame('1', 1, {
        kind: 'tool_use',
        blockId: 'tool-sta',
        toolName: 'mcp__openclaude-memory__send_to_agent',
        inputJson: { agentId: 'research-assistant', message: '查萧山' },
      }),
      frame('2', 2, {
        kind: 'delegate_progress',
        runId: 'dlg-sta',
        agentId: 'research-assistant',
        goal: '查萧山',
        phase: 'start',
      }),
      frame('3', 3, {
        kind: 'tool_result',
        toolUseBlockId: 'tool-sta',
        output: JSON.stringify({ status: 'running', jobId: 'dlgjob-1' }),
      }),
      frame('4', 4, {
        kind: 'delegate_progress',
        runId: 'dlg-sta',
        phase: 'text',
        block: { kind: 'text', text: '检索中' },
      }),
    ]
    const reduced = reduceLiveFrames(frames)
    assert.equal(reduced.ok, true)
    if (!reduced.ok) return
    const group = reduced.state.units[0]!
    assert.equal(group.kind, 'agent_group')
    assert.equal(group.open, true)
    assert.equal(group.completed, false)
    assert.ok(group.children?.some((c) => c.kind === 'text' && c.text === '检索中'))

    const done = reduceLiveFrames([
      ...frames,
      frame('5', 5, {
        kind: 'delegate_progress',
        runId: 'dlg-sta',
        agentId: 'research-assistant',
        goal: '查萧山',
        phase: 'done',
        text: '结论',
      }),
    ])
    assert.equal(done.ok, true)
    if (!done.ok) return
    assert.equal(done.state.units[0]?.completed, true)
    assert.equal(done.state.units[0]?.open, false)
  })

  it('send_to_agent running status unwraps MCP wrapper and Codex mcpToolCall input', () => {
    const frames = [
      frame('1', 1, {
        kind: 'tool_use',
        blockId: 'tool-wrap',
        toolName: 'codex:mcpToolCall',
        inputJson: {
          server: 'openclaude-memory',
          tool: 'send_to_agent',
          arguments: { agentId: 'research-assistant', message: '查萧山' },
        },
      }),
      frame('2', 2, {
        kind: 'tool_result',
        toolUseBlockId: 'tool-wrap',
        output: JSON.stringify({
          server: 'openclaude-memory',
          tool: 'send_to_agent',
          result: {
            content: [{ type: 'text', text: JSON.stringify({ status: 'running', jobId: 'dlgjob-w' }) }],
          },
        }),
      }),
    ]
    const reduced = reduceLiveFrames(frames)
    assert.equal(reduced.ok, true)
    if (!reduced.ok) return
    assert.equal(reduced.state.units[0]?.kind, 'agent_group')
    assert.equal(reduced.state.units[0]?.open, true)
    assert.equal(reduced.state.units[0]?.completed, false)
    assert.equal(reduced.state.units[0]?.agentId, 'research-assistant')
  })

  it('fan-out delegate_tasks stays a tool card; each child run is its own group', () => {
    const frames = [
      frame('1', 1, {
        kind: 'tool_use',
        blockId: 'fanout-1',
        toolName: 'mcp__openclaude-memory__delegate_tasks',
        inputJson: { tasks: [{ agentId: 'a', goal: 'one' }, { agentId: 'b', goal: 'two' }] },
      }),
      frame('2', 2, {
        kind: 'delegate_progress',
        runId: 'run-a',
        agentId: 'a',
        goal: 'one',
        phase: 'start',
      }),
      frame('3', 3, {
        kind: 'delegate_progress',
        runId: 'run-b',
        agentId: 'b',
        goal: 'two',
        phase: 'start',
      }),
    ]
    const reduced = reduceLiveFrames(frames)
    assert.equal(reduced.ok, true)
    if (!reduced.ok) return
    const kinds = reduced.state.units.map((u) => u.kind)
    assert.deepEqual(kinds, ['tool', 'agent_group', 'agent_group'])
    assert.equal(reduced.state.units[0]?.blockId, 'fanout-1')
  })
})

describe('BL2 open thinking identity survives catch-up', () => {
  it('catch-up thinking delta continues the open unit keyed by messageId', () => {
    const prefix = reduceLiveFrames([
      frame('1', 1, { kind: 'thinking', text: 'aaa', messageId: 'srv-think-1' }),
    ])
    assert.equal(prefix.ok, true)
    if (!prefix.ok) return
    assert.equal(prefix.state.units[0]?.messageId, 'srv-think-1')
    const continued = continueReduceLiveFrames(prefix.state, [
      frame('2', 2, { kind: 'thinking', text: 'bbb', messageId: 'srv-think-1' }),
    ])
    assert.equal(continued.ok, true)
    if (!continued.ok) return
    assert.equal(continued.state.units.length, 1)
    assert.equal(continued.state.units[0]?.text, 'aaabbb')
    assert.equal(continued.state.units[0]?.messageId, 'srv-think-1')
  })
})

describe('BL3 checkpoint keeps full cumulative thinking', () => {
  it('long cumulative thinking survives checkpoint hit + catch-up equal to a full reduce', () => {
    const frames = Array.from({ length: 20 }, (_, i) =>
      frame(String(i + 1), i + 1, {
        kind: 'thinking',
        text: 'T'.repeat(30),
        messageId: 'srv-long-think',
      }),
    )
    const prefix = reduceLiveFrames(frames.slice(0, 10))
    assert.equal(prefix.ok, true)
    if (!prefix.ok) return
    assert.ok((prefix.state.units[0]?.text || '').length > 256)
    const folded = foldLiveUnitStateForCheckpoint(prefix.state)
    assert.ok(folded)
    assert.equal(folded.state.units[0]?.text, prefix.state.units[0]?.text)
    const parsed = parseLiveUnitCheckpoint(JSON.parse(folded.json))
    assert.ok(parsed)
    const continued = continueReduceLiveFrames(parsed, frames.slice(10))
    assert.equal(continued.ok, true)
    if (!continued.ok) return
    const full = reduceLiveFrames(frames)
    assert.equal(full.ok, true)
    if (!full.ok) return
    assert.equal(continued.state.units[0]?.text, full.state.units[0]?.text)
    assert.equal(continued.state.units[0]?.text, 'T'.repeat(600))
  })

  it('8MB checkpoint cap is UTF-8 bytes not JS string length', () => {
    const reduced = reduceLiveFrames([
      frame('1', 1, { kind: 'thinking', text: '你'.repeat(50) }),
    ])
    assert.equal(reduced.ok, true)
    if (!reduced.ok) return
    const uncapped = foldLiveUnitStateForCheckpoint(reduced.state, { maxBytes: 1e9 })
    assert.ok(uncapped)
    const jsLen = uncapped.json.length
    const utf8 = Buffer.byteLength(uncapped.json, 'utf8')
    assert.ok(utf8 > jsLen, `utf8 ${utf8} should exceed JS length ${jsLen}`)
    const skipped = foldLiveUnitStateForCheckpoint(reduced.state, { maxBytes: jsLen })
    assert.equal(skipped, null)
  })
})

describe('BL4 first-pack budget includes goal and falls back when exhausted', () => {
  it('5 open groups × 150KB goal fit the 512KB budget or explicit fallback', () => {
    const blob = kb(150)
    const frames: LiveFrameInput[] = []
    for (let g = 0; g < 5; g++) {
      frames.push(frame(String(g + 1), g + 1, {
        kind: 'delegate_progress',
        runId: `dlg-goal-${g}`,
        agentId: `agent-${g}`,
        phase: 'start',
        goal: blob,
      }))
    }
    const page = assembleLiveUnitsPage(frames, META, {
      n: 20,
      k: 20,
      maxBytes: LIVE_UNITS_FIRST_PACK_MAX_BYTES,
    })
    const bytes = Buffer.byteLength(JSON.stringify(page), 'utf8')
    if (page.degraded === 'fallback') {
      assert.equal(page.resume, undefined)
      assert.equal(page.units.length, 0)
    } else {
      assert.ok(bytes <= LIVE_UNITS_FIRST_PACK_MAX_BYTES, `first pack ${bytes} exceeded 512KB`)
      assert.equal(page.degraded, false)
      assert.equal(page.units.filter((u) => u.kind === 'agent_group' && u.open).length, 5)
    }
  })

  it('budget trim drops the oldest non-open unit first', () => {
    const frames: LiveFrameInput[] = [
      frame('g', 1, {
        kind: 'delegate_progress',
        runId: 'dlg-keep',
        phase: 'start',
        goal: 'open chrome',
      }),
    ]
    for (let i = 0; i < 6; i++) {
      frames.push(frame(String(10 + i), 10 + i, {
        kind: 'tool_use',
        blockId: `old-${i}`,
        toolName: 'Bash',
        inputPreview: kb(2),
      }))
    }
    const page = assembleLiveUnitsPage(frames, META, { n: 20, k: 20, maxBytes: 8 * 1024, previewMax: 256 })
    if (page.degraded === 'fallback') {
      assert.equal(page.resume, undefined)
      return
    }
    const rest = page.units.filter((u) => !(u.open && u.kind === 'agent_group'))
    assert.ok(page.units.some((u) => u.runId === 'dlg-keep' && u.open))
    if (rest.length > 0 && rest.length < 6) {
      const maxKept = Math.max(...rest.map((u) => u.seqFirst))
      const minKept = Math.min(...rest.map((u) => u.seqFirst))
      assert.equal(maxKept, 15)
      assert.ok(minKept > 10, `dropped newest instead of oldest; kept seqs ${rest.map((u) => u.seqFirst).join(',')}`)
      assert.equal(page.hasMoreBefore, true)
    } else {
      assert.ok(rest.length < 6, 'expected budget to drop at least one parent tool')
    }
  })
})
