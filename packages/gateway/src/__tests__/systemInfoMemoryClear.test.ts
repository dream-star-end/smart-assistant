import * as assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'oc-sysinfo-memclear-'))
process.env.OPENCLAUDE_HOME = TEST_HOME
for (const key of [
  'OPENCLAUDE_PLATFORM_PROMPTS_DIR',
  'OPENCLAUDE_V3_MASTER_BASE_URL',
  'OPENCLAUDE_V3_CONTAINER_TOKEN',
]) {
  Reflect.deleteProperty(process.env, key)
}

const { buildMemorySlot } = await import('../promptSlots.js')

const SKILL_URL = new URL(
  '../../../commercial/agent-sandbox/ccb-baseline/skills/system-info/SKILL.md',
  import.meta.url,
)

function extractDocumentedMemoryCommands(): { preview: string; clear: string } {
  const lines = readFileSync(SKILL_URL, 'utf8').split('\n')
  const previewIdx = lines.findIndex((line) => line.includes('1. **先预览**'))
  const clearIdx = lines.findIndex((line) => line.includes('2. 用户核对后'))
  assert.ok(
    previewIdx >= 0 && previewIdx + 1 < lines.length,
    'missing preview step in system-info SKILL.md',
  )
  assert.ok(
    clearIdx >= 0 && clearIdx + 1 < lines.length,
    'missing delete step in system-info SKILL.md',
  )
  const preview = lines[previewIdx + 1].trim().replace(/^`|`$/g, '')
  const clear = lines[clearIdx + 1].trim().replace(/^`|`$/g, '')
  assert.ok(
    preview.includes('/home/agent/.openclaude'),
    'preview command must reference /home/agent/.openclaude',
  )
  assert.ok(
    clear.includes('/home/agent/.openclaude'),
    'clear command must reference /home/agent/.openclaude',
  )
  return { preview, clear }
}

function isolateCommand(documented: string, homeDir: string): string {
  const isolated = documented.replaceAll('/home/agent/.openclaude', homeDir)
  assert.ok(!isolated.includes('/home/agent/.openclaude'), 'unmapped /home/agent/.openclaude left')
  return isolated
}

function buildChildEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== 'OPENCLAUDE_AGENT_ID' && key !== 'OC_AGENT_ID',
    ),
  )
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value
  }
  return env
}

function parseLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort()
}

describe('system-info persistent memory preview and clear flow (#1301 P1)', () => {
  beforeEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true })
    mkdirSync(TEST_HOME, { recursive: true })
  })

  after(() => {
    rmSync(TEST_HOME, { recursive: true, force: true })
  })

  it('clears current-agent MEMORY.md so next non-Cursor buildMemorySlot has no residual summary', async () => {
    const { clear } = extractDocumentedMemoryCommands()
    const isolatedClear = isolateCommand(clear, TEST_HOME)

    const agentDir = join(TEST_HOME, 'agents/main')
    const leaf = join(agentDir, 'memory/preference.md')
    const index = join(agentDir, 'MEMORY.md')
    const profile = join(TEST_HOME, 'user.md')
    const sentinel = 'RF1301_SYNTHETIC_PREF_TEAL'

    mkdirSync(join(agentDir, 'memory'), { recursive: true })
    writeFileSync(
      leaf,
      '---\nname: test preference\ndescription: synthetic preference\ntype: user\n---\nTest preference: teal.\n',
    )
    writeFileSync(
      index,
      `<!-- oc-memdir-index v1 -->\n- [Synthetic preference](memory/preference.md) — ${sentinel}\n`,
    )
    writeFileSync(profile, 'Synthetic user profile; no real user data.\n')

    const ctx = {
      agentId: 'main',
      provider: 'ccb',
      sessionKey: 'agent:main:webchat:dm:isolated-clear-probe',
    }
    const before = await buildMemorySlot(ctx)
    assert.ok(before.content.includes(TEST_HOME), 'memory slot must read isolated TEST_HOME')
    assert.ok(before.content.includes(sentinel), 'initial memory summary must be injected')

    execFileSync('/bin/bash', ['-c', isolatedClear], {
      cwd: TEST_HOME,
      env: buildChildEnv(),
      stdio: 'pipe',
    })

    assert.equal(existsSync(leaf), false, 'current agent memory leaf must be deleted')
    assert.equal(existsSync(profile), false, 'shared user.md profile must be deleted')
    assert.equal(existsSync(index), false, 'current agent MEMORY.md index must be deleted')

    const afterSlot = await buildMemorySlot(ctx)
    assert.ok(
      !afterSlot.content.includes(sentinel),
      'cleared preference must not reappear in next non-Cursor memory slot',
    )
  })

  it('previews exact target set including MEMORY.md and preserves other agents and project files', async () => {
    const { preview, clear } = extractDocumentedMemoryCommands()
    const isolatedPreview = isolateCommand(preview, TEST_HOME)
    const isolatedClear = isolateCommand(clear, TEST_HOME)

    const mainDir = join(TEST_HOME, 'agents/main')
    const mainLeaf = join(mainDir, 'memory/preference.md')
    const mainIndex = join(mainDir, 'MEMORY.md')
    const mainPersona = join(mainDir, 'CLAUDE.md')
    const mainLock = join(mainDir, 'MEMORY.md.lock')
    const mainSkill = join(mainDir, 'skills/custom/SKILL.md')
    const profile = join(TEST_HOME, 'user.md')

    const otherDir = join(TEST_HOME, 'agents/researcher')
    const otherLeaf = join(otherDir, 'memory/paper.md')
    const otherIndex = join(otherDir, 'MEMORY.md')
    const otherSentinel = 'RF1301_OTHER_AGENT_SURVIVES'

    const projMemory = join(TEST_HOME, 'projects/proj-1/memory/spec.md')
    const projIndex = join(TEST_HOME, 'projects/proj-1/MEMORY.md')
    const workspaceDoc = join(TEST_HOME, 'workspace/projects/proj-1/MEMORY.md')

    mkdirSync(join(mainDir, 'memory'), { recursive: true })
    mkdirSync(join(mainDir, 'skills/custom'), { recursive: true })
    mkdirSync(join(otherDir, 'memory'), { recursive: true })
    mkdirSync(join(TEST_HOME, 'projects/proj-1/memory'), { recursive: true })
    mkdirSync(join(TEST_HOME, 'workspace/projects/proj-1'), { recursive: true })

    writeFileSync(mainLeaf, '---\nname: p\ndescription: d\ntype: user\n---\nbody\n')
    writeFileSync(mainIndex, '<!-- oc-memdir-index v1 -->\n- [P](memory/preference.md) — hook\n')
    writeFileSync(mainPersona, '# Main persona\n')
    writeFileSync(mainLock, '')
    writeFileSync(mainSkill, '# Custom skill\n')
    writeFileSync(profile, 'User profile\n')

    writeFileSync(otherLeaf, '---\nname: r\ndescription: d\ntype: project\n---\nother\n')
    writeFileSync(
      otherIndex,
      `<!-- oc-memdir-index v1 -->\n- [Paper](memory/paper.md) — ${otherSentinel}\n`,
    )
    writeFileSync(projMemory, 'Project formal memory\n')
    writeFileSync(projIndex, '# Project index\n')
    writeFileSync(workspaceDoc, '# Workspace doc\n')

    for (const shell of ['/bin/bash', '/bin/sh']) {
      const previewOut = execFileSync(shell, ['-c', isolatedPreview], {
        cwd: TEST_HOME,
        env: buildChildEnv(),
        encoding: 'utf8',
      })
      assert.deepEqual(
        parseLines(previewOut),
        [mainIndex, mainLeaf, profile].sort(),
        `preview under ${shell} must list exact current-agent memory files + MEMORY.md + user.md`,
      )
    }

    execFileSync('/bin/sh', ['-c', isolatedClear], {
      cwd: TEST_HOME,
      env: buildChildEnv(),
      stdio: 'pipe',
    })

    assert.equal(existsSync(mainLeaf), false)
    assert.equal(existsSync(mainIndex), false)
    assert.equal(existsSync(profile), false)

    for (const preserved of [
      mainPersona,
      mainLock,
      mainSkill,
      otherLeaf,
      otherIndex,
      projMemory,
      projIndex,
      workspaceDoc,
    ]) {
      assert.equal(existsSync(preserved), true, `must not delete unrelated file ${preserved}`)
    }

    const otherSlot = await buildMemorySlot({
      agentId: 'researcher',
      provider: 'ccb',
      sessionKey: 'agent:researcher:webchat:dm:other-survives',
    })
    assert.ok(otherSlot.content.includes(otherSentinel), 'other agent memory slot must remain intact')
  })

  it('scopes preview and clear to non-default agent via OPENCLAUDE_AGENT_ID or Codex OC_AGENT_ID', async () => {
    const { preview, clear } = extractDocumentedMemoryCommands()
    const isolatedPreview = isolateCommand(preview, TEST_HOME)
    const isolatedClear = isolateCommand(clear, TEST_HOME)

    const mainLeaf = join(TEST_HOME, 'agents/main/memory/main.md')
    const mainIndex = join(TEST_HOME, 'agents/main/MEMORY.md')
    const subLeaf = join(TEST_HOME, 'agents/coding-assistant/memory/sub.md')
    const subIndex = join(TEST_HOME, 'agents/coding-assistant/MEMORY.md')
    const profile = join(TEST_HOME, 'user.md')

    mkdirSync(join(TEST_HOME, 'agents/main/memory'), { recursive: true })
    mkdirSync(join(TEST_HOME, 'agents/coding-assistant/memory'), { recursive: true })
    writeFileSync(mainLeaf, '---\nname: m\ndescription: m\ntype: user\n---\nmain\n')
    writeFileSync(mainIndex, '<!-- oc-memdir-index v1 -->\n- [M](memory/main.md) — MAIN_KEEP\n')
    writeFileSync(subLeaf, '---\nname: s\ndescription: s\ntype: user\n---\nsub\n')
    writeFileSync(subIndex, '<!-- oc-memdir-index v1 -->\n- [S](memory/sub.md) — SUB_CLEAR\n')
    writeFileSync(profile, 'Shared profile\n')

    // Simulate Codex environment where OPENCLAUDE_* is scrubbed and OC_AGENT_ID is injected.
    const codexEnv = buildChildEnv({ OPENCLAUDE_AGENT_ID: '', OC_AGENT_ID: 'coding-assistant' })
    const previewOut = execFileSync('/bin/bash', ['-c', isolatedPreview], {
      cwd: TEST_HOME,
      env: codexEnv,
      encoding: 'utf8',
    })
    assert.deepEqual(parseLines(previewOut), [profile, subIndex, subLeaf].sort())

    execFileSync('/bin/bash', ['-c', isolatedClear], {
      cwd: TEST_HOME,
      env: codexEnv,
      stdio: 'pipe',
    })

    assert.equal(existsSync(subLeaf), false)
    assert.equal(existsSync(subIndex), false)
    assert.equal(existsSync(profile), false)
    assert.equal(existsSync(mainLeaf), true)
    assert.equal(existsSync(mainIndex), true)

    const subSlot = await buildMemorySlot({
      agentId: 'coding-assistant',
      provider: 'codex',
      sessionKey: 'agent:coding-assistant:webchat:dm:codex-clear',
    })
    assert.ok(!subSlot.content.includes('SUB_CLEAR'))

    const mainSlot = await buildMemorySlot({
      agentId: 'main',
      provider: 'ccb',
      sessionKey: 'agent:main:webchat:dm:main-untouched',
    })
    assert.ok(mainSlot.content.includes('MAIN_KEEP'))
  })

  it('is idempotent when empty, fails closed on invalid agentId, and ignores symlinked memory dir', () => {
    const { preview, clear } = extractDocumentedMemoryCommands()
    const isolatedPreview = isolateCommand(preview, TEST_HOME)
    const isolatedClear = isolateCommand(clear, TEST_HOME)

    // 1. Completely empty home: both preview and clear succeed with exit 0 and empty output.
    const emptyPreview = spawnSync('/bin/sh', ['-c', isolatedPreview], {
      cwd: TEST_HOME,
      env: buildChildEnv(),
      encoding: 'utf8',
    })
    assert.equal(emptyPreview.status, 0)
    assert.equal(emptyPreview.stdout.trim(), '')
    assert.equal(emptyPreview.stderr.trim(), '')

    const emptyClear = spawnSync('/bin/sh', ['-c', isolatedClear], {
      cwd: TEST_HOME,
      env: buildChildEnv(),
      encoding: 'utf8',
    })
    assert.equal(emptyClear.status, 0)
    assert.equal(emptyClear.stderr.trim(), '')

    // 2. Invalid agentId traversal/glob attempts fail closed without touching files.
    const projectFile = join(TEST_HOME, 'projects/p1/MEMORY.md')
    const projectLeaf = join(TEST_HOME, 'projects/p1/memory/keep.md')
    const userFile = join(TEST_HOME, 'user.md')
    mkdirSync(join(TEST_HOME, 'projects/p1/memory'), { recursive: true })
    writeFileSync(projectFile, '# keep\n')
    writeFileSync(projectLeaf, '# keep leaf\n')
    writeFileSync(userFile, 'keep on failed guard\n')

    for (const badId of ['../projects/p1', 'main/../../projects/p1', '*', 'a b', 'main\nevil']) {
      const badPreview = spawnSync('/bin/bash', ['-c', isolatedPreview], {
        cwd: TEST_HOME,
        env: buildChildEnv({ OPENCLAUDE_AGENT_ID: badId }),
        encoding: 'utf8',
      })
      assert.notEqual(badPreview.status, 0, `preview must reject invalid agentId ${JSON.stringify(badId)}`)
      assert.equal(badPreview.stdout.trim(), '')

      const badClear = spawnSync('/bin/bash', ['-c', isolatedClear], {
        cwd: TEST_HOME,
        env: buildChildEnv({ OPENCLAUDE_AGENT_ID: badId }),
        encoding: 'utf8',
      })
      assert.notEqual(badClear.status, 0, `clear must reject invalid agentId ${JSON.stringify(badId)}`)
    }
    assert.equal(existsSync(projectFile), true)
    assert.equal(existsSync(projectLeaf), true)
    assert.equal(existsSync(userFile), true)

    // 3. Symlinked agents/main/memory pointing to projects/p1/memory must not traverse into projects.
    mkdirSync(join(TEST_HOME, 'agents/main'), { recursive: true })
    symlinkSync(join(TEST_HOME, 'projects/p1/memory'), join(TEST_HOME, 'agents/main/memory'))
    execFileSync('/bin/bash', ['-c', isolatedClear], {
      cwd: TEST_HOME,
      env: buildChildEnv(),
      stdio: 'pipe',
    })
    assert.equal(existsSync(projectLeaf), true, 'symlinked memory dir must not delete target project files')
  })
})
