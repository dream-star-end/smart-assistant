import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { symlinkSync } from 'node:fs'

import {
  buildAdvisorSnapshot,
  collectAuthorizedArtifacts,
  extractGeneratedPaths,
  formatAdvisorConsultPrompt,
  historyFromSessionMessages,
  listProvenAdvisorModels,
  matchConsultIdentity,
  parentAuthorizedArtifactTexts,
  stripAdvisorPreambleFromInjected,
  ADVISOR_PREAMBLE,
} from '../advisorMode.js'

describe('advisorMode snapshot', () => {
  it('marks missing history/tools/artifacts instead of pretending complete', () => {
    const snap = buildAdvisorSnapshot({
      question: 'why red?',
      concern: 'assert',
      advisorModel: 'gpt-6-astra',
      source: { userTask: 'fix the test' },
    })
    assert.deepEqual(snap.missing, [
      'injected_constraints',
      'history_tape',
      'current_turn_tools',
      'authorized_artifacts',
    ])
    assert.match(formatAdvisorConsultPrompt(snap), /缺失证据/)
    assert.match(formatAdvisorConsultPrompt(snap), /why red/)
  })

  it('matchConsultIdentity requires both question and concern', () => {
    assert.equal(
      matchConsultIdentity({ question: 'a', concern: 'b' }, { question: 'a', concern: 'b' }),
      true,
    )
    assert.equal(
      matchConsultIdentity({ question: 'a', concern: 'b' }, { question: 'a', concern: 'c' }),
      false,
    )
  })

  it('collectAuthorizedArtifacts reads generated files and rejects symlink escape', async () => {
    const root = join(tmpdir(), `oc-adv-art-${Date.now()}`)
    await mkdir(root, { recursive: true })
    const file = join(root, 'note.txt')
    await writeFile(file, 'hello advisor')
    const outside = join(tmpdir(), `oc-adv-secret-${Date.now()}.txt`)
    await writeFile(outside, 'secret')
    const link = join(root, 'escape.txt')
    symlinkSync(outside, link)
    const rows = collectAuthorizedArtifacts({
      generatedRoot: root,
      mentioned: [file, link, outside],
    })
    assert.equal(rows.find((r) => r.path === file || r.path.endsWith('note.txt'))?.content, 'hello advisor')
    assert.equal(rows.find((r) => r.path === link)?.missing, 'symlink_rejected')
    assert.equal(rows.find((r) => r.path === outside)?.missing, 'escape_rejected')
  })

  it('extractGeneratedPaths only keeps volume generated names', () => {
    const paths = extractGeneratedPaths([
      'see /home/agent/.openclaude/generated/ocv5-210-report.md and /etc/passwd',
    ])
    assert.deepEqual(paths, ['/home/agent/.openclaude/generated/ocv5-210-report.md'])
  })

  it('does not treat advisor preamble as injected user constraints', () => {
    const snap = buildAdvisorSnapshot({
      question: 'q',
      concern: '',
      advisorModel: 'gpt-6-astra',
      source: { userTask: 'task', injectedConstraints: ADVISOR_PREAMBLE },
    })
    assert.equal(snap.constraints.includes('consult_advisor'), true)
    assert.equal(stripAdvisorPreambleFromInjected(ADVISOR_PREAMBLE + 'doc lines'), 'doc lines')
    const honest = buildAdvisorSnapshot({
      question: 'q',
      concern: '',
      advisorModel: 'gpt-6-astra',
      source: { userTask: 'task', injectedConstraints: stripAdvisorPreambleFromInjected(ADVISOR_PREAMBLE) },
    })
    assert.ok(honest.missing.includes('injected_constraints'))
  })

  it('parentAuthorizedArtifactTexts ignores question/concern self-reported paths', () => {
    const mentioned = parentAuthorizedArtifactTexts({
      userTask: 'please read /home/agent/.openclaude/generated/parent.txt',
      currentTools: [{ result: 'wrote /home/agent/.openclaude/generated/tool-out.md' }],
    })
    assert.deepEqual(mentioned.sort(), [
      '/home/agent/.openclaude/generated/parent.txt',
      '/home/agent/.openclaude/generated/tool-out.md',
    ].sort())
    const fromQuestion = extractGeneratedPaths(['other session /home/agent/.openclaude/generated/other.txt'])
    assert.equal(mentioned.includes('/home/agent/.openclaude/generated/other.txt'), false)
    assert.deepEqual(fromQuestion, ['/home/agent/.openclaude/generated/other.txt'])
  })

  it('historyFromSessionMessages drops thinking and flags archived prefix', () => {
    const hist = historyFromSessionMessages(
      [
        { role: 'thinking', text: 'secret chain' },
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'hi' },
      ],
      { archivedThroughSeq: 12 },
    )
    assert.deepEqual(
      hist.records?.map((row) => row.role),
      ['user', 'assistant'],
    )
    assert.ok(hist.missing.includes('tape_archived_prefix'))
    assert.equal(hist.records?.some((row) => row.text === 'secret chain'), false)
  })

  it('listProvenAdvisorModels stays empty until an engine is proven', () => {
    const catalog = [
      { modelId: 'gpt-6-astra', displayName: 'GPT-6 Astra', engine: 'codex', available: true },
      { modelId: 'deepseek-v4-flash', displayName: 'DS', engine: 'ccb', available: true },
    ]
    const closed = listProvenAdvisorModels({ catalog, provenEngines: [] })
    assert.deepEqual(closed.advisorModels, [])
    assert.match(closed.advisorUnavailableReason ?? '', /尚未完成无工具证明/)
    const open = listProvenAdvisorModels({ catalog, provenEngines: ['codex'] })
    assert.deepEqual(open.advisorModels, [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', engine: 'codex' }])
  })
})
