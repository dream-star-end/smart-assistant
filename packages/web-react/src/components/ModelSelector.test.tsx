import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import type { LockedPublicModel, PublicModel } from '../lib/types'
import { ModelSelector, modelLabel, teamEngineLabel } from './ModelSelector'
import { EFFORT_OPTIONS } from './settings/labels'

// 本仓 vitest 未开 globals 自动 cleanup,显式隔离每个用例的 DOM。
afterEach(() => {
  cleanup()
  localStorage.clear()
})

const MODELS: PublicModel[] = [
  { id: 'glm-5.2', display_name: 'GLM-5.2' },
  { id: 'deepseek-v4', display_name: 'DeepSeek-V4' },
  { id: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol' },
  { id: 'gpt-6-astra', display_name: 'GPT-6-Astra' },
]

/** radix DropdownMenu Trigger 在 pointerdown 开启(click 不够),jsdom 里直接发。 */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
}

describe('ModelSelector 团队模式诚信显示', () => {
  it('常态：触发器显示用户自选模型（display_name 权威）', () => {
    render(<ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={() => {}} />)
    const trigger = screen.getByRole('button', { name: '选择对话模型' })
    expect(trigger.textContent).toContain('GLM-5.2')
    expect(trigger.textContent).not.toContain('团队模式')
  })

  it('团队态：触发器禁用并如实显示服务端队长引擎与倍率，不再展开假选单(U1)', () => {
    const modelsWithCost: PublicModel[] = [
      ...MODELS.slice(0, 3),
      { id: 'gpt-7-leader', display_name: 'GPT-7-Leader', cost_x: 4.5 },
    ]
    const onSelect = vi.fn()
    render(
      <ModelSelector
        models={modelsWithCost}
        selectedId="glm-5.2"
        onSelect={onSelect}
        teamEngineActive
        teamLeaderModelId="gpt-7-leader"
      />,
    )
    const trigger = screen.getByRole('button', { name: '选择对话模型' })
    expect(trigger).toBeDisabled()
    expect(trigger.textContent).toContain('队长引擎 · GPT-7-Leader')
    expect(trigger.textContent).toContain('4.5')
    expect(trigger.textContent).not.toContain('团队模式 · ')
    expect(trigger.textContent).not.toContain('GLM-5.2')
    openMenu(trigger)
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('常态：菜单不渲染团队说明态', async () => {
    render(<ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={() => {}} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.queryByText(/队长引擎/)).toBeNull()
  })

  it('菜单项暴露后端 exact model id，供发布门稳定选模', async () => {
    render(<ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={() => {}} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    expect(document.querySelector('[data-model-id="deepseek-v4"]')).toHaveTextContent('DeepSeek-V4')
  })

  it('团队态切换与退出：开启时自动收起既有菜单并禁用，退出后恢复原自选模型且可正常选模(U1)', async () => {
    const onSelect = vi.fn()
    const onOpenChange = vi.fn()
    const { rerender } = render(
      <ModelSelector
        models={MODELS}
        selectedId="glm-5.2"
        onSelect={onSelect}
        open
        onOpenChange={onOpenChange}
      />,
    )
    expect((await screen.findAllByRole('menuitem')).length).toBeGreaterThan(0)
    rerender(
      <ModelSelector
        models={MODELS}
        selectedId="glm-5.2"
        onSelect={onSelect}
        open
        onOpenChange={onOpenChange}
        teamEngineActive
        teamLeaderModelId="gpt-6-astra"
      />,
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
    await waitFor(() => expect(screen.queryByRole('menuitem')).toBeNull())
    expect(screen.getByRole('button', { name: '选择对话模型' })).toBeDisabled()

    rerender(<ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={onSelect} />)
    const trigger = screen.getByRole('button', { name: '选择对话模型' })
    expect(trigger).not.toBeDisabled()
    expect(trigger.textContent).toContain('GLM-5.2')
    openMenu(trigger)
    const items = await screen.findAllByRole('menuitem')
    const target = items.find((i) => i.textContent?.includes('DeepSeek-V4'))
    expect(target).toBeTruthy()
    if (target) fireEvent.click(target)
    expect(onSelect).toHaveBeenCalledWith('deepseek-v4')
  })

  it('teamEngineLabel：优先以服务端 teamLeaderModelId 为准(含 lockedModels 或未知新 id)，缺省回退协议默认', () => {
    expect(teamEngineLabel(MODELS, 'gpt-6-astra')).toBe('GPT-6-Astra')
    expect(
      teamEngineLabel(
        [{ id: 'glm-5.2', display_name: 'GLM-5.2' }],
        'gpt-7-nova',
        [{ id: 'gpt-7-nova', display_name: 'GPT-7 Nova 旗舰', min_plan_code: 'pro' } as LockedPublicModel],
      ),
    ).toBe('GPT-7 Nova 旗舰')
    expect(teamEngineLabel([{ id: 'glm-5.2' }], 'gpt-8-server-only')).toBe('gpt-8-server-only')
    expect(teamEngineLabel([{ id: 'gpt-6-astra', display_name: 'GPT-6-Astra 旗舰' }])).toBe(
      'GPT-6-Astra 旗舰',
    )
    expect(teamEngineLabel([{ id: 'glm-5.2' }])).toBe('GPT-6-Astra')
    expect(modelLabel({ id: 'x' })).toBe('x')
  })
})

describe('ModelSelector provider 健康度降级(0108)', () => {
  const DEG_MODELS: PublicModel[] = [
    { id: 'glm-5.2', display_name: 'GLM-5.2', degraded: true },
    { id: 'deepseek-v4', display_name: 'DeepSeek-V4' },
    { id: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol' },
  ]

  it('degraded 模型显示「暂不可用」徽记且禁选(aria-disabled)', async () => {
    render(<ModelSelector models={DEG_MODELS} selectedId="deepseek-v4" onSelect={() => {}} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    const items = await screen.findAllByRole('menuitem')
    const deg = items.find((i) => i.textContent?.includes('GLM-5.2'))
    expect(deg).toBeTruthy()
    expect(deg?.textContent).toContain('暂不可用')
    expect(deg?.getAttribute('aria-disabled')).toBe('true')
    // 非降级模型不带徽记
    const ok = items.find((i) => i.textContent?.includes('DeepSeek-V4'))
    expect(ok?.textContent).not.toContain('暂不可用')
  })

  it('degraded 模型点击不触发 onSelect(禁选)', async () => {
    const onSelect = vi.fn()
    render(<ModelSelector models={DEG_MODELS} selectedId="deepseek-v4" onSelect={onSelect} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    const items = await screen.findAllByRole('menuitem')
    const deg = items.find((i) => i.textContent?.includes('GLM-5.2'))
    if (deg) fireEvent.click(deg)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('已选模型 degraded → 菜单顶部提示条建议换模', async () => {
    render(<ModelSelector models={DEG_MODELS} selectedId="glm-5.2" onSelect={() => {}} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    const note = await screen.findByRole('note')
    expect(note.textContent).toContain('当前模型暂不可用')
    expect(note.textContent).toContain('建议改用下方可用模型')
  })

  it('已选模型健康 → 无降级提示条', async () => {
    render(<ModelSelector models={DEG_MODELS} selectedId="deepseek-v4" onSelect={() => {}} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    expect(screen.queryByRole('note')).toBeNull()
  })
})

describe('ModelSelector Cursor 家族 + 思考档 + Fast', () => {
  const CURSOR_MODELS: PublicModel[] = [
    { id: 'cursor-auto', display_name: 'Cursor Auto' },
    { id: 'cursor-grok-4.6-high', display_name: 'Grok 4.6 High' },
    { id: 'cursor-grok-4.6-high-fast', display_name: 'Grok 4.6 High Fast' },
    { id: 'cursor-grok-4.6-low', display_name: 'Grok 4.6 Low' },
    { id: 'cursor-grok-4.6-low-fast', display_name: 'Grok 4.6 Low Fast' },
    { id: 'glm-5.2', display_name: 'GLM-5.2' },
    { id: 'cursor-fable-5-high', display_name: 'Fable 5 High (Non-ZDR)' },
  ]

  it('触发器显示家族名而不是 High Fast 组合名', () => {
    render(
      <ModelSelector
        models={CURSOR_MODELS}
        selectedId="cursor-grok-4.6-high-fast"
        onSelect={() => {}}
      />,
    )
    const trigger = screen.getByRole('button', { name: '选择对话模型' })
    expect(trigger.textContent).toContain('Grok 4.6')
    expect(trigger.textContent).not.toContain('Cursor Grok')
    expect(trigger.textContent).not.toContain('High Fast')
  })

  it('菜单按家族收拢，思考档和 Fast 可独立改写 canonical id', async () => {
    const onSelect = vi.fn()
    render(
      <ModelSelector
        models={CURSOR_MODELS}
        selectedId="cursor-grok-4.6-high-fast"
        onSelect={onSelect}
      />,
    )
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    expect(document.querySelector('[data-cursor-family="grok-4.6"]')).toBeTruthy()
    expect(screen.getAllByText('Grok 4.6').length).toBeGreaterThan(0)
    expect(screen.queryByText('Grok 4.6 High Fast')).toBeNull()

    const standard = document.querySelector('[data-fast="false"]')
    expect(standard).toBeTruthy()
    if (standard) fireEvent.click(standard)
    expect(onSelect).toHaveBeenCalledWith('cursor-grok-4.6-high')

    onSelect.mockClear()
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    const low = document.querySelector('[data-effort="low"]')
    expect(low).toBeTruthy()
    if (low) fireEvent.click(low)
    expect(onSelect).toHaveBeenCalledWith('cursor-grok-4.6-low-fast')
  })

  it('Fable 没有 Fast 开关', async () => {
    render(
      <ModelSelector models={CURSOR_MODELS} selectedId="cursor-fable-5-high" onSelect={() => {}} />,
    )
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    expect(document.querySelector('[data-fast="true"]')).toBeNull()
  })

  // C-07:思考档位是计费相关状态(同家族 medium/high 单价不同),此前只有点开菜单才知道。
  it('触发器在 sm+ 追加当前思考档与 Fast(「· 高 · Fast」),团队模式下不显示', () => {
    const { rerender } = render(
      <ModelSelector models={CURSOR_MODELS} selectedId="cursor-grok-4.6-high-fast" onSelect={() => {}} />,
    )
    const tier = screen.getByTestId('model-trigger-tier')
    expect(tier).toHaveTextContent(`· ${EFFORT_OPTIONS.find((o) => o.value === 'high')!.label} · Fast`)
    expect(tier).toHaveClass('hidden', 'sm:inline')
    rerender(<ModelSelector models={CURSOR_MODELS} selectedId="cursor-grok-4.6-low" onSelect={() => {}} />)
    expect(screen.getByTestId('model-trigger-tier')).toHaveTextContent(
      `· ${EFFORT_OPTIONS.find((o) => o.value === 'low')!.label}`,
    )
    expect(screen.getByTestId('model-trigger-tier').textContent).not.toContain('Fast')
    rerender(
      <ModelSelector models={CURSOR_MODELS} selectedId="cursor-grok-4.6-low" onSelect={() => {}} teamEngineActive />,
    )
    expect(screen.queryByTestId('model-trigger-tier')).toBeNull()
  })

  it('非 Cursor 模型按会话思考偏好显示档位;无偏好不显示', () => {
    const { rerender } = render(
      <ModelSelector
        models={CURSOR_MODELS}
        selectedId="glm-5.2"
        onSelect={() => {}}
        effortSupported={['low', 'high']}
        effortActive="high"
      />,
    )
    expect(screen.getByTestId('model-trigger-tier')).toHaveTextContent(
      EFFORT_OPTIONS.find((o) => o.value === 'high')!.label,
    )
    rerender(<ModelSelector models={CURSOR_MODELS} selectedId="glm-5.2" onSelect={() => {}} />)
    expect(screen.queryByTestId('model-trigger-tier')).toBeNull()
  })
})

describe('ModelSelector 官方 Grok 4.7 Fast 是速度开关', () => {
  const GROK_MODELS: PublicModel[] = [
    { id: 'grok-build', display_name: 'Grok 4.7', cost_x: 3.4 },
    { id: 'grok-build-fast', display_name: 'Grok 4.7 Fast', cost_x: 6.8 },
    { id: 'glm-5.2', display_name: 'GLM-5.2' },
  ]

  it('触发器保持 Grok 4.7，Fast 只出现在档位里', () => {
    render(
      <ModelSelector
        models={GROK_MODELS}
        selectedId="grok-build-fast"
        onSelect={() => {}}
        effortSupported={['high']}
        effortActive="high"
      />,
    )
    const trigger = screen.getByRole('button', { name: '选择对话模型' })
    expect(trigger.textContent).toContain('Grok 4.7')
    expect(trigger.textContent).not.toContain('Grok 4.7 Fast')
    expect(screen.getByTestId('model-trigger-tier').textContent).toContain('Fast')
  })

  it('菜单只有一行 Grok 4.7，Fast 开关改写 catalog id', async () => {
    const onSelect = vi.fn()
    render(<ModelSelector models={GROK_MODELS} selectedId="grok-build" onSelect={onSelect} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    expect(document.querySelector('[data-grok-family="grok-build"]')).toBeTruthy()
    expect(screen.queryByText('Grok 4.7 Fast')).toBeNull()
    const fast = document.querySelector('[data-fast="true"]')
    expect(fast).toBeTruthy()
    if (fast) fireEvent.click(fast)
    expect(onSelect).toHaveBeenCalledWith('grok-build-fast')
  })
})

// C-08:当前模型被后端标 degraded 时 trigger 无任何标识,只有点开菜单才看到。
describe('ModelSelector 降级模型 trigger 标识', () => {
  const DEG_MODELS: PublicModel[] = [
    { id: 'glm-5.2', display_name: 'GLM-5.2', degraded: true },
    { id: 'deepseek-v4', display_name: 'DeepSeek-V4' },
  ]

  it('已选模型 degraded → trigger 带警示图标与 title;健康模型无', () => {
    const { rerender } = render(<ModelSelector models={DEG_MODELS} selectedId="glm-5.2" onSelect={() => {}} />)
    const trigger = screen.getByRole('button', { name: '选择对话模型' })
    expect(trigger).toHaveAttribute('data-degraded', 'true')
    expect(trigger).toHaveAttribute('title', '当前模型暂不可用，点击更换')
    expect(screen.getByTestId('model-trigger-degraded')).toBeInTheDocument()
    rerender(<ModelSelector models={DEG_MODELS} selectedId="deepseek-v4" onSelect={() => {}} />)
    expect(screen.getByRole('button', { name: '选择对话模型' })).not.toHaveAttribute('data-degraded')
    expect(screen.queryByTestId('model-trigger-degraded')).toBeNull()
  })
})

describe('ModelSelector Cursor Opus/Fable 上下文档(turn 级 contextTier)', () => {
  const CURSOR_MODELS: PublicModel[] = [
    { id: 'cursor-auto', display_name: 'Cursor Auto' },
    { id: 'cursor-grok-4.6-high', display_name: 'Grok 4.6 High' },
    { id: 'cursor-fable-5-high', display_name: 'Fable 5 High' },
    { id: 'cursor-opus-5-high', display_name: 'Opus 5 High' },
    { id: 'glm-5.2', display_name: 'GLM-5.2' },
  ]

  it('Fable 选中时渲染 300k / 1M 两档,默认高亮 300k,点击 1M 上抛 onSelectContextTier', async () => {
    const onSelectContextTier = vi.fn()
    render(
      <ModelSelector
        models={CURSOR_MODELS}
        selectedId="cursor-fable-5-high"
        onSelect={() => {}}
        onSelectContextTier={onSelectContextTier}
      />,
    )
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    const std = document.querySelector('[data-cursor-context="300k"]')
    const long = document.querySelector('[data-cursor-context="1m"]')
    expect(std).toBeTruthy()
    expect(long).toBeTruthy()
    expect(std?.textContent).toContain('默认')
    // 默认档:300k 行带勾,1M 行不带
    expect(std?.querySelector('svg')).toBeTruthy()
    expect(long?.querySelector('svg')).toBeNull()
    if (long) fireEvent.click(long)
    expect(onSelectContextTier).toHaveBeenCalledWith('1m')
  })

  it('contextTier=1m 时高亮 1M 行,且不改写 model id(onSelect 不被调用)', async () => {
    const onSelect = vi.fn()
    const onSelectContextTier = vi.fn()
    render(
      <ModelSelector
        models={CURSOR_MODELS}
        selectedId="cursor-opus-5-high"
        onSelect={onSelect}
        contextTier="1m"
        onSelectContextTier={onSelectContextTier}
      />,
    )
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    const std = document.querySelector('[data-cursor-context="300k"]')
    const long = document.querySelector('[data-cursor-context="1m"]')
    expect(long?.querySelector('svg')).toBeTruthy()
    expect(std?.querySelector('svg')).toBeNull()
    if (std) fireEvent.click(std)
    expect(onSelectContextTier).toHaveBeenCalledWith('300k')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('非 Opus/Fable(Grok / Auto / 非 Cursor)或未提供回调时不渲染上下文档', async () => {
    for (const selectedId of ['cursor-grok-4.6-high', 'cursor-auto', 'glm-5.2']) {
      render(
        <ModelSelector
          models={CURSOR_MODELS}
          selectedId={selectedId}
          onSelect={() => {}}
          onSelectContextTier={() => {}}
        />,
      )
      openMenu(screen.getByRole('button', { name: '选择对话模型' }))
      await screen.findAllByRole('menuitem')
      expect(document.querySelector('[data-cursor-context]')).toBeNull()
      cleanup()
    }
    // 演示态等场景不传回调 → Fable 也不显示该档位
    render(
      <ModelSelector models={CURSOR_MODELS} selectedId="cursor-fable-5-high" onSelect={() => {}} />,
    )
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    expect(document.querySelector('[data-cursor-context]')).toBeNull()
  })
})

describe('ModelSelector locked rows + promo badge', () => {
  const MODELS: PublicModel[] = [
    { id: 'glm-5.2', display_name: 'GLM-5.2', promo_label: '限时半价' },
    { id: 'cursor-grok-4.6-high', display_name: 'Grok 4.6 High' },
    { id: 'glm-5.3', display_name: 'GLM-5.3', degraded: true },
  ]
  const LOCKED: LockedPublicModel[] = [
    {
      id: 'cursor-opus-5-high',
      display_name: 'Opus 5 High',
      min_plan_code: 'lite',
      min_plan_name: 'Lite',
      promo_label: '限时半价',
      cost_x: 6.5,
    },
    {
      id: 'cursor-opus-5-high-fast',
      display_name: 'Opus 5 High Fast',
      min_plan_code: 'lite',
      min_plan_name: 'Lite',
    },
  ]

  it('usable row with promo_label shows the badge in the menu and trigger', async () => {
    render(<ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={() => {}} />)
    const trigger = screen.getByRole('button', { name: '选择对话模型' })
    expect(trigger.textContent).toContain('限时半价')
    openMenu(trigger)
    const items = await screen.findAllByRole('menuitem')
    const glm = items.find((i) => i.getAttribute('data-model-id') === 'glm-5.2')
    expect(glm?.textContent).toContain('限时半价')
  })

  it('locked family renders with data-locked + lock icon after usable and before degraded', async () => {
    render(
      <ModelSelector
        models={MODELS}
        lockedModels={LOCKED}
        selectedId="glm-5.2"
        onSelect={() => {}}
      />,
    )
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    const items = await screen.findAllByRole('menuitem')
    const ids = items.map(
      (i) => i.getAttribute('data-cursor-family') || i.getAttribute('data-model-id'),
    )
    expect(ids).toEqual(['glm-5.2', 'grok-4.6', 'opus-5', 'glm-5.3'])
    const locked = document.querySelector('[data-locked="true"][data-cursor-family="opus-5"]')
    expect(locked).toBeTruthy()
    expect(locked?.textContent).toContain('Opus 5')
    expect(locked?.textContent).toContain('限时半价')
    expect(locked?.querySelector('svg')).toBeTruthy()
    expect(locked?.getAttribute('aria-disabled')).not.toBe('true')
  })

  it('clicking a locked row calls onLockedSelect and not onSelect', async () => {
    const onSelect = vi.fn()
    const onLockedSelect = vi.fn()
    render(
      <ModelSelector
        models={MODELS}
        lockedModels={LOCKED}
        selectedId="glm-5.2"
        onSelect={onSelect}
        onLockedSelect={onLockedSelect}
      />,
    )
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    const locked = document.querySelector('[data-locked="true"][data-cursor-family="opus-5"]')
    expect(locked).toBeTruthy()
    if (locked) fireEvent.click(locked)
    expect(onSelect).not.toHaveBeenCalled()
    expect(onLockedSelect).toHaveBeenCalledWith({
      label: 'Opus 5',
      minPlanCode: 'lite',
      minPlanName: 'Lite',
      modelId: 'cursor-opus-5-high',
    })
  })

  it('models empty + one locked cursor family: trigger enabled, click locked calls onLockedSelect only', async () => {
    const onSelect = vi.fn()
    const onLockedSelect = vi.fn()
    render(
      <ModelSelector
        models={[]}
        lockedModels={LOCKED}
        onSelect={onSelect}
        onLockedSelect={onLockedSelect}
      />,
    )
    const trigger = screen.getByRole('button', { name: '选择对话模型' })
    expect(trigger).toBeEnabled()
    expect(trigger.textContent).toContain('暂无可用模型')
    openMenu(trigger)
    await screen.findAllByRole('menuitem')
    const locked = document.querySelector('[data-locked="true"][data-cursor-family="opus-5"]')
    expect(locked).toBeTruthy()
    if (locked) fireEvent.click(locked)
    expect(onLockedSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })
})

// 573b7c88b(2026-09-22)在 selfhost 退役了 GPT-5.6 的上下文家族,成对家族现在是
// gpt-6-astra / gpt-6.1-sol / gpt-6-luna / kimi-k3(packages/protocol/src/engineModels.ts)。
describe('ModelSelector GPT/Kimi 上下文档', () => {
  const MODELS: PublicModel[] = [
    { id: 'glm-5.3', display_name: 'GLM-5.3', cost_x: 0.5 },
    { id: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', cost_x: 11.3 },
    { id: 'gpt-6.1-sol-1m', display_name: 'GPT-6.1-Sol', cost_x: 22.6 },
    { id: 'k3-256k', display_name: 'Kimi K3 256K', cost_x: 1.6 },
    { id: 'kimi-k3', display_name: 'Kimi K3', cost_x: 3.2 },
  ]

  it('触发器显示 GPT 家族名并带 xN', () => {
    render(<ModelSelector models={MODELS} selectedId="gpt-6.1-sol" onSelect={() => {}} />)
    const trigger = screen.getByRole('button', { name: '选择对话模型' })
    expect(trigger.textContent).toContain('GPT-6.1-Sol')
    expect(trigger.textContent).toContain('x11.3')
  })

  it('trigger 保留 CostMark', () => {
    render(<ModelSelector models={MODELS} selectedId="gpt-6.1-sol" onSelect={() => {}} />)
    const trigger = screen.getByRole('button', { name: '选择对话模型' })
    expect(trigger.textContent).toContain('x11.3')
  })

  it('菜单收成 Kimi K3 一行，1M 开关改写 canonical id', async () => {
    const onSelect = vi.fn()
    render(<ModelSelector models={MODELS} selectedId="k3-256k" onSelect={onSelect} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    expect(document.querySelector('[data-context-family="kimi-k3"]')).toBeTruthy()
    expect(screen.queryByText('Kimi K3 256K')).toBeNull()
    const long = document.querySelector('[data-context="1m"]')
    expect(long).toBeTruthy()
    expect(long?.textContent).toContain('1.5 倍基础单价')
    if (long) fireEvent.click(long)
    expect(onSelect).not.toHaveBeenCalled()

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('1M 上下文的基础单位价是标准上下文的 1.5 倍')
    expect(dialog).toHaveTextContent('实际总费用不一定只增加 50%')
    expect(dialog).toHaveTextContent('缓存读取 Token 会持续累计')
    fireEvent.click(screen.getByRole('button', { name: '仍要切换' }))
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('kimi-k3'))
  })

  it('标准档降级而家族选择回退到 1M 时仍先确认', async () => {
    const onSelect = vi.fn()
    const degradedModels: PublicModel[] = [
      { id: 'glm-5.3', display_name: 'GLM-5.3' },
      { id: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', degraded: true },
      { id: 'gpt-6.1-sol-1m', display_name: 'GPT-6.1-Sol' },
    ]
    render(<ModelSelector models={degradedModels} selectedId="glm-5.3" onSelect={onSelect} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    const family = document.querySelector('[data-context-family="gpt-6.1-sol"]')
    expect(family).toBeTruthy()
    if (family) fireEvent.click(family)

    await screen.findByRole('dialog')
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '仍要切换' }))
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('gpt-6.1-sol-1m'))
  })

  it('取消 1M 风险确认时保留标准上下文', async () => {
    const onSelect = vi.fn()
    render(<ModelSelector models={MODELS} selectedId="gpt-6.1-sol" onSelect={onSelect} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    const long = document.querySelector('[data-context="1m"]')
    expect(long).toBeTruthy()
    if (long) fireEvent.click(long)

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: '保留标准' }))
    expect(onSelect).not.toHaveBeenCalled()
  })
})

// 2026-09-05 的「更多 GPT 模型」折叠组只为 GPT-5.6 Terra/Luna(protocol collapsedByDefault)而设;
// 573b7c88b 在 selfhost 退役了 GPT-5.6,现行成对家族没有一个默认折叠,折叠头在本版目录上没有成员。
// 原来的 4 条折叠/展开用例已删除(OCV5-343),这里只锁住 GPT-6 家族按目录顺序直接可见、不出折叠头。
describe('ModelSelector GPT-6 家族(selfhost 无默认折叠组)', () => {
  const MODELS: PublicModel[] = [
    { id: 'glm-5.3', display_name: 'GLM-5.3' },
    { id: 'gpt-6-astra', display_name: 'GPT-6-Astra', cost_x: 22.6 },
    { id: 'gpt-6-astra-1m', display_name: 'GPT-6-Astra', cost_x: 33.9 },
    { id: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', cost_x: 11.3 },
    { id: 'gpt-6.1-sol-1m', display_name: 'GPT-6.1-Sol', cost_x: 22.6 },
    { id: 'gpt-6-luna', display_name: 'GPT-6-Luna' },
    { id: 'gpt-6-luna-1m', display_name: 'GPT-6-Luna' },
  ]

  it('GPT-6 家族按目录顺序直接可见,不渲染折叠头', async () => {
    render(<ModelSelector models={MODELS} selectedId="gpt-6.1-sol" onSelect={() => {}} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    const families = Array.from(document.querySelectorAll('[data-context-family]')).map((el) =>
      el.getAttribute('data-context-family'),
    )
    expect(families).toEqual(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'])
    expect(screen.getByText('GPT-6-Luna')).toBeInTheDocument()
    expect(document.querySelector('[data-collapsed-group]')).toBeNull()
    expect(screen.queryByText('更多模型')).toBeNull()
  })
})

// OCV5-425: OpenCode Go models sit in the collapsed「更多模型」group; the main list stays as is.
describe('ModelSelector「更多模型」(OpenCode Go)', () => {
  const MODELS: PublicModel[] = [
    { id: 'deepseek-v4-flash', display_name: 'DeepSeek V4 Flash' },
    { id: 'kimi-k3', display_name: 'Kimi K3' },
    { id: 'kimi-k3-go', display_name: 'Kimi K3 (Go)' },
    { id: 'qwen3.8-max-go', display_name: 'Qwen3.8 Max (Go)' },
  ]

  it('main-list models stay visible; Go models only appear after expanding the group', async () => {
    render(<ModelSelector models={MODELS} selectedId="deepseek-v4-flash" onSelect={() => {}} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    expect(screen.getAllByText('DeepSeek V4 Flash').length).toBeGreaterThan(0)
    expect(screen.getByText('Kimi K3')).toBeInTheDocument()
    const header = document.querySelector('[data-collapsed-group]')
    expect(header?.getAttribute('data-collapsed-group')).toBe('closed')
    expect(screen.getByText('更多模型')).toBeInTheDocument()
    expect(screen.queryByText('Kimi K3 (Go)')).toBeNull()
    if (header) fireEvent.click(header)
    expect(await screen.findByText('Kimi K3 (Go)')).toBeInTheDocument()
    expect(screen.getByText('Qwen3.8 Max (Go)')).toBeInTheDocument()
  })

  it('a selected Go model opens the group so the selection stays visible', async () => {
    render(<ModelSelector models={MODELS} selectedId="qwen3.8-max-go" onSelect={() => {}} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    expect(document.querySelector('[data-collapsed-group]')?.getAttribute('data-collapsed-group')).toBe('open')
    expect(screen.getAllByText('Qwen3.8 Max (Go)').length).toBeGreaterThan(0)
  })
})

const MANY_MODELS: PublicModel[] = Array.from({ length: 9 }, (_, i) => ({
  id: `plain-many-${i}`,
  display_name: i === 3 ? 'Zebra Unique' : `Alpha ${i}`,
}))

describe('ModelSelector 无搜索框', () => {
  it('模型再多也不渲染搜索框，列表仍可见', async () => {
    render(<ModelSelector models={MANY_MODELS} selectedId="plain-many-0" onSelect={() => {}} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    const items = await screen.findAllByRole('menuitem')
    expect(screen.queryByLabelText('搜索模型')).toBeNull()
    expect(screen.queryByRole('textbox', { name: '搜索模型' })).toBeNull()
    expect(screen.queryByText('无匹配模型')).toBeNull()
    expect(items.some((i) => i.textContent?.includes('Zebra Unique'))).toBe(true)
    expect(items.some((i) => i.textContent?.includes('Alpha 0'))).toBe(true)
  })
})

describe('ModelSelector 受控开合', () => {
  it('open 受控为 true 时菜单按 prop 打开', async () => {
    render(
      <ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={() => {}} open />,
    )
    const items = await screen.findAllByRole('menuitem')
    expect(items.some((i) => i.textContent?.includes('DeepSeek-V4'))).toBe(true)
  })
})

// C-28:modelSwitchPreparing(压缩上下文切换中)时 trigger 只是禁用,用户不知道在等什么。
describe('ModelSelector 切换中态', () => {
  it('loading 且已有选中模型 → spinner + 「切换中…」+ aria-busy;不 loading 时无', () => {
    const { rerender } = render(<ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={() => {}} loading />)
    const trigger = screen.getByRole('button', { name: '选择对话模型' })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAttribute('aria-busy', 'true')
    expect(trigger).toHaveAttribute('title', '正在切换模型，请稍候')
    expect(screen.getByTestId('model-trigger-spinner')).toBeInTheDocument()
    expect(screen.getByTestId('model-trigger-loading')).toHaveTextContent('切换中…')
    expect(trigger.textContent).toContain('GLM-5.2')
    rerender(<ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={() => {}} />)
    expect(screen.queryByTestId('model-trigger-spinner')).toBeNull()
    expect(screen.queryByTestId('model-trigger-loading')).toBeNull()
  })

  it('切换中给出「取消」入口(trigger 被禁用,这是唯一出口);未提供时不渲染', () => {
    const onCancel = vi.fn()
    const { rerender } = render(
      <ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={() => {}} loading onCancelSwitch={onCancel} />,
    )
    fireEvent.click(screen.getByTestId('model-switch-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    rerender(<ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={() => {}} />)
    expect(screen.queryByTestId('model-switch-cancel')).toBeNull()
  })

  it('loading 且列表为空 → 仍显示「加载模型…」,不显示「切换中」', () => {
    render(<ModelSelector models={[]} selectedId={undefined} onSelect={() => {}} loading />)
    const trigger = screen.getByRole('button', { name: '选择对话模型' })
    expect(trigger.textContent).toContain('加载模型…')
    expect(screen.queryByTestId('model-trigger-loading')).toBeNull()
  })
})

describe('ModelSelector 打开后焦点', () => {
  it('无搜索框时焦点仍按 Radix 默认落在菜单内', async () => {
    render(<ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={() => {}} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    expect(screen.queryByRole('textbox', { name: '搜索模型' })).toBeNull()
    await waitFor(() => expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull())
  })
})

describe('ModelSelector 最近使用', () => {
  afterEach(() => {
    localStorage.clear()
  })

  // C-27:切过同家族不同档位后,「最近」会出现与当前选中同一家族的行且带 ✓,与主列表重复。
  it('与当前选中同一 Cursor 家族的最近记录不进「最近」分组;其它家族照常', async () => {
    const GROK_MODELS: PublicModel[] = [
      { id: 'cursor-grok-4.6-high-fast', display_name: 'Grok 4.6 High Fast' },
      { id: 'cursor-grok-4.6-low', display_name: 'Grok 4.6 Low' },
      { id: 'glm-5.2', display_name: 'GLM-5.2' },
      { id: 'deepseek-v4', display_name: 'DeepSeek-V4' },
    ]
    localStorage.setItem('oc_v5_recent_models', JSON.stringify(['cursor-grok-4.6-low', 'glm-5.2']))
    render(<ModelSelector models={GROK_MODELS} selectedId="cursor-grok-4.6-high-fast" onSelect={() => {}} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    const recentLabel = document.querySelector('[data-recent-group="true"]')
    expect(recentLabel).toBeTruthy()
    // 「最近」分组 = 标签之后、分隔线之前的兄弟节点。
    const recentIds: string[] = []
    for (let el = recentLabel?.nextElementSibling; el && el.getAttribute('role') !== 'separator'; el = el.nextElementSibling) {
      const id = el.getAttribute('data-model-id')
      if (id) recentIds.push(id)
    }
    // 同家族(grok)不出现在最近;glm-5.2 出现。
    expect(recentIds).toEqual(['glm-5.2'])
    expect(document.querySelectorAll('[data-recent-group="true"]')).toHaveLength(1)
  })

  it('选过的模型出现在「最近」分组', async () => {
    const onSelect = vi.fn()
    render(<ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={onSelect} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    const items = await screen.findAllByRole('menuitem')
    const target = items.find((i) => i.textContent?.includes('DeepSeek-V4'))
    expect(target).toBeTruthy()
    if (target) fireEvent.click(target)
    expect(onSelect).toHaveBeenCalledWith('deepseek-v4')

    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    const recentLabel = await screen.findByText('最近')
    expect(recentLabel).toBeInTheDocument()
    expect(document.querySelector('[data-recent-group="true"]')).toBeTruthy()
    const recentItem = document.querySelector('[data-recent-group="true"]')
      ?.parentElement
      ?.querySelector('[data-model-id="deepseek-v4"]')
    expect(recentItem).toBeTruthy()
    expect(recentItem?.textContent).toContain('DeepSeek-V4')
  })
})

function stubNarrowViewport(narrow: boolean) {
  const original = window.matchMedia
  window.matchMedia = ((query: string) =>
    ({
      matches: query === '(max-width: 639px)' ? narrow : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList) as typeof window.matchMedia
  return () => {
    window.matchMedia = original
  }
}

describe('ModelSelector 窄屏贴底 sheet', () => {
  const CURSOR_MODELS: PublicModel[] = [
    { id: 'cursor-grok-4.6-high', display_name: 'Grok 4.6 High' },
    { id: 'cursor-grok-4.6-low', display_name: 'Grok 4.6 Low' },
    { id: 'cursor-grok-4.6-medium', display_name: 'Grok 4.6 Medium' },
    { id: 'glm-5.2', display_name: 'GLM-5.2' },
  ]

  it('宽屏仍走下拉菜单,不渲染 dialog sheet', async () => {
    const restore = stubNarrowViewport(false)
    try {
      render(
        <ModelSelector models={CURSOR_MODELS} selectedId="cursor-grok-4.6-high" onSelect={() => {}} />,
      )
      openMenu(screen.getByRole('button', { name: '选择对话模型' }))
      await screen.findAllByRole('menuitem')
      expect(screen.getByRole('menu')).toBeInTheDocument()
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.queryByTestId('model-picker-sheet')).toBeNull()
    } finally {
      restore()
    }
  })

  it('窄屏打开为贴底 sheet:遮罩 dialog + 单一滚动容器容纳模型与思考档', async () => {
    const restore = stubNarrowViewport(true)
    try {
      render(
        <ModelSelector models={CURSOR_MODELS} selectedId="cursor-grok-4.6-high" onSelect={() => {}} />,
      )
      fireEvent.click(screen.getByRole('button', { name: '选择对话模型' }))
      const dialog = await screen.findByRole('dialog')
      expect(dialog.className).toContain('model-picker-sheet')
      expect(dialog.className).toContain('overflow-hidden')
      expect(screen.getByTestId('model-picker-sheet')).toBeInTheDocument()
      const scroll = screen.getByTestId('model-picker-sheet-scroll')
      expect(scroll).toHaveAttribute('role', 'menu')
      expect(scroll.className).toContain('overflow-y-auto')
      expect(scroll.className).toContain('overscroll-contain')
      expect(scroll.querySelector('.overflow-y-auto')).toBeNull()
      expect(screen.getAllByText('选择对话模型').length).toBeGreaterThan(0)
      expect(screen.getByTestId('model-picker-sheet').textContent).toMatch(/选择对话模型/)
      expect(screen.getAllByText(/Grok 4\.6/).length).toBeGreaterThan(0)
      expect(screen.getByText('思考档位')).toBeInTheDocument()
      const summary = screen.getByText('思考档位').parentElement
      expect(summary?.textContent).toMatch(/高/)
      expect(screen.getByRole('menuitem', { name: '高' })).toBeInTheDocument()
      expect(screen.queryByRole('textbox', { name: '搜索模型' })).toBeNull()
    } finally {
      restore()
    }
  })

  it('窄屏点选模型后关闭 sheet', async () => {
    const restore = stubNarrowViewport(true)
    try {
      const onSelect = vi.fn()
      render(
        <ModelSelector models={CURSOR_MODELS} selectedId="cursor-grok-4.6-high" onSelect={onSelect} />,
      )
      fireEvent.click(screen.getByRole('button', { name: '选择对话模型' }))
      await screen.findByRole('dialog')
      fireEvent.click(screen.getByRole('menuitem', { name: /GLM-5\.2/ }))
      expect(onSelect).toHaveBeenCalledWith('glm-5.2')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    } finally {
      restore()
    }
  })
})

describe('ModelSelector Box Claude 走平台思考档位(OCV5-378)', () => {
  const BOX: PublicModel[] = [
    { id: 'box-claude-haiku-5-5', display_name: 'Claude Haiku 5.5', engine: 'ccb',
      supported_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'glm-5.2', display_name: 'GLM-5.2' },
  ]

  it('catalog 路由到 Box 模型路线(engine ccb)时显示「思考档位」,选档上抛', async () => {
    const onSelectEffort = vi.fn()
    render(
      <ModelSelector
        models={BOX}
        selectedId="box-claude-haiku-5-5"
        onSelect={() => {}}
        effortSupported={['low', 'medium', 'high', 'xhigh', 'max']}
        effortActive="high"
        onSelectEffort={onSelectEffort}
      />,
    )
    const trigger = screen.getByRole('button', { name: '选择对话模型' })
    expect(trigger).toHaveTextContent('Claude Haiku 5.5')
    expect(screen.getByTestId('model-trigger-tier')).toHaveTextContent(
      EFFORT_OPTIONS.find((o) => o.value === 'high')!.label,
    )
    openMenu(trigger)
    await screen.findAllByRole('menuitem')
    for (const effort of ['follow', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(document.querySelector(`[data-effort="${effort}"]`)).not.toBeNull()
    }
    fireEvent.click(document.querySelector('[data-effort="low"]')!)
    expect(onSelectEffort).toHaveBeenCalledWith('low')
  })

  it('同一 id 仍由 catalog 路由到 Cursor 引擎时,保持 Cursor 家族行为(不出平台档位)', async () => {
    render(
      <ModelSelector
        models={[{ ...BOX[0]!, engine: 'cursor', supported_efforts: [] }, BOX[1]!]}
        selectedId="box-claude-haiku-5-5"
        onSelect={() => {}}
        effortSupported={[]}
        onSelectEffort={() => {}}
      />,
    )
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    expect(document.querySelector('[data-effort]')).toBeNull()
  })
})

describe('ModelSelector OCV5-434 GPT Fast(turn 级 serviceTier,默认关)', () => {
  const GPT_MODELS: PublicModel[] = [
    { id: 'gpt-6-luna', display_name: 'GPT-6 Luna' },
    { id: 'opencode-gpt-6-luna', display_name: 'GPT-6 Luna (OpenCode)' },
    { id: 'opencode-grok-4.7', display_name: 'Grok 4.7' },
    { id: 'glm-5.2', display_name: 'GLM-5.2' },
  ]

  it('OpenCode Go Luna: Fast 标注按 2× 计费;serviceTier=fast 时 Fast 打勾,点标准上抛 null', async () => {
    const onSelectServiceTier = vi.fn()
    render(
      <ModelSelector
        models={GPT_MODELS}
        selectedId="opencode-gpt-6-luna"
        onSelect={() => {}}
        serviceTier="fast"
        onSelectServiceTier={onSelectServiceTier}
      />,
    )
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    const std = document.querySelector('[data-gpt-fast="false"]')
    const fast = document.querySelector('[data-gpt-fast="true"]')
    expect(fast?.textContent).toContain('按 2× 计费')
    expect(fast?.querySelector('svg')).toBeTruthy()
    if (std) fireEvent.click(std)
    expect(onSelectServiceTier).toHaveBeenCalledWith(null)
  })

  it('Codex GPT-6 与不支持 Fast 的模型不渲染速度段', async () => {
    // Codex GPT-6 Luna 也不显示(OCV5-434:上游不生效,按用户决定隐藏)。
    for (const id of ['gpt-6-luna', 'opencode-grok-4.7', 'glm-5.2']) {
      cleanup()
      render(<ModelSelector models={GPT_MODELS} selectedId={id} onSelect={() => {}} onSelectServiceTier={() => {}} />)
      openMenu(screen.getByRole('button', { name: '选择对话模型' }))
      await screen.findAllByRole('menuitem')
      expect(document.querySelector('[data-gpt-fast]')).toBeNull()
    }
  })
})

describe('OCV5-504 自选档说明保持默认与目录价格权威', () => {
  it('Grok 两档各自展示目录倍率，目录更新立即生效且不会自动选档', async () => {
    const models: PublicModel[] = [
      { id: 'grok-build', display_name: 'Grok 4.7', cost_x: 3.4 },
      { id: 'grok-build-fast', display_name: 'Grok 4.7 Fast', cost_x: 6.8 },
    ]
    const onSelect = vi.fn()
    const view = render(<ModelSelector models={models} selectedId="grok-build" onSelect={onSelect} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    expect(document.querySelector('[data-fast="false"]')).toHaveTextContent('3.4')
    expect(document.querySelector('[data-fast="true"]')).toHaveTextContent('6.8')
    expect(onSelect).not.toHaveBeenCalled()
    view.rerender(<ModelSelector models={[models[0]!, { ...models[1]!, cost_x: 9.1 }]}
      selectedId="grok-build" onSelect={onSelect} />)
    expect(document.querySelector('[data-fast="true"]')).toHaveTextContent('9.1')
    fireEvent.click(document.querySelector('[data-fast="true"]')!)
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('grok-build-fast')
  })

  it('未知价格不制造倍率，跟随档只发送null，未选择时不修改默认', async () => {
    const onSelectEffort = vi.fn()
    render(<ModelSelector models={[
      { id: 'grok-build', display_name: 'Grok 4.7' },
      { id: 'grok-build-fast', display_name: 'Grok 4.7 Fast' },
    ]} selectedId="grok-build" onSelect={() => {}}
      effortSupported={['low', 'high']} effortActive={null} onSelectEffort={onSelectEffort} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    expect(document.querySelector('[data-fast="true"]')?.textContent).toBe('Fast')
    expect(document.querySelector('[data-effort="medium"]')).toBeNull()
    expect(onSelectEffort).not.toHaveBeenCalled()
    expect(screen.getByText('较低档偏重响应速度，较高档偏重复杂任务。')).toBeInTheDocument()
    fireEvent.click(document.querySelector('[data-effort="follow"]')!)
    expect(onSelectEffort).toHaveBeenCalledExactlyOnceWith(null)
  })
})


describe('ModelSelector 更多模型再次打开', () => {
  const GROUP: PublicModel[] = [
    { id: 'deepseek-v4-flash', display_name: 'DeepSeek V4 Flash' },
    { id: 'kimi-k3', display_name: 'Kimi K3' },
    { id: 'kimi-k3-go', display_name: 'Kimi K3 (Go)' },
    { id: 'qwen3.8-max-go', display_name: 'Qwen3.8 Max (Go)' },
  ]
  const collapsed = () => document.querySelector('[data-collapsed-group]')?.getAttribute('data-collapsed-group')

  it('展开后关掉再打开，仍按选中项收起，不和上次相反', async () => {
    const view = render(
      <ModelSelector models={GROUP} selectedId="deepseek-v4-flash" onSelect={() => {}} open />,
    )
    await screen.findAllByRole('menuitem')
    expect(collapsed()).toBe('closed')
    const header = document.querySelector('[data-collapsed-group]')
    if (header) fireEvent.click(header)
    expect(collapsed()).toBe('open')
    view.rerender(
      <ModelSelector models={GROUP} selectedId="deepseek-v4-flash" onSelect={() => {}} open={false} />,
    )
    view.rerender(
      <ModelSelector models={GROUP} selectedId="deepseek-v4-flash" onSelect={() => {}} open />,
    )
    await screen.findAllByRole('menuitem')
    await waitFor(() => expect(collapsed()).toBe('closed'))
  })

  it('选中项在组内时，收起再打开仍展开', async () => {
    const view = render(
      <ModelSelector models={GROUP} selectedId="qwen3.8-max-go" onSelect={() => {}} open />,
    )
    await screen.findAllByRole('menuitem')
    expect(collapsed()).toBe('open')
    const header = document.querySelector('[data-collapsed-group]')
    if (header) fireEvent.click(header)
    expect(collapsed()).toBe('closed')
    view.rerender(
      <ModelSelector models={GROUP} selectedId="qwen3.8-max-go" onSelect={() => {}} open={false} />,
    )
    view.rerender(<ModelSelector models={GROUP} selectedId="qwen3.8-max-go" onSelect={() => {}} open />)
    await screen.findAllByRole('menuitem')
    await waitFor(() => expect(collapsed()).toBe('open'))
  })
})

describe('ModelSelector 不支持思考档位', () => {
  it('只显示一行淡灰说明，不弹窗，也不占用 note', async () => {
    const view = render(
      <ModelSelector
        models={[{ id: 'glm-5.2', display_name: 'GLM-5.2' }]}
        selectedId="glm-5.2"
        onSelect={() => {}}
        open
      />,
    )
    await screen.findAllByRole('menuitem')
    const hint = screen.getByText('不支持思考档位')
    expect(hint.tagName).toBe('P')
    expect(hint.className).toContain('text-faint')
    expect(hint.getAttribute('role')).toBeNull()
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('思考档位')).toBeNull()
    view.rerender(
      <ModelSelector
        models={[{ id: 'glm-5.2', display_name: 'GLM-5.2' }]}
        selectedId="glm-5.2"
        onSelect={() => {}}
        effortSupported={[]}
        onSelectEffort={() => {}}
        open
      />,
    )
    expect(screen.getByText('不支持思考档位')).toBeInTheDocument()
  })

  it('目录有思考档时不显示不支持说明', async () => {
    render(
      <ModelSelector
        models={[{ id: 'glm-5.2', display_name: 'GLM-5.2' }]}
        selectedId="glm-5.2"
        onSelect={() => {}}
        effortSupported={['low', 'high']}
        effortActive="high"
        onSelectEffort={() => {}}
        open
      />,
    )
    await screen.findAllByRole('menuitem')
    expect(screen.getByText('较低档偏重响应速度，较高档偏重复杂任务。')).toBeInTheDocument()
    expect(screen.queryByText('不支持思考档位')).toBeNull()
  })

  it('Cursor 家族有思考档时不显示不支持说明', async () => {
    render(
      <ModelSelector
        models={[
          { id: 'cursor-grok-4.6-high', display_name: 'Grok 4.6 High' },
          { id: 'cursor-grok-4.6-low', display_name: 'Grok 4.6 Low' },
        ]}
        selectedId="cursor-grok-4.6-high"
        onSelect={() => {}}
        open
      />,
    )
    await screen.findAllByRole('menuitem')
    expect(screen.getByText('思考档位')).toBeInTheDocument()
    expect(screen.queryByText('不支持思考档位')).toBeNull()
  })

  it('团队引擎开启时不显示不支持说明', () => {
    render(
      <ModelSelector
        models={[{ id: 'glm-5.2', display_name: 'GLM-5.2' }]}
        selectedId="glm-5.2"
        onSelect={() => {}}
        teamEngineActive
        open
      />,
    )
    expect(screen.queryByText('不支持思考档位')).toBeNull()
  })
})
