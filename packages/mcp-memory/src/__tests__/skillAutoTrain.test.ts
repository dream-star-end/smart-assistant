import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildSkillAutoTrainPrompt,
  createSkillAutoTrainDelegateRequest,
  formatSkillAutoTrainAcceptedRun,
  formatSkillAutoTrainStatus,
  isNestedSkillAutoTrainBlocked,
  normalizeSkillAutoTrainArgs,
} from '../skillAutoTrain.js'

const NOW = new Date('2026-06-12T16:10:00.000Z')

describe('normalizeSkillAutoTrainArgs', () => {
  it('defaults to a bounded auto-apply run for the current agent', () => {
    const args = normalizeSkillAutoTrainArgs(undefined, 'main')

    assert.deepEqual(args, {
      targetAgentId: 'main',
      lookbackHours: 24,
      maxSessions: 8,
      maxSkillEdits: 3,
      apply: true,
      waitForCompletion: false,
    })
  })

  it('clamps numeric budgets and trims target/focus', () => {
    const args = normalizeSkillAutoTrainArgs(
      {
        targetAgentId: ' coder ',
        lookbackHours: 999,
        maxSessions: 0,
        maxSkillEdits: 11,
        apply: false,
        focus: ' OpenClaude release ',
        waitForCompletion: true,
      },
      'main',
    )

    assert.deepEqual(args, {
      targetAgentId: 'coder',
      lookbackHours: 168,
      maxSessions: 1,
      maxSkillEdits: 10,
      apply: false,
      focus: 'OpenClaude release',
      waitForCompletion: true,
    })
  })
})

describe('buildSkillAutoTrainPrompt', () => {
  it('pins recursion guard, mode, caps, focus, and date window', () => {
    const prompt = buildSkillAutoTrainPrompt(
      {
        targetAgentId: 'main',
        lookbackHours: 6,
        maxSessions: 4,
        maxSkillEdits: 2,
        apply: true,
        focus: 'terminal UX',
        waitForCompletion: false,
      },
      NOW,
    )

    assert.match(prompt, /Mode: APPLY_CHANGES/)
    assert.match(prompt, /DO NOT call `skill_train_auto`/)
    assert.match(prompt, /hard-blocks `skill_train_auto` inside delegated sessions/)
    assert.match(prompt, /inspect at most 4 candidate sessions/)
    assert.match(prompt, /apply at most 2 skill changes/)
    assert.match(prompt, /Focus constraint: terminal UX/)
    assert.match(prompt, /2026-06-12T10:10:00\.000Z through 2026-06-12T16:10:00\.000Z/)
  })

  it('uses dry-run wording when apply is false', () => {
    const prompt = buildSkillAutoTrainPrompt(
      {
        targetAgentId: 'main',
        lookbackHours: 24,
        maxSessions: 8,
        maxSkillEdits: 3,
        apply: false,
        waitForCompletion: false,
      },
      NOW,
    )

    assert.match(prompt, /Mode: DRY_RUN_ONLY/)
    assert.match(prompt, /do not write; report exact proposed changes/i)
  })
})

describe('isNestedSkillAutoTrainBlocked', () => {
  it('allows top-level sessions and blocks delegated sessions', () => {
    assert.equal(isNestedSkillAutoTrainBlocked(undefined), false)
    assert.equal(isNestedSkillAutoTrainBlocked('0'), false)
    assert.equal(isNestedSkillAutoTrainBlocked('1'), true)
    assert.equal(isNestedSkillAutoTrainBlocked('3'), true)
    assert.equal(isNestedSkillAutoTrainBlocked('-1'), true)
  })

  it('blocks malformed depth instead of risking recursive training', () => {
    assert.equal(isNestedSkillAutoTrainBlocked('not-a-number'), true)
    assert.equal(isNestedSkillAutoTrainBlocked('0abc'), true)
    assert.equal(isNestedSkillAutoTrainBlocked('0.5'), true)
    assert.equal(isNestedSkillAutoTrainBlocked('0x1'), true)
    assert.equal(isNestedSkillAutoTrainBlocked(' 0 '), true)
  })
})

describe('createSkillAutoTrainDelegateRequest', () => {
  it('builds the target, prompt, and context used by the MCP handler', () => {
    const request = createSkillAutoTrainDelegateRequest(
      {
        targetAgentId: 'codex',
        lookbackHours: 12,
        maxSessions: 5,
        maxSkillEdits: 4,
      },
      'main',
      NOW,
    )

    assert.equal(request.targetAgentId, 'codex')
    assert.match(request.prompt, /Agent being trained: codex/)
    assert.match(request.prompt, /Mode: APPLY_CHANGES/)
    assert.match(request.context, /apply=true/)
    assert.match(request.context, /lookbackHours=12/)
    assert.match(request.context, /maxSessions=5/)
    assert.match(request.context, /maxSkillEdits=4/)
    assert.match(request.context, /waitForCompletion=false/)
    assert.equal(request.waitForCompletion, false)
  })
})

describe('skill_train_auto formatting helpers', () => {
  it('formats the accepted background run with a status command', () => {
    const text = formatSkillAutoTrainAcceptedRun({
      targetAgentId: 'main',
      runId: 'run-abc',
      sessionKey: 'agent:main:delegate:test:1',
    })

    assert.match(text, /后台训练/)
    assert.match(text, /Run ID: run-abc/)
    assert.match(text, /skill_train_auto_status/)
  })

  it('formats run status with output preview', () => {
    const text = formatSkillAutoTrainStatus({
      id: 'run-abc',
      sessionKey: 'agent:main:delegate:test:1',
      status: 'completed',
      startedAt: Date.parse('2026-06-12T16:00:00.000Z'),
      durationMs: 123_000,
      outputPreview: 'updated release checklist',
    })

    assert.match(text, /status: completed/)
    assert.match(text, /Duration: 123s/)
    assert.match(text, /updated release checklist/)
  })
})
