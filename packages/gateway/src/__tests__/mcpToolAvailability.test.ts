import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collectAvailableMcpToolNames } from '../server.js'

const baseConfig: any = {
  version: 1,
  gateway: { bind: '127.0.0.1', port: 1, accessToken: 'x' },
  auth: { mode: 'subscription', claudeCodePath: '/tmp/ccb' },
  defaults: { model: 'deepseek-v4-pro', permissionMode: 'default' },
  channels: { webchat: { enabled: true } },
  mcpServers: [],
}

describe('collectAvailableMcpToolNames', () => {
  it('catalog vision override 驱动动态模型的 upload/tool hint', () => {
    const tools = collectAvailableMcpToolNames(
      baseConfig,
      { id: 'main', provider: 'unknown' } as any,
      'dynamic-model',
      { modelSupportsVision: false, resolveVisionEntry: () => '/vision' },
    )
    assert.ok(tools.includes('understand_image'))
  })
  it('includes built-in openclaude-vision understand_image by default', () => {
    const tools = collectAvailableMcpToolNames(baseConfig, { id: 'main' } as any)
    assert.ok(tools.includes('understand_image'))
  })

  it('does not advertise built-in vision if the MCP entry is missing', () => {
    const tools = collectAvailableMcpToolNames(baseConfig, { id: 'main' } as any, undefined, {
      resolveVisionEntry: () => null,
    })
    assert.equal(tools.includes('understand_image'), false)
  })

  it('does not advertise built-in vision for native multimodal providers', () => {
    const config = {
      ...baseConfig,
      provider: 'anthropic',
      defaults: { ...baseConfig.defaults, model: 'claude-opus-4-7' },
    }
    const tools = collectAvailableMcpToolNames(config, { id: 'main' } as any)
    assert.equal(tools.includes('understand_image'), false)
  })

  it('advertises understand_image for glm-5.x text-only models(火山 ark)', () => {
    const config = {
      ...baseConfig,
      provider: 'ark',
      defaults: { ...baseConfig.defaults, model: 'glm-5.2' },
    }
    const tools = collectAvailableMcpToolNames(config, { id: 'main' } as any)
    assert.ok(tools.includes('understand_image'))
  })

  it('does not advertise understand_image for MiniMax-M3(原生多模态)', () => {
    const config = {
      ...baseConfig,
      provider: 'minimax',
      defaults: { ...baseConfig.defaults, model: 'MiniMax-M3' },
    }
    const tools = collectAvailableMcpToolNames(config, { id: 'main' } as any)
    assert.equal(tools.includes('understand_image'), false)
  })

  it('lets explicit provider opt-ins use built-in vision for custom text-only providers', () => {
    const old = process.env.OPENCLAUDE_VISION_MCP_PROVIDERS
    process.env.OPENCLAUDE_VISION_MCP_PROVIDERS = 'openrouter'
    try {
      const config = {
        ...baseConfig,
        provider: 'openrouter',
        defaults: { ...baseConfig.defaults, model: 'some-text-model' },
      }
      const tools = collectAvailableMcpToolNames(config, { id: 'main' } as any)
      assert.ok(tools.includes('understand_image'))
    } finally {
      if (old === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_VISION_MCP_PROVIDERS')
      else process.env.OPENCLAUDE_VISION_MCP_PROVIDERS = old
    }
  })

  it('filters provider-scoped global MCPs by effective provider', () => {
    const config = {
      ...baseConfig,
      provider: 'deepseek',
      mcpServers: [
        { id: 'minimax-vision', provider: 'minimax', tools: ['web_search'] },
        { id: 'deepseek-extra', provider: 'deepseek', tools: ['deepseek_tool'] },
      ],
    }
    const tools = collectAvailableMcpToolNames(config, { id: 'main' } as any)
    assert.ok(tools.includes('deepseek_tool'))
    assert.equal(tools.includes('web_search'), false)
  })

  it('includes agent-specific MCP tools regardless of provider scoping', () => {
    const config = { ...baseConfig, provider: 'deepseek' }
    const agent: any = {
      id: 'main',
      mcpServers: [{ id: 'agent-vision', provider: 'minimax', tools: ['agent_tool'] }],
    }
    const tools = collectAvailableMcpToolNames(config, agent)
    assert.ok(tools.includes('agent_tool'))
  })

  it('built-in vision 豁免 toolset 过滤(像 memory;由 shouldEnable 控制)', () => {
    // deepseek(shouldEnable=true)+ toolset coding(不含 vision)→ 仍有 understand_image。
    const config = {
      ...baseConfig,
      defaults: { ...baseConfig.defaults, toolsets: ['coding'] },
      toolsets: { coding: ['browser'] },
    }
    const tools = collectAvailableMcpToolNames(config, { id: 'main' } as any)
    assert.equal(tools.includes('understand_image'), true)
  })

  it('glm-5.2 + core toolset(不含 vision)仍拿到 understand_image(回归:main/全能助手场景)', () => {
    const config = {
      ...baseConfig,
      provider: 'ark',
      defaults: { ...baseConfig.defaults, model: 'glm-5.2', toolsets: ['core'] },
      toolsets: { core: [] },
    }
    const tools = collectAvailableMcpToolNames(config, { id: 'main' } as any)
    assert.equal(tools.includes('understand_image'), true)
  })

  it('多模态模型 + toolset 仍不拿 understand_image(shouldEnable gate,不受豁免影响)', () => {
    const config = {
      ...baseConfig,
      provider: 'anthropic',
      defaults: { ...baseConfig.defaults, model: 'claude-opus-4-7', toolsets: ['coding'] },
      toolsets: { coding: ['browser'] },
    }
    const tools = collectAvailableMcpToolNames(config, { id: 'main' } as any)
    assert.equal(tools.includes('understand_image'), false)
  })

  it('core toolset excludes optional browser and research MCP tools', () => {
    const config = {
      ...baseConfig,
      provider: 'anthropic',
      defaults: { ...baseConfig.defaults, model: 'claude-opus-4-7', toolsets: ['core'] },
      toolsets: {
        core: [],
        browser: ['browser'],
        research: ['scansci-pdf', 'web-context'],
        web_context: ['web-context'],
      },
      mcpServers: [
        { id: 'browser', tools: ['browser_navigate', 'browser_click'] },
        { id: 'scansci-pdf', tools: ['scansci_pdf_download'] },
        { id: 'web-context', tools: ['web_context_extract_url'] },
      ],
    }
    const tools = collectAvailableMcpToolNames(config, { id: 'main' } as any)
    assert.equal(tools.includes('browser_navigate'), false)
    assert.equal(tools.includes('scansci_pdf_download'), false)
    assert.equal(tools.includes('web_context_extract_url'), false)
  })

  it('browser toolset exposes browser tools without research tools', () => {
    const config = {
      ...baseConfig,
      provider: 'anthropic',
      defaults: { ...baseConfig.defaults, model: 'claude-opus-4-7', toolsets: ['core'] },
      toolsets: {
        core: [],
        browser: ['browser'],
        research: ['scansci-pdf', 'web-context'],
        web_context: ['web-context'],
      },
      mcpServers: [
        { id: 'browser', tools: ['browser_navigate', 'browser_click'] },
        { id: 'scansci-pdf', tools: ['scansci_pdf_download'] },
        { id: 'web-context', tools: ['web_context_extract_url'] },
      ],
    }
    const tools = collectAvailableMcpToolNames(config, {
      id: 'main',
      toolsets: ['core', 'browser'],
    } as any)
    assert.ok(tools.includes('browser_navigate'))
    assert.equal(tools.includes('scansci_pdf_download'), false)
    assert.equal(tools.includes('web_context_extract_url'), false)
  })

  it('web_context toolset exposes web-context without browser or ScanSci', () => {
    const config = {
      ...baseConfig,
      provider: 'anthropic',
      defaults: { ...baseConfig.defaults, model: 'claude-opus-4-7', toolsets: ['core'] },
      toolsets: {
        core: [],
        browser: ['browser'],
        research: ['scansci-pdf', 'web-context'],
        web_context: ['web-context'],
      },
      mcpServers: [
        { id: 'browser', tools: ['browser_navigate', 'browser_click'] },
        { id: 'scansci-pdf', tools: ['scansci_pdf_download'] },
        { id: 'web-context', tools: ['web_context_extract_url'] },
      ],
    }
    const tools = collectAvailableMcpToolNames(config, {
      id: 'main',
      toolsets: ['core', 'web_context'],
    } as any)
    assert.ok(tools.includes('web_context_extract_url'))
    assert.equal(tools.includes('browser_navigate'), false)
    assert.equal(tools.includes('scansci_pdf_download'), false)
  })
})
