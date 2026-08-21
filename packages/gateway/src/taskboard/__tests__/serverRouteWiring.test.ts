/**
 * Taskboard 路由接线一致性:http.ts 已实现的 `/api/board/*` 必须被
 * server.ts 分发白名单认领,否则请求会掉进 SPA 兜底,线上表现为 404 HTML。
 *
 * 这正是 M4 成本统计 / 模板 / 周报逃过门禁的根因:单测直接调 handleTaskboardApi,
 * 绕过了 server.ts 的 pathname 白名单。本文件解析两处源码做集合包含断言,
 * 以后再加路由漏接线会直接红。
 *
 * Run: npx tsx --test packages/gateway/src/taskboard/__tests__/serverRouteWiring.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const httpSrc = readFileSync(join(here, '../http.ts'), 'utf8')
const serverSrc = readFileSync(join(here, '../../server.ts'), 'utf8')
const frontendSrc = readFileSync(
  join(here, '../../../../web-react/src/lib/taskboard.ts'),
  'utf8',
)

interface BoardPatterns {
  exact: string[]
  regexes: RegExp[]
}

function extractExact(source: string, lhs: string): string[] {
  const out: string[] = []
  const re = new RegExp(`${lhs} === '(\\/api\\/board[^']*)'`, 'g')
  for (const m of source.matchAll(re)) out.push(m[1]!)
  return out
}

function extractRegexSources(source: string, lhs: string): string[] {
  const out: string[] = []
  const re = new RegExp(`${lhs}\\.match\\(\\s*\\/(\\^\\\\/api\\\\/board\\\\/[^\n]*?)\\/[a-z]*\\s*[,)]`, 'g')
  for (const m of source.matchAll(re)) out.push(m[1]!)
  return out
}

function sampleFromBoardRegex(src: string): string {
  return src
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/')
    .replaceAll('([^/]+)', 'x')
    .replace(/\([^)]+\)/g, 'x')
}

function parseQuotedList(source: string, constName: string): string[] {
  const block = source.match(new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\] as const`))
  assert.ok(block, `http.ts 必须声明 ${constName}`)
  return [...block[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
}

function implementedHttpSamples(): string[] {
  const exact = extractExact(httpSrc, 'path')
  const regexSrcs = extractRegexSources(httpSrc, 'path')
  const actions = parseQuotedList(httpSrc, 'TICKET_ACTIONS')
  const collections = parseQuotedList(httpSrc, 'TICKET_COLLECTIONS')
  const samples = new Set<string>(exact)
  for (const src of regexSrcs) {
    if (src === '^\\/api\\/board\\/tickets\\/([^/]+)\\/([^/]+)$') {
      for (const sub of [...actions, ...collections]) {
        samples.add(`/api/board/tickets/x/${sub}`)
      }
      continue
    }
    samples.add(sampleFromBoardRegex(src))
  }
  return [...samples].sort()
}

function serverBoardPatterns(): BoardPatterns {
  return {
    exact: extractExact(serverSrc, 'url\\.pathname'),
    regexes: extractRegexSources(serverSrc, 'url\\.pathname').map((s) => new RegExp(s)),
  }
}

function claimedByServer(path: string, patterns: BoardPatterns): boolean {
  if (patterns.exact.includes(path)) return true
  return patterns.regexes.some((re) => re.test(path))
}

function frontendBoardSamples(): string[] {
  const samples = new Set<string>()
  // 静态段:后面若是 `/${` 说明只是动态项前缀(如 /api/board/stages/${id}),不是集合端点。
  for (const m of frontendSrc.matchAll(/\/api\/board(?:\/[A-Za-z0-9:_-]+)+/g)) {
    const next = frontendSrc.slice(m.index! + m[0].length, m.index! + m[0].length + 2)
    if (next === '/$') continue
    samples.add(m[0]!)
  }
  for (const m of frontendSrc.matchAll(/\/api\/board\/([a-z]+)\/\$\{[^}]+\}(\/[a-z]+)?/g)) {
    samples.add(`/api/board/${m[1]!}/x${m[2] ?? ''}`)
  }
  for (const m of frontendSrc.matchAll(/ticketActionPath\([^,]+,\s*'([a-z_]+)'\)/g)) {
    samples.add(`/api/board/tickets/x/${m[1]!}`)
  }
  return [...samples].sort()
}

describe('taskboard http.ts 路由 ⊆ server.ts 分发白名单', () => {
  it('抽取器能看到 M4 新路径与既有路径(哨兵,防止解析被格式改动打瞎)', () => {
    const samples = implementedHttpSamples()
    assert.ok(samples.length >= 20, `http.ts 只抽到 ${samples.length} 条样例,抽取器可能失效`)
    for (const must of [
      '/api/board/projects',
      '/api/board/stats/cost',
      '/api/board/templates',
      '/api/board/templates/x',
      '/api/board/templates/x/apply',
      '/api/board/reports/weekly',
      '/api/board/tickets/x/ready',
      '/api/board/tickets/x/runs',
    ]) {
      assert.ok(samples.includes(must), `http.ts 样例缺少 ${must}: ${samples.join(', ')}`)
    }
    const patterns = serverBoardPatterns()
    assert.ok(
      patterns.exact.includes('/api/board/stats/cost'),
      'server.ts 白名单必须有 url.pathname === \'/api/board/stats/cost\'',
    )
    assert.ok(
      patterns.exact.includes('/api/board/templates'),
      'server.ts 白名单必须有 url.pathname === \'/api/board/templates\'',
    )
    assert.ok(
      patterns.exact.includes('/api/board/reports/weekly'),
      'server.ts 白名单必须有 url.pathname === \'/api/board/reports/weekly\'',
    )
  })

  it('http.ts 已实现的每条路径都能被 server.ts 白名单认领(防 SPA 404)', () => {
    const patterns = serverBoardPatterns()
    const missing = implementedHttpSamples().filter((p) => !claimedByServer(p, patterns))
    assert.deepEqual(
      missing,
      [],
      '以下 taskboard 路由在 http.ts 已实现,但 server.ts 分发白名单未接线;' +
        '线上会掉进前端 SPA 兜底返回 HTML/404:\n  ' +
        missing.join('\n  ') +
        '\n修法:在 packages/gateway/src/server.ts 的 taskboard if 链补 url.pathname === 或 match。',
    )
  })

  it('web-react 实际请求的 /api/board 路径都在 server.ts 白名单内', () => {
    const patterns = serverBoardPatterns()
    const samples = frontendBoardSamples()
    assert.ok(samples.length >= 12, `前端只抽到 ${samples.length} 条 /api/board 路径,抽取器可能失效`)
    for (const must of [
      '/api/board/stats/cost',
      '/api/board/templates',
      '/api/board/templates/x',
      '/api/board/templates/x/apply',
      '/api/board/reports/weekly',
    ]) {
      assert.ok(samples.includes(must), `前端样例缺少 ${must}: ${samples.join(', ')}`)
    }
    const missing = samples.filter((p) => !claimedByServer(p, patterns))
    assert.deepEqual(
      missing,
      [],
      '以下前端路径不在 server.ts taskboard 白名单内,面板会拿到 SPA HTML 而不是 JSON:\n  ' +
        missing.join('\n  '),
    )
  })

  it('metrics KNOWN_ROUTES / normalizePath 覆盖 M4 精确路径与模板动态段', () => {
    assert.ok(
      serverSrc.includes("'/api/board/stats/cost'"),
      'KNOWN_ROUTES 应包含 /api/board/stats/cost,否则 metrics 会塌成 /__other__',
    )
    assert.ok(serverSrc.includes("'/api/board/templates'"))
    assert.ok(serverSrc.includes("'/api/board/reports/weekly'"))
    assert.ok(
      serverSrc.includes("'/api/board/templates/:id/apply'"),
      'normalizePath 应把 /api/board/templates/:id/apply 规整掉,避免高基数',
    )
    assert.ok(serverSrc.includes("'/api/board/templates/:id'"))
  })
})
