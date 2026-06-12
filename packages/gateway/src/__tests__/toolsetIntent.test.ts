import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  detectBrowserToolsetIntent,
  detectWebContextToolsetIntent,
  extractToolsetIntentText,
  mergeOnDemandToolsets,
} from '../toolsetIntent.js'

const config: any = {
  toolsets: {
    core: [],
    browser: ['browser'],
    research: ['scansci-pdf', 'web-context'],
    web_context: ['web-context'],
  },
}

describe('toolset on-demand intent', () => {
  it('adds browser toolset for explicit interactive browser intent', () => {
    assert.equal(detectBrowserToolsetIntent('打开网页 https://example.com 并点击登录'), true)
    assert.equal(detectWebContextToolsetIntent('打开网页 https://example.com 并点击登录'), true)
    assert.deepEqual(
      mergeOnDemandToolsets(['core'], config, '打开网页 https://example.com 并点击登录'),
      ['core', 'browser'],
    )
  })

  it('adds web_context for URL/data extraction intent without mounting browser', () => {
    assert.equal(detectBrowserToolsetIntent('帮我读取这个链接 https://example.com/report'), false)
    assert.equal(detectWebContextToolsetIntent('帮我读取这个链接 https://example.com/report'), true)
    assert.deepEqual(
      mergeOnDemandToolsets(['core'], config, '帮我读取这个链接 https://example.com/report'),
      ['core', 'web_context'],
    )
  })

  it('falls back to research toolset when web_context is not configured', () => {
    const oldConfig: any = {
      toolsets: { core: [], browser: ['browser'], research: ['scansci-pdf', 'web-context'] },
    }
    assert.deepEqual(mergeOnDemandToolsets(['core'], oldConfig, '爬取 https://example.com/data'), [
      'core',
      'research',
    ])
  })

  it('does not auto-enable research or browser for generic search/paper requests', () => {
    assert.equal(detectBrowserToolsetIntent('帮我搜索最新论文'), false)
    assert.deepEqual(mergeOnDemandToolsets(['core'], config, '帮我搜索最新论文'), ['core'])
    assert.deepEqual(mergeOnDemandToolsets(['core'], config, '10.1038/nature12373'), ['core'])
  })

  it('ignores hidden paper hints when deciding browser toolset intent', () => {
    const hintedPaperText = [
      '10.1038/nature12373',
      '',
      '---',
      '【OpenClaude 论文任务系统提示】',
      '不要输出 ScanSci 配置、Cookie、Token、browser_state、代理或机构登录敏感信息；隐身浏览器/WebVPN 相关请求先做状态检测。',
    ].join('\\n')
    assert.equal(detectBrowserToolsetIntent(hintedPaperText), false)
    assert.deepEqual(mergeOnDemandToolsets(['core'], config, hintedPaperText), ['core'])
  })

  it('only inspects the raw user goal inside agent team prompts', () => {
    const teamPrompt = [
      '# Agent Team Run',
      '',
      '## 协作规则',
      '- 不要假设浏览器工具已挂载；只有当前工具列表明确包含 browser 时才访问网页。',
      '- 需要外部检索时再说明缺口。',
      '',
      '## 用户目标',
      '帮我整理这个项目的测试计划',
    ].join('\n')
    assert.equal(extractToolsetIntentText(teamPrompt), '帮我整理这个项目的测试计划')
    assert.equal(detectBrowserToolsetIntent(teamPrompt), false)
    assert.equal(detectWebContextToolsetIntent(teamPrompt), false)
    assert.deepEqual(mergeOnDemandToolsets(['core'], config, teamPrompt), ['core'])
  })

  it('still enables browser when the team user goal explicitly asks for browser actions', () => {
    const teamPrompt = [
      '# Agent Team Run',
      '',
      '## 协作规则',
      '- 普通协作说明里可能出现 browser 字样。',
      '',
      '## 用户目标',
      '打开网页 https://example.com 并点击登录',
    ].join('\n')
    assert.equal(detectBrowserToolsetIntent(teamPrompt), true)
    assert.deepEqual(mergeOnDemandToolsets(['core'], config, teamPrompt), ['core', 'browser'])
  })

  it('leaves ordinary chat on the base core toolset', () => {
    assert.deepEqual(mergeOnDemandToolsets(['core'], config, '今天吃什么？'), ['core'])
  })

  it('preserves legacy all-tools behavior when no base toolsets are configured', () => {
    assert.equal(
      mergeOnDemandToolsets(undefined, config, '打开网页 https://example.com'),
      undefined,
    )
    assert.equal(mergeOnDemandToolsets([], config, '打开网页 https://example.com'), undefined)
  })
})
