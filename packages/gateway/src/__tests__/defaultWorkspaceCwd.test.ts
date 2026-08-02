/**
 * resolveDefaultWorkspaceCwd — agent 缺省工作目录解析(设计 §3.2)。
 *
 * 不变量:legacy 保持原有共享目录/回落语义;isolated_v1 在已存在的持久化根
 * 下惰性创建 sessions/<clientSessionId>,不同会话互不共享。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/defaultWorkspaceCwd.test.ts
 */
import * as assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { resolveDefaultWorkspaceCwd } from '../sessionManager.js'

const cleanup: string[] = []
afterEach(() => {
  for (const p of cleanup.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true })
    } catch {}
  }
})

describe('resolveDefaultWorkspaceCwd', () => {
  it('env 设 + 目录存在 → 用该目录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-ws-'))
    cleanup.push(dir)
    assert.equal(
      resolveDefaultWorkspaceCwd('legacy', undefined, { OPENCLAUDE_DEFAULT_WORKSPACE: dir } as NodeJS.ProcessEnv),
      dir,
    )
  })

  it('env 设 + 目录不存在 → 回落 process.cwd()', () => {
    const missing = join(tmpdir(), 'oc-ws-does-not-exist-xyz-12345')
    assert.equal(
      resolveDefaultWorkspaceCwd('legacy', undefined, { OPENCLAUDE_DEFAULT_WORKSPACE: missing } as NodeJS.ProcessEnv),
      process.cwd(),
    )
  })

  it('env 设但指向文件(非目录) → 回落 process.cwd()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-ws-'))
    cleanup.push(dir)
    const file = join(dir, 'not-a-dir')
    writeFileSync(file, 'x')
    assert.equal(
      resolveDefaultWorkspaceCwd('legacy', undefined, { OPENCLAUDE_DEFAULT_WORKSPACE: file } as NodeJS.ProcessEnv),
      process.cwd(),
    )
  })

  it('env 未设 → 回落 process.cwd()(个人版零变化)', () => {
    assert.equal(resolveDefaultWorkspaceCwd('legacy', undefined, {} as NodeJS.ProcessEnv), process.cwd())
  })

  it('env 设为空白串 → 回落 process.cwd()', () => {
    assert.equal(
      resolveDefaultWorkspaceCwd('legacy', undefined, { OPENCLAUDE_DEFAULT_WORKSPACE: '   ' } as NodeJS.ProcessEnv),
      process.cwd(),
    )
  })

  it('isolated_v1 creates a stable per-session directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-ws-'))
    cleanup.push(dir)
    const env = { OPENCLAUDE_DEFAULT_WORKSPACE: dir } as NodeJS.ProcessEnv
    const first = resolveDefaultWorkspaceCwd('isolated_v1', 'websession_123', env)
    const again = resolveDefaultWorkspaceCwd('isolated_v1', 'websession_123', env)
    const other = resolveDefaultWorkspaceCwd('isolated_v1', 'websession_456', env)
    assert.equal(first, join(dir, 'sessions', 'websession_123'))
    assert.equal(again, first)
    assert.notEqual(other, first)
    assert.equal(existsSync(first), true)
    assert.equal(existsSync(other), true)
  })

  it('isolated_v1 rejects an unsafe id or a missing persistent root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-ws-'))
    cleanup.push(dir)
    assert.throws(
      () => resolveDefaultWorkspaceCwd('isolated_v1', '../escape', {
        OPENCLAUDE_DEFAULT_WORKSPACE: dir,
      } as NodeJS.ProcessEnv),
      /valid client session id/,
    )
    assert.throws(
      () => resolveDefaultWorkspaceCwd('isolated_v1', 'websession_123', {} as NodeJS.ProcessEnv),
      /requires OPENCLAUDE_DEFAULT_WORKSPACE/,
    )
  })
})
