import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Phase 6 — github.js pure-helper tests.
 *
 * github.js imports browser-only modules (api/dom/state/ui/websocket), so we
 * can't `import` it directly under tsx/node. Instead we extract the source of
 * the two pure helpers (`githubErrorText`, `formatRepoLabel`) and eval them.
 * Pattern matches pureFunctions.test.ts.
 */

const PUBLIC = resolve(import.meta.dirname, '..', 'public')
const githubSrc = readFileSync(resolve(PUBLIC, 'modules', 'github.js'), 'utf-8')

function extractFn(name: string): string {
  const re = new RegExp(`export function ${name}\\s*\\([^)]*\\)\\s*\\{`)
  const m = githubSrc.match(re)
  if (!m || m.index == null) throw new Error(`function ${name} not found`)
  // Find matching close brace at the same indent level (column 0).
  const start = m.index
  const lines = githubSrc.slice(start).split('\n')
  const collected: string[] = []
  for (let i = 0; i < lines.length; i++) {
    collected.push(lines[i])
    if (i > 0 && lines[i] === '}') break
  }
  return collected.join('\n').replace(/^export\s+/, '')
}

const githubErrorText = new Function(
  `${extractFn('githubErrorText')}; return githubErrorText`,
)() as (code: string | null | undefined) => string

const formatRepoLabel = new Function(
  `${extractFn('formatRepoLabel')}; return formatRepoLabel`,
)() as (sel: any) => { label: string; dot: string }

const formatBannerState = new Function(
  `${extractFn('formatBannerState')}; return formatBannerState`,
)() as (sel: any) =>
  | { phase: string; text: string; name: string; showProgress: boolean }
  | null

const estimateCloningProgress = new Function(
  `${extractFn('estimateCloningProgress')}; return estimateCloningProgress`,
)() as (startTime: number, now: number) => number

// ── Version-gate state machine ──
// _knownVersion 是模块私有 Map,_getKnownVersion / _bumpKnownVersion 是
// 模块私有 helper。为了可测,这里把 Map 声明 + 两个 helper 一起 eval 进
// 一个共享 closure,然后暴露查询/写入接口。
function buildVersionGate() {
  const setupSrc = `
    ${extractMapDecl()}
    ${extractFnLocal('_getKnownVersion')}
    ${extractFnLocal('_bumpKnownVersion')}
    return {
      bump: _bumpKnownVersion,
      get: _getKnownVersion,
      setSentinel: (sid) => _knownVersion.set(sid, Number.POSITIVE_INFINITY),
      sentinelOverride: (sid, ver) => _knownVersion.set(sid, ver),
    }
  `
  return new Function(setupSrc)() as {
    bump: (sid: string, ver: number) => void
    get: (sid: string) => number
    setSentinel: (sid: string) => void
    sentinelOverride: (sid: string, ver: number) => void
  }
}

function extractMapDecl(): string {
  // const _knownVersion = new Map()
  const m = githubSrc.match(/const _knownVersion = new Map\(\)/)
  if (!m) throw new Error('_knownVersion declaration not found')
  return m[0]
}

function extractFnLocal(name: string): string {
  // function fooName(args) { ... }
  const re = new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`)
  const m = githubSrc.match(re)
  if (!m || m.index == null) throw new Error(`function ${name} not found`)
  const start = m.index
  const lines = githubSrc.slice(start).split('\n')
  const collected: string[] = []
  for (let i = 0; i < lines.length; i++) {
    collected.push(lines[i])
    if (i > 0 && lines[i] === '}') break
  }
  return collected.join('\n')
}

describe('version-gate (_getKnownVersion + _bumpKnownVersion)', () => {
  it('returns -1 for unknown session', () => {
    const g = buildVersionGate()
    assert.equal(g.get('unknown'), -1)
  })

  it('bumps to higher version', () => {
    const g = buildVersionGate()
    g.bump('s1', 3)
    assert.equal(g.get('s1'), 3)
    g.bump('s1', 5)
    assert.equal(g.get('s1'), 5)
  })

  it('does not roll back on lower version', () => {
    const g = buildVersionGate()
    g.bump('s1', 7)
    g.bump('s1', 3)
    assert.equal(g.get('s1'), 7)
  })

  it('ignores non-finite or non-number ver', () => {
    const g = buildVersionGate()
    g.bump('s1', NaN as unknown as number)
    g.bump('s1', 'abc' as unknown as number)
    g.bump('s1', Number.POSITIVE_INFINITY)
    assert.equal(g.get('s1'), -1)
  })

  it('sentinel +Infinity is not regressed by normal version', () => {
    const g = buildVersionGate()
    g.setSentinel('s1')
    assert.equal(g.get('s1'), Number.POSITIVE_INFINITY)
    g.bump('s1', 99) // should be no-op since cur === Infinity
    assert.equal(g.get('s1'), Number.POSITIVE_INFINITY)
  })

  it('explicit set (e.g. GET response) can override sentinel', () => {
    const g = buildVersionGate()
    g.setSentinel('s1')
    // simulating refreshGithubPill GET path: _knownVersion.set(sid, ver) directly
    g.sentinelOverride('s1', 4)
    assert.equal(g.get('s1'), 4)
  })

  it('per-session isolation', () => {
    const g = buildVersionGate()
    g.bump('a', 5)
    g.bump('b', 2)
    assert.equal(g.get('a'), 5)
    assert.equal(g.get('b'), 2)
  })

  it('bind_error sentinel blocks same-version delayed status frame (regression)', () => {
    // 复现 Codex review 提出的 race:
    // PUT 后 known=ver=5。bind_error 来,handleRepoBindErrorFrame 把 known
    // 升到 +Infinity。然后 selection_version=5 的延迟 status 帧到达 ——
    // _bumpKnownVersion 必须 noop(`cur === Infinity` 短路),否则 caller 用
    // `known > ver` 判定时会接受同版本帧,把已清的 UI 复活。
    const g = buildVersionGate()
    g.bump('s1', 5) // PUT 成功
    g.setSentinel('s1') // 模拟 bind_error
    assert.equal(g.get('s1'), Number.POSITIVE_INFINITY)
    g.bump('s1', 5) // 同版本延迟 status
    assert.equal(g.get('s1'), Number.POSITIVE_INFINITY)
    g.bump('s1', 6) // 哪怕新版本也得等 PUT/GET 显式覆盖
    assert.equal(g.get('s1'), Number.POSITIVE_INFINITY)
  })
})

describe('githubErrorText', () => {
  it('translates known error codes', () => {
    const cases: Array<[string, string]> = [
      ['GITHUB_NOT_LINKED', '请先连接 GitHub 账号'],
      ['GITHUB_TOKEN_INVALID', 'GitHub token 已失效,已自动解绑,请重新连接'],
      ['GITHUB_REPO_NOT_FOUND', '仓库不存在或无访问权限'],
      ['GITHUB_BRANCH_NOT_FOUND', '分支不存在'],
      ['GITHUB_REPO_NO_WRITE', '你对该仓库没有写权限'],
      ['GITHUB_UPSTREAM_FORBIDDEN', 'GitHub 拒绝请求(限流或 SSO 授权问题)'],
      ['GITHUB_NETWORK', 'GitHub 网络错误,稍后重试'],
      ['STALE_OR_MISSING', '仓库选择已变更,请重新选择'],
      ['INVALID_BIND_PAYLOAD', '请求格式异常,请重新选择仓库'],
      ['INVALID_REF', '仓库名 / 分支名包含非法字符'],
      ['INVALID_SESSION_ID', '会话 ID 异常'],
      ['INVALID_VERSION', '版本号异常'],
      ['token_invalid', 'GitHub token 已失效,会话已自动解绑'],
      ['token_write_failed', '写入凭证失败,请重试'],
    ]
    for (const [code, expected] of cases) {
      assert.equal(githubErrorText(code), expected, `code=${code}`)
    }
  })

  it('falls back to code itself for unknown codes', () => {
    assert.equal(githubErrorText('SOMETHING_WEIRD'), 'SOMETHING_WEIRD')
  })

  it('returns generic 未知错误 for null / undefined / empty', () => {
    assert.equal(githubErrorText(null), '未知错误')
    assert.equal(githubErrorText(undefined), '未知错误')
    assert.equal(githubErrorText(''), '未知错误')
  })
})

describe('formatRepoLabel', () => {
  // 状态文字(准备中/克隆中/失败)已移到 #repo-progress-banner;pill 只剩仓库名 + 颜色点。
  it('returns 仓库 + none when no selection', () => {
    assert.deepEqual(formatRepoLabel(null), { label: '仓库', dot: 'none' })
    assert.deepEqual(formatRepoLabel(undefined), { label: '仓库', dot: 'none' })
    assert.deepEqual(formatRepoLabel({ selected: false }), {
      label: '仓库',
      dot: 'none',
    })
  })

  it('renders ready selection — name only, ready dot', () => {
    assert.deepEqual(
      formatRepoLabel({ selected: true, owner: 'octo', repo: 'demo', branch: 'main', status: 'ready' }),
      { label: 'octo/demo @ main', dot: 'ready' },
    )
  })

  it('renders cloning — name only, cloning dot (no 克隆中 suffix)', () => {
    assert.deepEqual(
      formatRepoLabel({ selected: true, owner: 'octo', repo: 'demo', branch: 'main', status: 'cloning' }),
      { label: 'octo/demo @ main', dot: 'cloning' },
    )
  })

  it('renders failed — name only, failed dot', () => {
    assert.deepEqual(
      formatRepoLabel({ selected: true, owner: 'octo', repo: 'demo', branch: 'feature/x', status: 'failed' }),
      { label: 'octo/demo @ feature/x', dot: 'failed' },
    )
  })

  it('renders pending — name only, pending dot', () => {
    assert.deepEqual(
      formatRepoLabel({ selected: true, owner: 'octo', repo: 'demo', branch: 'main', status: 'pending' }),
      { label: 'octo/demo @ main', dot: 'pending' },
    )
  })

  it('treats unknown status as pending fallback', () => {
    assert.deepEqual(
      formatRepoLabel({ selected: true, owner: 'octo', repo: 'demo', branch: 'main', status: 'whatever' }),
      { label: 'octo/demo @ main', dot: 'pending' },
    )
  })
})

describe('formatBannerState', () => {
  it('returns null when no selection', () => {
    assert.equal(formatBannerState(null), null)
    assert.equal(formatBannerState(undefined), null)
    assert.equal(formatBannerState({ selected: false }), null)
  })

  it('pending — 准备中…, no progress', () => {
    assert.deepEqual(
      formatBannerState({ selected: true, owner: 'octo', repo: 'demo', branch: 'main', status: 'pending' }),
      { phase: 'pending', text: '准备中…', name: 'octo/demo @ main', showProgress: false },
    )
  })

  it('cloning — 克隆中, with progress', () => {
    assert.deepEqual(
      formatBannerState({ selected: true, owner: 'octo', repo: 'demo', branch: 'main', status: 'cloning' }),
      { phase: 'cloning', text: '克隆中', name: 'octo/demo @ main', showProgress: true },
    )
  })

  it('ready — 已就绪, no progress', () => {
    assert.deepEqual(
      formatBannerState({ selected: true, owner: 'octo', repo: 'demo', branch: 'main', status: 'ready' }),
      { phase: 'ready', text: '已就绪', name: 'octo/demo @ main', showProgress: false },
    )
  })

  it('failed — 克隆失败, no progress', () => {
    assert.deepEqual(
      formatBannerState({ selected: true, owner: 'octo', repo: 'demo', branch: 'feature/x', status: 'failed' }),
      { phase: 'failed', text: '克隆失败', name: 'octo/demo @ feature/x', showProgress: false },
    )
  })

  it('treats unknown status as pending fallback', () => {
    assert.deepEqual(
      formatBannerState({ selected: true, owner: 'octo', repo: 'demo', branch: 'main', status: 'whatever' }),
      { phase: 'pending', text: '准备中…', name: 'octo/demo @ main', showProgress: false },
    )
  })
})

describe('estimateCloningProgress', () => {
  it('returns 0 at startTime (t=0)', () => {
    const start = 1_000_000_000
    assert.equal(estimateCloningProgress(start, start), 0)
  })

  it('monotonically non-decreasing', () => {
    const start = 1_000_000_000
    let prev = -1
    for (let dt = 0; dt <= 60_000; dt += 500) {
      const pct = estimateCloningProgress(start, start + dt)
      assert.ok(pct >= prev, `pct should be ≥ prev (dt=${dt}, pct=${pct}, prev=${prev})`)
      prev = pct
    }
  })

  it('caps at 90% (never reaches 100% from elapsed alone)', () => {
    const start = 1_000_000_000
    // 10 minutes — far past the 30s window
    assert.ok(estimateCloningProgress(start, start + 600_000) <= 90)
    assert.ok(estimateCloningProgress(start, start + 60_000) <= 90)
  })

  it('eased curve: ~60% at 15s, ~80% at 30s', () => {
    const start = 1_000_000_000
    const at15 = estimateCloningProgress(start, start + 15_000)
    const at30 = estimateCloningProgress(start, start + 30_000)
    // 90 * (1 - exp(-1.1)) ≈ 60, 90 * (1 - exp(-2.2)) ≈ 80
    assert.ok(at15 >= 55 && at15 <= 65, `at15s ≈ 60, got ${at15}`)
    assert.ok(at30 >= 75 && at30 <= 85, `at30s ≈ 80, got ${at30}`)
  })

  it('clamps to 0 for negative elapsed (clock skew safe)', () => {
    const start = 1_000_000_000
    assert.equal(estimateCloningProgress(start, start - 5_000), 0)
  })

  it('returns 0 for non-finite inputs', () => {
    assert.equal(estimateCloningProgress(NaN, 1000), 0)
    assert.equal(estimateCloningProgress(1000, NaN), 0)
    assert.equal(estimateCloningProgress(Infinity, 1000), 0)
    assert.equal(estimateCloningProgress(undefined as unknown as number, 1000), 0)
  })
})
