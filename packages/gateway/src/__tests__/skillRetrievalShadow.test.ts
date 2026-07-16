import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { type SkillMetadata, searchSkillMetadata } from '@openclaude/storage'

import {
  SKILL_SHADOW_ROUTES,
  compactSkillShadowRankings,
  deriveSkillQueries,
  rankBm25MultiQuery,
  rankCharNgram,
  rankExistingKeywordFallback,
  rankZhLexical,
  runSkillShadowRankers,
  scoreSkillShadowRecall,
  tokenizeZhAware,
} from '../skillRetrievalShadow.js'

function skill(
  name: string,
  description: string,
  tags: string[] = [],
  related_skills: string[] = [],
): SkillMetadata {
  return {
    name,
    description,
    tags,
    related_skills,
    path: `/skills/${name}`,
    source: 'platform',
    layer: 'platform',
    writable: false,
    agentIds: ['main'],
  }
}

const catalog = [
  skill('office-spreadsheet', '创建、分析和交付 Excel XLSX 电子表格、销售报表与数据透视表', [
    'excel',
    'xlsx',
    '表格',
    '报表',
  ]),
  skill(
    'coding-suite',
    'Debug TypeScript code, run tests, refactor repositories and review changes',
    ['coding', 'debug', 'typescript', 'tests'],
  ),
  skill('web-context', 'Extract content from websites, URLs, PDF and office documents', [
    'web',
    'url',
    'pdf',
  ]),
  skill('scientific-figures', '为论文和科研报告绘制可发表的统计图、折线图与科学可视化', [
    'research',
    'plot',
    '论文',
    '科研',
  ]),
  skill('scheduled-tasks', 'Create recurring reminders and cron schedules', ['cron', 'reminder']),
]

function names(items: Array<{ name: string }>): string[] {
  return items.map((item) => item.name)
}

describe('skill retrieval shadow rankers', () => {
  test('existing route is the current deterministic skill_search fallback unchanged', () => {
    const query = 'debug TypeScript tests'
    assert.deepEqual(
      rankExistingKeywordFallback(catalog, query),
      searchSkillMetadata(catalog, query, 5).map((item) => ({
        name: item.name,
        score: item.score,
      })),
    )
  })

  test('Chinese-aware lexical route handles Chinese punctuation and word boundaries', () => {
    const tokens = tokenizeZhAware('请生成：Excel 销售报表（含数据透视表）')
    assert.ok(tokens.includes('excel'))
    assert.ok(tokens.some((token) => token.includes('报表')))
    assert.equal(
      rankZhLexical(catalog, '请生成：Excel 销售报表（含数据透视表）')[0]?.name,
      'office-spreadsheet',
    )
  })

  test('English query ranks the coding skill in every route', () => {
    const routes = runSkillShadowRankers(catalog, 'Debug the failing TypeScript tests in my repo')
    for (const route of SKILL_SHADOW_ROUTES) {
      assert.equal(routes[route][0]?.name, 'coding-suite', route)
      assert.ok(routes[route].length <= 5)
    }
  })

  test('mixed Chinese/English query is robust in n-gram and BM25 routes', () => {
    const query = '把销售数据 export 成 Excel/XLSX 表格报表'
    assert.equal(rankCharNgram(catalog, query)[0]?.name, 'office-spreadsheet')
    assert.equal(rankBm25MultiQuery(catalog, query)[0]?.name, 'office-spreadsheet')
  })

  test('BM25 derives two or three deterministic queries without a model', () => {
    const queries = deriveSkillQueries('请帮我把论文数据画成 scientific figure')
    assert.ok(queries.length >= 2 && queries.length <= 3)
    assert.match(queries.at(-1) ?? '', /research|paper|论文/)
    assert.deepEqual(queries, deriveSkillQueries('请帮我把论文数据画成 scientific figure'))
  })

  test('wire compaction stores only top-five names', () => {
    const routes = runSkillShadowRankers(catalog, 'PDF 里的表格 export to Excel')
    const compact = compactSkillShadowRankings(routes)
    assert.deepEqual(Object.keys(compact), [...SKILL_SHADOW_ROUTES])
    for (const route of SKILL_SHADOW_ROUTES) {
      assert.ok(compact[route].length <= 5)
      assert.deepEqual(compact[route], names(routes[route]).slice(0, 5))
    }
  })

  test('shared metric computes real set recall when a turn uses multiple skills', () => {
    const routes = runSkillShadowRankers(catalog, 'PDF 里的表格 export to Excel')
    const metric = scoreSkillShadowRecall(routes, ['office-spreadsheet', 'scheduled-tasks'])
    for (const route of SKILL_SHADOW_ROUTES) {
      assert.equal(metric[route].actualCount, 2, route)
      assert.equal(metric[route].hitsAt3, 1, route)
      assert.equal(metric[route].recallAt3, 0.5, route)
      assert.ok(metric[route].recallAt5 >= metric[route].recallAt3, route)
    }
  })
})
