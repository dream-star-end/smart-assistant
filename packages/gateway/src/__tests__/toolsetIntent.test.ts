import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { detectBrowserToolsetIntent, mergeOnDemandToolsets } from '../toolsetIntent.js'

const config: any = {
  toolsets: {
    core: [],
    browser: ['browser'],
    research: ['scansci-pdf'],
  },
}

describe('toolset on-demand intent', () => {
  it('adds browser toolset for explicit interactive browser intent', () => {
    assert.equal(detectBrowserToolsetIntent('打开网页 https://example.com 并点击登录'), true)
    assert.deepEqual(
      mergeOnDemandToolsets(['core'], config, '打开网页 https://example.com 并点击登录'),
      ['core', 'browser'],
    )
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

  it('leaves ordinary chat on the base core toolset', () => {
    assert.deepEqual(mergeOnDemandToolsets(['core'], config, '今天吃什么？'), ['core'])
  })

  it('preserves legacy all-tools behavior when no base toolsets are configured', () => {
    assert.equal(mergeOnDemandToolsets(undefined, config, '打开网页 https://example.com'), undefined)
    assert.equal(mergeOnDemandToolsets([], config, '打开网页 https://example.com'), undefined)
  })
})
