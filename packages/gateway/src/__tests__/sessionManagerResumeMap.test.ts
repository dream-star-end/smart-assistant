import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentDef, OpenClaudeConfig } from '@openclaude/storage'
import { SessionManager } from '../sessionManager.js'

function makeConfigStub(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
    defaults: { model: 'glm-5.3-zai' },
  } as unknown as OpenClaudeConfig
}

type ResumeMapInternals = {
  resumeMapPath: string
  _resumeMap: Map<string, string>
  _resumeMapTimestamps: Map<string, number>
  _resumeMapProvider: Map<string, string>
  _resumeMapLastCost: Map<string, number>
  _resumeMapCostImprecise: Map<string, boolean>
  _resumeMapWrite: Promise<void>
  _loadResumeMap: () => void
  _saveResumeMap: () => void
  awaitResumeMapFlush: () => Promise<void>
  _resumeIdFor: (sessionKey: string, wantProvider: string, workspacePath?: string) => string | undefined
}

test('CCB resume map rebuilds obsolete history contexts while preserving current CCB and Codex resumes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-resume-context-'))
  try {
    const path = join(dir, 'resume-map.json')
    writeFileSync(path, JSON.stringify({
      'ccb-legacy-string': 'legacy-ccb-id',
      'ccb-unversioned': { id: 'unversioned-ccb-id', ts: 10 },
      'ccb-old-version': { id: 'old-ccb-id', ts: 20, historyContextVersion: 0 },
      'ccb-current': { id: 'current-ccb-id', ts: 30, historyContextVersion: 1, costImprecise: true },
      'codex-unversioned': { id: 'codex-thread-id', ts: 40, provider: 'codex' },
    }))

    const manager = new SessionManager(makeConfigStub())
    const internals = manager as unknown as ResumeMapInternals
    internals.resumeMapPath = path
    internals._resumeMap.clear()
    internals._resumeMapTimestamps.clear()
    internals._resumeMapProvider.clear()
    internals._resumeMapLastCost.clear()
    internals._resumeMapCostImprecise.clear()
    internals._loadResumeMap()

    assert.equal(internals._resumeMap.has('ccb-legacy-string'), false)
    assert.equal(internals._resumeMap.has('ccb-unversioned'), false)
    assert.equal(internals._resumeMap.has('ccb-old-version'), false)
    assert.equal(internals._resumeMap.get('ccb-current'), 'current-ccb-id')
    assert.equal(internals._resumeMapProvider.get('ccb-current'), 'ccb')
    assert.equal(internals._resumeMapCostImprecise.get('ccb-current'), true)
    assert.equal(internals._resumeMap.get('codex-unversioned'), 'codex-thread-id')
    assert.equal(internals._resumeMapProvider.get('codex-unversioned'), 'codex')

    internals._saveResumeMap()
    await internals.awaitResumeMapFlush()
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>
    assert.equal(saved['ccb-current']?.historyContextVersion, 1)
    assert.equal(saved['ccb-current']?.provider, undefined)
    assert.equal(saved['ccb-current']?.costImprecise, true)
    assert.equal(saved['codex-unversioned']?.historyContextVersion, undefined)
    assert.equal(saved['codex-unversioned']?.provider, 'codex')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Cursor Sand resume ids validate against CCB JSONL instead of Cursor workspace store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-sand-resume-map-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  try {
    const configDir = join(dir, 'claude-config')
    const projectDir = join(configDir, 'projects', 'sand-project')
    mkdirSync(projectDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = configDir

    const manager = new SessionManager(makeConfigStub())
    const internals = manager as unknown as ResumeMapInternals
    internals.resumeMapPath = join(dir, 'resume-map.json')
    for (const [index, prefix] of ['sand-ccb:', 'sand-official-cc:'].entries()) {
      const innerId = index === 0
        ? '463989eb-daba-4a13-a32d-4ef00261ea08'
        : '3bdc1a6e-63e3-4a3b-a29f-9aeb4e08c1cd'
      const key = `sand-session-${index}`
      const prefixedId = `${prefix}${innerId}`
      const jsonl = join(projectDir, `${innerId}.jsonl`)
      writeFileSync(jsonl, '{"type":"user"}\n')
      internals._resumeMap.set(key, prefixedId)
      internals._resumeMapProvider.set(key, 'cursor')

      assert.equal(
        internals._resumeIdFor(key, 'cursor', join(dir, 'workspace-with-no-cursor-store')),
        prefixedId,
      )

      rmSync(jsonl)
      assert.equal(
        internals._resumeIdFor(key, 'cursor', join(dir, 'workspace-with-no-cursor-store')),
        undefined,
      )
      assert.equal(internals._resumeMap.has(key), false)

      const malformedKey = `malformed-sand-session-${index}`
      internals._resumeMap.set(malformedKey, `${prefix}../../escape`)
      internals._resumeMapProvider.set(malformedKey, 'cursor')
      assert.equal(
        internals._resumeIdFor(malformedKey, 'cursor', join(dir, 'workspace')),
        undefined,
      )
      assert.equal(internals._resumeMap.has(malformedKey), false)
    }
    await internals.awaitResumeMapFlush()
  } finally {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    rmSync(dir, { recursive: true, force: true })
  }
})

test('official Claude Code Cursor resume survives a gateway resume-map reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-official-cc-resume-reload-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  try {
    const configDir = join(dir, 'claude-config')
    const projectDir = join(configDir, 'projects', 'official-project')
    mkdirSync(projectDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = configDir
    const innerId = 'e7016a22-0e0d-44ba-88e6-bddce23371cf'
    const prefixedId = `sand-official-cc:${innerId}`
    writeFileSync(join(projectDir, `${innerId}.jsonl`), '{"type":"user"}\n')
    const resumeMapPath = join(dir, 'resume-map.json')

    const first = new SessionManager(makeConfigStub()) as unknown as ResumeMapInternals
    first.resumeMapPath = resumeMapPath
    first._resumeMap.set('official-session', prefixedId)
    first._resumeMapProvider.set('official-session', 'cursor')
    first._resumeMapTimestamps.set('official-session', Date.now())
    first._saveResumeMap()
    await first.awaitResumeMapFlush()

    const restarted = new SessionManager(makeConfigStub()) as unknown as ResumeMapInternals
    restarted.resumeMapPath = resumeMapPath
    restarted._resumeMap.clear()
    restarted._resumeMapProvider.clear()
    restarted._resumeMapTimestamps.clear()
    restarted._loadResumeMap()
    assert.equal(
      restarted._resumeIdFor('official-session', 'cursor', join(dir, 'workspace-with-no-cursor-store')),
      prefixedId,
    )
  } finally {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gateway rebuild forces bounded history when Cursor Sand switches from CCB to official CC', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-official-cc-transport-switch-'))
  const previous = {
    configDir: process.env.CLAUDE_CONFIG_DIR,
    official: process.env.OC_CURSOR_SAND_OFFICIAL_CC,
    wrapper: process.env.OC_CURSOR_WRAPPER_BIN,
    authority: process.env.OC_MODEL_AUTHORITY,
  }
  try {
    const configDir = join(dir, 'claude-config')
    const projectDir = join(configDir, 'projects', 'ccb-project')
    const workspace = join(dir, 'workspace')
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    const innerId = '764f07b3-a5ed-47b5-9c3b-1d3109d3e71c'
    const oldCcbResume = `sand-ccb:${innerId}`
    writeFileSync(join(projectDir, `${innerId}.jsonl`), '{"type":"user"}\n')
    const wrapper = join(dir, 'oc-cursor')
    writeFileSync(wrapper, `#!/bin/sh
set -eu
if [ "\${OPENCLAUDE_CURSOR_SELECT_ONLY:-}" = 1 ]; then
  echo 'oc-cursor: selected_slot 2 api-key.2 sand gen-0123456789abcdef01234567 42 0123456789abcdef'
  exit 0
fi
exit 0
`, { mode: 0o755 })
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.OC_CURSOR_SAND_OFFICIAL_CC = '1'
    process.env.OC_CURSOR_WRAPPER_BIN = wrapper
    process.env.OC_MODEL_AUTHORITY = '0'

    const manager = new SessionManager(makeConfigStub())
    const internals = manager as unknown as ResumeMapInternals
    internals._saveResumeMap = () => {}
    internals._resumeMap.clear()
    internals._resumeMapProvider.clear()
    internals._resumeMap.set('agent:main:webchat:dm:official-switch', oldCcbResume)
    internals._resumeMapProvider.set('agent:main:webchat:dm:official-switch', 'cursor')

    const session = await manager.getOrCreate({
      sessionKey: 'agent:main:webchat:dm:official-switch',
      agent: { id: 'main', cwd: workspace, model: 'cursor-fable-5.1-high' } as AgentDef,
      channel: 'webchat',
      peerId: 'official-switch',
      model: 'cursor-fable-5.1-high',
    })
    assert.equal(
      (session.runner as unknown as { currentVariant: string }).currentVariant,
      'sand-official-cc',
    )
    assert.equal(session.runner.isResumeIdCompatible?.(oldCcbResume), false)
    assert.equal(session.runner.nativeSessionId, null)
    assert.equal(session._forceHistoricalContextOnFirstTurn, true)
    assert.equal(session._contextRebuildNotice, 'native-resume-loss')

    // A session-open preheat can mint an empty official id before the first
    // real turn. It may update the resume map, but must not clear the rebuild
    // fence that prevents the empty transcript from suppressing PG history.
    session.runner.emit(
      'session_id',
      'sand-official-cc:e7016a22-0e0d-44ba-88e6-bddce23371cf',
    )
    assert.equal(session._forceHistoricalContextOnFirstTurn, true)

    const switchedToGrok = await manager.getOrCreate({
      sessionKey: 'agent:main:webchat:dm:official-switch',
      agent: { id: 'main', cwd: workspace, model: 'cursor-grok-4.6-high' } as AgentDef,
      channel: 'webchat',
      peerId: 'official-switch',
      model: 'cursor-grok-4.6-high',
    })
    assert.notEqual(switchedToGrok, session, 'transport-changing model switch must reopen the adapter')
    assert.equal(
      (switchedToGrok.runner as unknown as { currentVariant: string }).currentVariant,
      'sand-ccb',
    )
    await switchedToGrok.runner.shutdown()
  } finally {
    if (previous.configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous.configDir
    if (previous.official === undefined) delete process.env.OC_CURSOR_SAND_OFFICIAL_CC
    else process.env.OC_CURSOR_SAND_OFFICIAL_CC = previous.official
    if (previous.wrapper === undefined) delete process.env.OC_CURSOR_WRAPPER_BIN
    else process.env.OC_CURSOR_WRAPPER_BIN = previous.wrapper
    if (previous.authority === undefined) delete process.env.OC_MODEL_AUTHORITY
    else process.env.OC_MODEL_AUTHORITY = previous.authority
    rmSync(dir, { recursive: true, force: true })
  }
})
