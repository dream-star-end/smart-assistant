import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import type { LockedPublicModel, PublicModel } from '../lib/types'
import { ModelSelector, modelLabel, teamEngineLabel } from './ModelSelector'

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

  it('团队态：触发器如实显示实际生效的队长引擎，而非用户自选模型', () => {
    render(
      <ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={() => {}} teamEngineActive />,
    )
    const trigger = screen.getByRole('button', { name: '选择对话模型' })
    expect(trigger.textContent).toContain('团队模式 · GPT-6-Astra')
    expect(trigger.textContent).not.toContain('GLM-5.2')
  })

  it('团队态：菜单含不可选说明态（非 menuitem），自选模型保留选中记忆并标注生效时机', async () => {
    render(
      <ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={() => {}} teamEngineActive />,
    )
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))

    // 说明态存在且不可选（role=note,不在 menuitem 集合里）
    const note = await screen.findByRole('note')
    expect(note.textContent).toContain('团队模式 · 队长引擎 GPT-6-Astra')
    expect(note.textContent).toContain('团队模式关闭后生效')
    const items = screen.getAllByRole('menuitem')
    expect(items.some((i) => i.contains(note))).toBe(false)

    // 用户自选模型仍是列表里的选中项（记忆保留）,并带"关闭后生效"标注
    const selectedItem = items.find((i) => i.textContent?.includes('GLM-5.2'))
    expect(selectedItem).toBeTruthy()
    expect(selectedItem?.textContent).toContain('团队模式关闭后生效')
    // 未选中项不带该标注
    const otherItem = items.find((i) => i.textContent?.includes('DeepSeek-V4'))
    expect(otherItem?.textContent).not.toContain('团队模式关闭后生效')
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

  it('团队态：模型仍可选择（onSelect 照常上抛,作为关闭团队模式后的记忆）', async () => {
    const onSelect = vi.fn()
    render(
      <ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={onSelect} teamEngineActive />,
    )
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    const items = await screen.findAllByRole('menuitem')
    const target = items.find((i) => i.textContent?.includes('DeepSeek-V4'))
    expect(target).toBeTruthy()
    if (target) fireEvent.click(target)
    expect(onSelect).toHaveBeenCalledWith('deepseek-v4')
  })

  it('teamEngineLabel：优先取 /api/public/models 里 gpt-6-astra 的 display_name,缺失退回固定标签', () => {
    expect(teamEngineLabel(MODELS)).toBe('GPT-6-Astra')
    expect(teamEngineLabel([{ id: 'gpt-6-astra', display_name: 'GPT-6-Astra 旗舰' }])).toBe(
      'GPT-6-Astra 旗舰',
    )
    expect(teamEngineLabel([{ id: 'glm-5.2' }])).toBe('GPT-6-Astra')
    expect(teamEngineLabel([{ id: 'gpt-5.6-sol', display_name: 'Legacy Sol' }])).toBe('GPT-6-Astra')
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

describe('ModelSelector GPT/Kimi 上下文档', () => {
  const MODELS: PublicModel[] = [
    { id: 'glm-5.3', display_name: 'GLM-5.3', cost_x: 0.5 },
    { id: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', cost_x: 11.3 },
    { id: 'gpt-5.6-sol-1m', display_name: 'GPT-5.6-Sol', cost_x: 22.6 },
    { id: 'k3-256k', display_name: 'Kimi K3 256K', cost_x: 1.6 },
    { id: 'kimi-k3', display_name: 'Kimi K3', cost_x: 3.2 },
  ]

  it('触发器显示 GPT 家族名并带 xN', () => {
    render(<ModelSelector models={MODELS} selectedId="gpt-5.6-sol" onSelect={() => {}} />)
    const trigger = screen.getByRole('button', { name: '选择对话模型' })
    expect(trigger.textContent).toContain('GPT-5.6-Sol')
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
      { id: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', degraded: true },
      { id: 'gpt-5.6-sol-1m', display_name: 'GPT-5.6-Sol' },
    ]
    render(<ModelSelector models={degradedModels} selectedId="glm-5.3" onSelect={onSelect} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    const family = document.querySelector('[data-context-family="gpt-5.6-sol"]')
    expect(family).toBeTruthy()
    if (family) fireEvent.click(family)

    await screen.findByRole('dialog')
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '仍要切换' }))
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('gpt-5.6-sol-1m'))
  })

  it('取消 1M 风险确认时保留标准上下文', async () => {
    const onSelect = vi.fn()
    render(<ModelSelector models={MODELS} selectedId="gpt-5.6-sol" onSelect={onSelect} />)
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

describe('ModelSelector 「更多 GPT 模型」折叠组(2026-09-05 Terra/Luna)', () => {
  const MODELS: PublicModel[] = [
    { id: 'glm-5.3', display_name: 'GLM-5.3' },
    { id: 'gpt-6-astra', display_name: 'GPT-6-Astra', cost_x: 22.6 },
    { id: 'gpt-6-astra-1m', display_name: 'GPT-6-Astra', cost_x: 33.9 },
    { id: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', cost_x: 11.3 },
    { id: 'gpt-5.6-sol-1m', display_name: 'GPT-5.6-Sol', cost_x: 22.6 },
    { id: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra' },
    { id: 'gpt-5.6-terra-1m', display_name: 'GPT-5.6-Terra' },
    { id: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna' },
    { id: 'gpt-5.6-luna-1m', display_name: 'GPT-5.6-Luna' },
  ]

  it('默认收起:Terra/Luna 不渲染,Astra/Sol 按目录顺序直接可见,折叠头标注数量', async () => {
    render(<ModelSelector models={MODELS} selectedId="gpt-5.6-sol" onSelect={() => {}} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    const families = Array.from(document.querySelectorAll('[data-context-family]')).map((el) =>
      el.getAttribute('data-context-family'),
    )
    expect(families).toEqual(['gpt-6-astra', 'gpt-5.6-sol'])
    expect(screen.queryByText('GPT-5.6-Terra')).toBeNull()
    expect(screen.queryByText('GPT-5.6-Luna')).toBeNull()
    const toggle = document.querySelector('[data-collapsed-group]')
    expect(toggle).toHaveAttribute('data-collapsed-group', 'closed')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveTextContent('更多 GPT 模型')
    expect(toggle).toHaveTextContent('2 个')
  })

  it('点击折叠头展开 Terra/Luna(菜单不关闭),再点收起', async () => {
    render(<ModelSelector models={MODELS} selectedId="gpt-5.6-sol" onSelect={() => {}} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    const toggle = document.querySelector('[data-collapsed-group]')
    expect(toggle).toBeTruthy()
    if (toggle) fireEvent.click(toggle)
    await waitFor(() =>
      expect(document.querySelector('[data-collapsed-group]')).toHaveAttribute(
        'data-collapsed-group',
        'open',
      ),
    )
    expect(document.querySelector('[data-context-family="gpt-5.6-terra"]')).toBeTruthy()
    expect(document.querySelector('[data-context-family="gpt-5.6-luna"]')).toBeTruthy()
    // 折叠行排在可见行之后
    const families = Array.from(document.querySelectorAll('[data-context-family]')).map((el) =>
      el.getAttribute('data-context-family'),
    )
    expect(families).toEqual(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
    // 菜单仍开着
    expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0)

    const again = document.querySelector('[data-collapsed-group]')
    if (again) fireEvent.click(again)
    await waitFor(() =>
      expect(document.querySelector('[data-context-family="gpt-5.6-terra"]')).toBeNull(),
    )
  })

  it('当前选中 Terra(含 1M)时折叠组自动展开,选中项永远可见', async () => {
    render(<ModelSelector models={MODELS} selectedId="gpt-5.6-terra-1m" onSelect={() => {}} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    expect(document.querySelector('[data-collapsed-group]')).toHaveAttribute(
      'data-collapsed-group',
      'open',
    )
    const terra = document.querySelector('[data-context-family="gpt-5.6-terra"]')
    expect(terra).toBeTruthy()
    expect(terra?.textContent).toContain('GPT-5.6-Terra')
  })

  it('展开后点击 Luna 行照常上抛 onSelect(标准档)', async () => {
    const onSelect = vi.fn()
    render(<ModelSelector models={MODELS} selectedId="glm-5.3" onSelect={onSelect} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    const toggle = document.querySelector('[data-collapsed-group]')
    if (toggle) fireEvent.click(toggle)
    const luna = await waitFor(() => {
      const el = document.querySelector('[data-context-family="gpt-5.6-luna"]')
      expect(el).toBeTruthy()
      return el as Element
    })
    fireEvent.click(luna)
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('gpt-5.6-luna'))
  })

  it('没有可折叠家族时不渲染折叠头', async () => {
    const plain: PublicModel[] = [
      { id: 'glm-5.3', display_name: 'GLM-5.3' },
      { id: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol' },
      { id: 'gpt-5.6-sol-1m', display_name: 'GPT-5.6-Sol' },
    ]
    render(<ModelSelector models={plain} selectedId="glm-5.3" onSelect={() => {}} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    expect(document.querySelector('[data-collapsed-group]')).toBeNull()
    expect(screen.queryByText('更多 GPT 模型')).toBeNull()
  })
})

const SEARCH_MODELS: PublicModel[] = Array.from({ length: 8 }, (_, i) => ({
  id: `plain-search-${i}`,
  display_name: i === 3 ? 'Zebra Unique' : `Alpha ${i}`,
}))

describe('ModelSelector 搜索', () => {
  it('≥8 模型时渲染搜索框，输入后只剩匹配项', async () => {
    render(<ModelSelector models={SEARCH_MODELS} selectedId="plain-search-0" onSelect={() => {}} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    const input = await screen.findByLabelText('搜索模型')
    fireEvent.change(input, { target: { value: 'Zebra' } })
    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveTextContent('Zebra Unique')
    expect(items.some((i) => i.textContent?.includes('Alpha 0'))).toBe(false)
  })

  it('无匹配时显示「无匹配模型」', async () => {
    render(<ModelSelector models={SEARCH_MODELS} selectedId="plain-search-0" onSelect={() => {}} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    const input = await screen.findByLabelText('搜索模型')
    fireEvent.change(input, { target: { value: 'no-such-model-zzz' } })
    expect(screen.getByText('无匹配模型')).toBeInTheDocument()
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
  })

  it('<8 模型不渲染搜索框', async () => {
    render(<ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={() => {}} />)
    openMenu(screen.getByRole('button', { name: '选择对话模型' }))
    await screen.findAllByRole('menuitem')
    expect(screen.queryByLabelText('搜索模型')).toBeNull()
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

describe('ModelSelector 最近使用', () => {
  afterEach(() => {
    localStorage.clear()
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
