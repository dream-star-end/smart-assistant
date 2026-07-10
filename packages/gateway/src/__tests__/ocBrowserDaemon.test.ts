import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { buildPlaywrightMcpTransportParams } from '../ocBrowserDaemon.js'
import { ocBrowserOutputRoot, ocBrowserUserDataDir } from '../ocBrowserShared.js'

// 临时改 OPENCLAUDE_HOME 跑 fn,结束后恢复原值(含 undefined)。
function withHome<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.OPENCLAUDE_HOME
  if (value === undefined) delete process.env.OPENCLAUDE_HOME
  else process.env.OPENCLAUDE_HOME = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.OPENCLAUDE_HOME
    else process.env.OPENCLAUDE_HOME = prev
  }
}

describe('ocBrowserOutputRoot — 权威源 OPENCLAUDE_HOME + 兜底', () => {
  it('OPENCLAUDE_HOME 已设 → 返回其 trim 值', () => {
    assert.equal(withHome('  /home/agent/.openclaude  ', ocBrowserOutputRoot), '/home/agent/.openclaude')
    assert.equal(withHome('/mnt/vol/.openclaude', ocBrowserOutputRoot), '/mnt/vol/.openclaude')
  })
  it('OPENCLAUDE_HOME 未设 → 兜底 /home/agent/.openclaude', () =>
    assert.equal(withHome(undefined, ocBrowserOutputRoot), '/home/agent/.openclaude'))
  it('OPENCLAUDE_HOME 空白串 → 兜底(视作未设)', () =>
    assert.equal(withHome('   ', ocBrowserOutputRoot), '/home/agent/.openclaude'))
})

describe('buildPlaywrightMcpTransportParams — spawn 参数', () => {
  it('command=npx,args 含固定浏览器 flags + per-agent user-data-dir', () => {
    const p = withHome(undefined, () => buildPlaywrightMcpTransportParams('team-lead'))
    assert.equal(p.command, 'npx')
    assert.deepEqual(p.args?.slice(0, 2), ['--no-install', '@playwright/mcp'])
    // 关键浏览器 flags 原样保留(现网 chromium 通道修复不能回退)。
    for (const flag of ['--browser', 'chromium', '--headless', '--no-sandbox', '--user-data-dir']) {
      assert.ok(p.args?.includes(flag), `args 应包含 ${flag}`)
    }
    // --user-data-dir 紧跟 per-agent 目录。
    const udIdx = p.args?.indexOf('--user-data-dir') ?? -1
    assert.ok(udIdx >= 0)
    assert.equal(p.args?.[udIdx + 1], ocBrowserUserDataDir('team-lead'))
  })

  it('env 透传 PLAYWRIGHT_BROWSERS_PATH(镜像浏览器缓存)', () => {
    const p = withHome(undefined, () => buildPlaywrightMcpTransportParams('main'))
    assert.equal(typeof p.env?.PLAYWRIGHT_BROWSERS_PATH, 'string')
    assert.ok((p.env?.PLAYWRIGHT_BROWSERS_PATH?.length ?? 0) > 0)
  })

  it('cwd = OPENCLAUDE_HOME 当该目录存在(allowed roots 含 generated/ 的父)', () => {
    const realHome = mkdtempSync(join(tmpdir(), 'ocbrowser-home-'))
    try {
      const p = withHome(realHome, () => buildPlaywrightMcpTransportParams('main'))
      assert.equal(p.cwd, realHome)
    } finally {
      rmSync(realHome, { recursive: true, force: true })
    }
  })

  it('cwd 省略当 OPENCLAUDE_HOME 目录不存在 → 回落继承 daemon cwd 的旧行为', () => {
    const missing = join(tmpdir(), `ocbrowser-missing-${process.pid}-${Date.now()}`)
    const p = withHome(missing, () => buildPlaywrightMcpTransportParams('main'))
    assert.ok(!('cwd' in p), 'cwd 不应作为 key 出现(存在性检查失败时省略)')
  })

  it('cwd 省略当默认根 /home/agent/.openclaude 不存在(测试宿主机非容器)', () => {
    // 记录容器/宿主差异:容器内 entrypoint mkdir 保证存在 → 会带 cwd;宿主机无此
    // 目录 → 省略。两条分支都由上面的存在性用例覆盖,这里断言宿主机默认分支。
    const p = withHome(undefined, () => buildPlaywrightMcpTransportParams('main'))
    assert.ok(!('cwd' in p))
  })
})
