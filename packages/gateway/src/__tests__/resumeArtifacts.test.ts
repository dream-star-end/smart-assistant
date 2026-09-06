import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cursorResumeStorePath } from '../engine/cursorAdapter.js'
import { pickResumableId, probeResumeArtifact } from '../engine/resumeArtifacts.js'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

function scaffold() {
  const dir = mkdtempSync(join(tmpdir(), 'oc-resume-artifacts-'))
  const claudeConfigDir = join(dir, 'claude-config')
  const codexHome = join(dir, 'codex')
  const openclaudeHome = join(dir, 'oc-home')
  const workspacePath = join(dir, 'ws')
  mkdirSync(join(claudeConfigDir, 'projects', 'p1'), { recursive: true })
  mkdirSync(join(codexHome, 'sessions', '2026', '09', '06'), { recursive: true })
  mkdirSync(join(openclaudeHome, 'grok-build', 'sessions', '%2Fws'), { recursive: true })
  mkdirSync(join(openclaudeHome, 'zcode-cli', 'cli', 'db'), { recursive: true })
  mkdirSync(join(openclaudeHome, 'zcode-cli', 'cli', 'exec'), { recursive: true })
  mkdirSync(workspacePath, { recursive: true })
  return {
    dir,
    ctx: {
      claudeConfigDir,
      codexHome,
      openclaudeHome,
      workspacePath,
      env: {} as NodeJS.ProcessEnv,
    },
  }
}

test('probeResumeArtifact: CCB / Cursor Sand JSONL must exist and be non-empty', () => {
  const { dir, ctx } = scaffold()
  try {
    const projects = join(ctx.claudeConfigDir, 'projects', 'p1')
    writeFileSync(join(projects, `${A}.jsonl`), '{"type":"user"}\n')
    writeFileSync(join(projects, `${B}.jsonl`), '') // 0-byte: emitted session_id, died before first frame

    assert.equal(probeResumeArtifact('ccb', A, ctx).exists, true)
    assert.equal(probeResumeArtifact('ccb', B, ctx).exists, false)
    assert.equal(probeResumeArtifact('ccb', C, ctx).exists, false)
    assert.equal(probeResumeArtifact('cursor', `sand-ccb:${A}`, ctx).exists, true)
    assert.equal(probeResumeArtifact('cursor', `sand-official-cc:${A}`, ctx).exists, true)
    assert.equal(probeResumeArtifact('cursor', `sand-ccb:${C}`, ctx).exists, false)
    assert.equal(probeResumeArtifact('cursor', 'sand-ccb:../../escape', ctx).exists, false)
    // Unknown CLAUDE_CONFIG_DIR → conservative true.
    assert.equal(probeResumeArtifact('ccb', A, { ...ctx, claudeConfigDir: '' }).exists, true)
    // Non-engine-shaped ids (test doubles, foreign formats) → conservative true, no path.
    assert.equal(probeResumeArtifact('ccb', 'thread-full-1', ctx).exists, true)
    assert.equal(probeResumeArtifact('codex', 'thread-full-1', ctx).exists, true)
    assert.equal(probeResumeArtifact('grok', 'not-a-uuid', ctx).exists, true)
    assert.equal(probeResumeArtifact('zcode', 'nope', ctx).exists, true)
    assert.equal(probeResumeArtifact('codex', 'thread-full-1', ctx).path, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probeResumeArtifact: codex rollout is matched by thread id suffix under sessions/Y/M/D', () => {
  const { dir, ctx } = scaffold()
  try {
    const day = join(ctx.codexHome, 'sessions', '2026', '09', '06')
    writeFileSync(join(day, `rollout-2026-09-06T01-00-00-${A}.jsonl`), '{"x":1}\n')
    writeFileSync(join(day, `rollout-2026-09-06T01-05-00-${B}.jsonl`), '')
    assert.equal(probeResumeArtifact('codex', A, ctx).exists, true)
    assert.equal(probeResumeArtifact('codex', B, ctx).exists, false)
    assert.equal(probeResumeArtifact('codex', C, ctx).exists, false)
    // No sessions dir at all → conservative true.
    assert.equal(
      probeResumeArtifact('codex', C, { ...ctx, codexHome: join(dir, 'nope') }).exists,
      true,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probeResumeArtifact: grok session dir must exist with content; zcode is db-gated', () => {
  const { dir, ctx } = scaffold()
  try {
    const grp = join(ctx.openclaudeHome, 'grok-build', 'sessions', '%2Fws')
    mkdirSync(join(grp, A))
    writeFileSync(join(grp, A, 'chat_history.jsonl'), '{}\n')
    mkdirSync(join(grp, B)) // empty dir
    assert.equal(probeResumeArtifact('grok', A, ctx).exists, true)
    assert.equal(probeResumeArtifact('grok', B, ctx).exists, false)
    assert.equal(probeResumeArtifact('grok', C, ctx).exists, false)

    // zcode: no db → definitely gone; db present → unknown (true) unless exec dir proves it.
    assert.equal(probeResumeArtifact('zcode', 'sess_abcdefgh', ctx).exists, false)
    writeFileSync(join(ctx.openclaudeHome, 'zcode-cli', 'cli', 'db', 'db.sqlite'), 'x')
    assert.equal(probeResumeArtifact('zcode', 'sess_abcdefgh', ctx).exists, true)
    assert.equal(probeResumeArtifact('zcode', 'sess_abcdefgh', ctx).path, undefined)
    mkdirSync(join(ctx.openclaudeHome, 'zcode-cli', 'cli', 'exec', 'sess_abcdefgh'))
    writeFileSync(join(ctx.openclaudeHome, 'zcode-cli', 'cli', 'exec', 'sess_abcdefgh', 'f'), '1')
    assert.ok(probeResumeArtifact('zcode', 'sess_abcdefgh', ctx).path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probeResumeArtifact: native cursor store.db at spawn cwd; unknown without cwd', () => {
  const { dir, ctx } = scaffold()
  try {
    const store = cursorResumeStorePath(ctx.workspacePath, A)
    mkdirSync(join(store, '..'), { recursive: true })
    writeFileSync(store, 'sqlite')
    assert.equal(probeResumeArtifact('cursor', A, ctx).exists, true)
    assert.equal(probeResumeArtifact('cursor', B, ctx).exists, false)
    assert.equal(probeResumeArtifact('cursor', B, { ...ctx, workspacePath: null }).exists, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pickResumableId: head wins when durable; otherwise newest history id with a POSITIVE hit', () => {
  const { dir, ctx } = scaffold()
  try {
    const projects = join(ctx.claudeConfigDir, 'projects', 'p1')
    writeFileSync(join(projects, `${A}.jsonl`), '{"type":"user"}\n')
    writeFileSync(join(projects, `${B}.jsonl`), '{"type":"user"}\n')

    // head C dead, history [B, A] → B
    let r = pickResumableId('ccb', C, [B, A], ctx)
    assert.equal(r?.id, B)
    assert.equal(r?.fromHistory, true)

    // head B alive → B, not from history
    r = pickResumableId('ccb', B, [A], ctx)
    assert.equal(r?.id, B)
    assert.equal(r?.fromHistory, false)

    // head dead, history has only dead ids → undefined
    assert.equal(
      pickResumableId('ccb', C, ['44444444-4444-4444-8444-444444444444'], ctx),
      undefined,
    )

    // history entries equal to head are skipped
    assert.equal(pickResumableId('ccb', C, [C, C], ctx), undefined)

    // 'unknown' probe (no config dir) on head → head returned; on history → NOT promoted
    r = pickResumableId('ccb', C, [B], { ...ctx, claudeConfigDir: '' })
    assert.equal(r?.id, C)
    assert.equal(pickResumableId('ccb', undefined, [B], { ...ctx, claudeConfigDir: '' }), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
