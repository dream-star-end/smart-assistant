/**
 * Phase 5 Plan v3 Step A — LocalBackend 必须按 caller 的 subprocessCwd
 * 决定子进程真 cwd,而不是把 ccbBinaryDir 硬编码进去。这是 GitHub repo
 * binding ready 后 CCB / codex 子进程 process.cwd() 能正确指向项目目录的
 * 物理基础;若回退,系统提示和实际 cwd 又会自相矛盾。
 *
 * 旧实现 cwd 总是 ccbBinaryDir;新实现 cwd = subprocessCwd ?? ccbBinaryDir
 * (向后兼容:不传 subprocessCwd 时仍用 ccbBinaryDir,不破坏 caller 没改动的
 * 路径)。我们用真 spawn 一个 `node -e 'process.stdout.write(process.cwd())'`,
 * 检查输出 = 期望 cwd —— 比 mock 子进程 / mock spawn 都更稳。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/terminalBackendCwd.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { LocalBackend } from '../terminalBackend.js'

async function captureCwd(spawnOpts: {
  ccbBinaryDir: string
  subprocessCwd?: string
}): Promise<string> {
  const backend = new LocalBackend()
  const proc = backend.spawn({
    command: 'node',
    args: ['-e', 'process.stdout.write(process.cwd())'],
    ccbBinaryDir: spawnOpts.ccbBinaryDir,
    env: { ...process.env } as Record<string, string>,
    stdio: ['pipe', 'pipe', 'pipe'],
    subprocessCwd: spawnOpts.subprocessCwd,
  })
  let out = ''
  proc.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8')
  })
  await new Promise<void>((resolve, reject) => {
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`exit ${code}`))
    })
    proc.on('error', reject)
  })
  return out
}

describe('LocalBackend.spawn cwd resolution', () => {
  it('uses subprocessCwd when provided (Phase 5 GitHub repo binding path)', async () => {
    const ccbDir = await mkdtemp(join(tmpdir(), 'ccb-bin-'))
    const projectDir = await mkdtemp(join(tmpdir(), 'project-'))
    try {
      const cwd = await captureCwd({
        ccbBinaryDir: ccbDir,
        subprocessCwd: projectDir,
      })
      // realpath collapses /var → /private/var on macOS etc.;比较 basename 足够
      assert.equal(cwd, projectDir, 'subprocessCwd must override ccbBinaryDir')
    } finally {
      await rm(ccbDir, { recursive: true, force: true })
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  it('falls back to ccbBinaryDir when subprocessCwd is undefined (backward compat)', async () => {
    const ccbDir = await mkdtemp(join(tmpdir(), 'ccb-bin-'))
    try {
      const cwd = await captureCwd({ ccbBinaryDir: ccbDir })
      assert.equal(cwd, ccbDir, 'cwd must fall back to ccbBinaryDir for legacy callers')
    } finally {
      await rm(ccbDir, { recursive: true, force: true })
    }
  })
})
