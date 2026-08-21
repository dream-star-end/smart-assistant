import { describe, expect, it } from 'vitest'
import { CHAT_CREATE_TEMPLATES } from './chatCreateTemplates'

describe('chat creation templates use engine-specific ask channels', () => {
  it.each(Object.entries(CHAT_CREATE_TEMPLATES))('%s 按引擎选择提问通道', (_kind, template) => {
    expect(template).toContain('AskUserQuestion')
    expect(template).toContain('request_user_input')
    expect(template).toContain('专用问答 UI')
    expect(template).toContain('```options')
    expect(template).toContain('一条回复最多 4 个 options 块')
    expect(template).toContain('同一条回复里的多块会聚合成一次提交')
  })
})

describe('connector chat creation template', () => {
  it('向当前会话提供单文件校验、摘要确认、hash 绑定发布与 AI 审核语义', () => {
    const template = CHAT_CREATE_TEMPLATES.connector
    expect(template).toContain('oc-market plugin examples')
    expect(template).toContain('oc-market plugin validate --file /tmp/openclaude-plugin.json')
    expect(template).toContain('permissionSummary')
    expect(template).toContain('publishCommand')
    expect(template).toContain('重新确认')
    expect(template).toContain('AI 自动审核')
    expect(template).toContain('管理中心 → 插件')
    expect(template).toContain('市场 → 发现')
    expect(template).not.toContain('--security-decision-file')
    expect(template).not.toContain('平台人工审核')
    expect(template).not.toContain('packages/commercial/src/connectors')
  })
})
