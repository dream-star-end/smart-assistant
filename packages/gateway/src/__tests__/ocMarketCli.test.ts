/**
 * oc-market CLI endpoint resolution tests.
 * Run: npx tsx --test packages/gateway/src/__tests__/ocMarketCli.test.ts
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  buildPublishAgentRequest,
  buildPublishSkillRequest,
  resolveLocalGatewayBase,
  resolveMarketplaceEndpoint,
  splitList,
} from '../ocMarketCli.js'

function reader(files: Record<string, string>) {
  return (path: string) => {
    const v = files[path]
    if (v === undefined) throw new Error(`missing ${path}`)
    return v
  }
}

describe('ocMarketCli endpoint resolution', () => {
  test('uses direct master endpoint when master base and token are present', () => {
    const ep = resolveMarketplaceEndpoint({
      OPENCLAUDE_V3_MASTER_BASE_URL: 'http://172.31.0.1:18892///',
      OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.1.secret',
      HOME: '/home/agent',
    })
    assert.deepEqual(ep, {
      baseUrl: 'http://172.31.0.1:18892/internal/v3/marketplace/agent',
      token: 'oc-v3.1.secret',
      mode: 'master',
    })
  })

  test('falls back to local gateway config when OPENCLAUDE_* env is scrubbed', () => {
    const readFile = reader({
      '/home/agent/.openclaude/openclaude.json': JSON.stringify({ gateway: { port: 18789 } }),
    }) as any
    assert.equal(
      resolveLocalGatewayBase({ HOME: '/home/agent' }, readFile),
      'http://127.0.0.1:18789/internal/v3/marketplace/agent-local',
    )
    assert.deepEqual(resolveMarketplaceEndpoint({ HOME: '/home/agent' }, readFile), {
      baseUrl: 'http://127.0.0.1:18789/internal/v3/marketplace/agent-local',
      mode: 'local',
    })
  })

  test('OPENCLAUDE_HOME wins over HOME for local gateway config', () => {
    const readFile = reader({
      '/custom/openclaude.json': JSON.stringify({ gateway: { port: '19999' } }),
    }) as any
    assert.equal(
      resolveLocalGatewayBase({ OPENCLAUDE_HOME: '/custom', HOME: '/home/agent' }, readFile),
      'http://127.0.0.1:19999/internal/v3/marketplace/agent-local',
    )
  })
})

describe('splitList', () => {
  test('comma-splits tags with trim + empty filter', () => {
    assert.deepEqual(splitList(' 翻译 , 学术 ,, ', ','), ['翻译', '学术'])
  })
  test('semicolon-splits so sentences may contain commas', () => {
    assert.deepEqual(splitList('把中文论文, 译成英文; 校对术语', ';'), [
      '把中文论文, 译成英文',
      '校对术语',
    ])
  })
  test('missing / empty value → []', () => {
    assert.deepEqual(splitList(undefined, ';'), [])
    assert.deepEqual(splitList('  ;  ; ', ';'), [])
  })
})

describe('buildPublishSkillRequest — storefront metadata mapping', () => {
  test('maps category / use-cases / outcomes / intro into the request body', () => {
    const flags = {
      slug: 'my-skill',
      name: '学术翻译',
      version: '1.0.0',
      description: '把中文论文译成地道英文',
      category: 'research-academic',
      tags: '翻译,学术',
      'use-cases': '把中文论文译成英文; 润色已有英文摘要',
      outcomes: '给它一段中文摘要, 得到地道英文; 给它术语表, 保留专有名词',
    }
    const req = buildPublishSkillRequest(flags, 'BODY', 'RICH INTRO')
    assert.equal(req.kind, 'skill')
    assert.equal(req.category, 'research-academic')
    assert.deepEqual(req.tags, ['翻译', '学术'])
    assert.deepEqual(req.useCases, ['把中文论文译成英文', '润色已有英文摘要'])
    assert.deepEqual(req.outcomeExamples, [
      '给它一段中文摘要, 得到地道英文',
      '给它术语表, 保留专有名词',
    ])
    assert.equal(req.humanMd, 'RICH INTRO')
    assert.equal(req.body, 'BODY')
  })

  test('omits humanMd key entirely when no intro file provided', () => {
    const req = buildPublishSkillRequest(
      { category: 'office-docs', 'use-cases': '做一份周报 PPT' },
      'BODY',
      undefined,
    )
    assert.ok(!('humanMd' in req), 'humanMd should be absent, not undefined')
    assert.deepEqual(req.useCases, ['做一份周报 PPT'])
    assert.deepEqual(req.outcomeExamples, [])
  })
})

describe('buildPublishAgentRequest — storefront metadata mapping', () => {
  test('carries category/useCases/outcomes/humanMd alongside agent fields', () => {
    const flags = {
      slug: 'writer',
      name: '写作助手',
      model: 'glm-5.2',
      toolsets: 'core, web_context',
      'skill-deps': 'academic-translate',
      category: 'office-docs',
      'use-cases': '润色中文稿件; 把要点扩写成成文',
      outcomes: '给它要点, 得到成文',
    }
    const req = buildPublishAgentRequest(flags, 'PERSONA', 'INTRO')
    assert.equal(req.kind, 'agent')
    assert.equal(req.model, 'glm-5.2')
    assert.deepEqual(req.toolsets, ['core', 'web_context'])
    assert.deepEqual(req.skillDeps, ['academic-translate'])
    assert.equal(req.category, 'office-docs')
    assert.deepEqual(req.useCases, ['润色中文稿件', '把要点扩写成成文'])
    assert.deepEqual(req.outcomeExamples, ['给它要点, 得到成文'])
    assert.equal(req.humanMd, 'INTRO')
    assert.equal(req.persona, 'PERSONA')
  })
})
