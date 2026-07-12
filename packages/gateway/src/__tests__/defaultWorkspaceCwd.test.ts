/**
 * resolveDefaultWorkspaceCwd — agent 缺省工作目录解析(设计 §3.2)。
 *
 * 不变量:OPENCLAUDE_DEFAULT_WORKSPACE 已设 **且** 指向已存在目录 → 用之;
 * 否则(未设 / 目录不存在 / 指向非目录)一律回落 process.cwd()(个人版零变化)。
 * gateway 不在此 mkdir —— 目录创建责任在容器 entrypoint。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/defaultWorkspaceCwd.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
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
      resolveDefaultWorkspaceCwd({ OPENCLAUDE_DEFAULT_WORKSPACE: dir } as NodeJS.ProcessEnv),
      dir,
    )
  })

  it('env 设 + 目录不存在 → 回落 process.cwd()', () => {
    const missing = join(tmpdir(), 'oc-ws-does-not-exist-xyz-12345')
    assert.equal(
      resolveDefaultWorkspaceCwd({ OPENCLAUDE_DEFAULT_WORKSPACE: missing } as NodeJS.ProcessEnv),
      process.cwd(),
    )
  })

  it('env 设但指向文件(非目录) → 回落 process.cwd()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-ws-'))
    cleanup.push(dir)
    const file = join(dir, 'not-a-dir')
    writeFileSync(file, 'x')
    assert.equal(
      resolveDefaultWorkspaceCwd({ OPENCLAUDE_DEFAULT_WORKSPACE: file } as NodeJS.ProcessEnv),
      process.cwd(),
    )
  })

  it('env 未设 → 回落 process.cwd()(个人版零变化)', () => {
    assert.equal(resolveDefaultWorkspaceCwd({} as NodeJS.ProcessEnv), process.cwd())
  })

  it('env 设为空白串 → 回落 process.cwd()', () => {
    assert.equal(
      resolveDefaultWorkspaceCwd({ OPENCLAUDE_DEFAULT_WORKSPACE: '   ' } as NodeJS.ProcessEnv),
      process.cwd(),
    )
  })
})
