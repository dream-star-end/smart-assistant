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
  it('returns 仓库 + none when no selection', () => {
    assert.deepEqual(formatRepoLabel(null), { label: '仓库', dot: 'none' })
    assert.deepEqual(formatRepoLabel(undefined), { label: '仓库', dot: 'none' })
    assert.deepEqual(formatRepoLabel({ selected: false }), {
      label: '仓库',
      dot: 'none',
    })
  })

  it('renders ready selection without suffix', () => {
    const sel = {
      selected: true,
      owner: 'octo',
      repo: 'demo',
      branch: 'main',
      status: 'ready',
    }
    assert.deepEqual(formatRepoLabel(sel), {
      label: 'octo/demo @ main',
      dot: 'ready',
    })
  })

  it('renders cloning state with 克隆中 suffix', () => {
    const sel = {
      selected: true,
      owner: 'octo',
      repo: 'demo',
      branch: 'main',
      status: 'cloning',
    }
    assert.deepEqual(formatRepoLabel(sel), {
      label: 'octo/demo @ main · 克隆中',
      dot: 'cloning',
    })
  })

  it('renders failed state with 失败 suffix', () => {
    const sel = {
      selected: true,
      owner: 'octo',
      repo: 'demo',
      branch: 'feature/x',
      status: 'failed',
    }
    assert.deepEqual(formatRepoLabel(sel), {
      label: 'octo/demo @ feature/x · 失败',
      dot: 'failed',
    })
  })

  it('renders pending state with 准备中 suffix', () => {
    const sel = {
      selected: true,
      owner: 'octo',
      repo: 'demo',
      branch: 'main',
      status: 'pending',
    }
    assert.deepEqual(formatRepoLabel(sel), {
      label: 'octo/demo @ main · 准备中',
      dot: 'pending',
    })
  })

  it('treats unknown status as pending fallback', () => {
    const sel = {
      selected: true,
      owner: 'octo',
      repo: 'demo',
      branch: 'main',
      status: 'whatever',
    }
    assert.deepEqual(formatRepoLabel(sel), {
      label: 'octo/demo @ main · 准备中',
      dot: 'pending',
    })
  })
})
