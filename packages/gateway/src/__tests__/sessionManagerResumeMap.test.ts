import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'
import { SessionManager } from '../sessionManager.js'

function makeConfigStub(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
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

test('legacy Sand CCB resume ids retire once Sand returns to native Cursor resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-sand-resume-map-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  try {
    const configDir = join(dir, 'claude-config')
    const projectDir = join(configDir, 'projects', 'sand-project')
    mkdirSync(projectDir, { recursive: true })
    const innerId = '463989eb-daba-4a13-a32d-4ef00261ea08'
    const prefixedId = `sand-ccb:${innerId}`
    writeFileSync(join(projectDir, `${innerId}.jsonl`), '{"type":"user"}\n')
    process.env.CLAUDE_CONFIG_DIR = configDir

    const manager = new SessionManager(makeConfigStub())
    const internals = manager as unknown as ResumeMapInternals
    internals.resumeMapPath = join(dir, 'resume-map.json')
    internals._resumeMap.set('sand-session', prefixedId)
    internals._resumeMapProvider.set('sand-session', 'cursor')

    assert.equal(
      internals._resumeIdFor('sand-session', 'cursor', join(dir, 'workspace-with-no-cursor-store')),
      undefined,
    )
    assert.equal(internals._resumeMap.has('sand-session'), false)

    internals._resumeMap.set('malformed-sand-session', 'sand-ccb:../../escape')
    internals._resumeMapProvider.set('malformed-sand-session', 'cursor')
    assert.equal(
      internals._resumeIdFor('malformed-sand-session', 'cursor', join(dir, 'workspace')),
      undefined,
    )
    assert.equal(internals._resumeMap.has('malformed-sand-session'), false)
    await internals.awaitResumeMapFlush()
  } finally {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    rmSync(dir, { recursive: true, force: true })
  }
})
