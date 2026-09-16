import { Check, KeyRound, Loader2, ShieldCheck, Store, Users } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME } from '@openclaude/protocol'
import { type Agent, MAIN_AGENT, agentFromApiRow } from '../lib/agents'
import { api } from '../lib/api'
import {
  ADVISOR_ENABLED_HINT,
  ADVISOR_PARENT_BLOCK_REASON,
  ADVISOR_UNAVAILABLE_REASON,
  advisorParentCapabilityAllowed,
} from '../lib/collaborationConfig'
import { PRODUCT_CAPABILITIES } from '../lib/productCapabilities'
import type { AuthSession } from '../lib/types'
import { cn } from '../lib/utils'
import { AgentAvatar } from './AgentAvatar'
import { Badge, Button, ListSkeleton, Modal, Select, Switch } from './ui'

/**
 * B-positioning agent picker: lists the user's agents from /api/marketplace/my-agents
 * (default 全能助手 + installed market agents), not a hardcoded set. "从市场添加"
 * routes to the marketplace agent tab.
 *
 * 布局:「全能助手」(main,默认) 单独占满宽度作 featured 卡,团队模式开关是它的**内嵌页脚**
 * (同一 bordered 块,顶部分隔线)——开关语义上属于全能助手,视觉上不打乱下方 agent 网格。
 * 其它已安装 agent + 市场入口走 2 列均匀网格。团队模式是 turn 级 flag(App 持 teamMode,
 * 只在 agent.id==='main' 时随消息发送),故换 agent 不影响、可随时切。
 */
export function AgentPicker({
  open,
  current,
  auth,
  teamMode = false,
  collabMode,
  advisorModels = [],
  advisorModel,
  advisorUnavailableReason,
  advisorConsultParents = [],
  advisorConsultParentReason,
  advisorConsultAllowed,
  parentEngine,
  collabSaveError,
  asDefault,
  onAsDefaultChange,
  onClose,
  onPick,
  onAddFromMarket,
  onToggleTeamMode,
  onCollabModeChange,
  onAdvisorModelChange,
  onOpenPluginAuth,
}: {
  open: boolean
  current: Agent
  auth: AuthSession | null
  teamMode?: boolean
  collabMode?: 'solo' | 'advisor' | 'team'
  advisorModels?: Array<{ id: string; label: string; engine: string }>
  advisorModel?: string | null
  advisorUnavailableReason?: string
  advisorConsultParents?: readonly string[]
  advisorConsultParentReason?: string
  advisorConsultAllowed?: boolean
  parentEngine?: string | null
  collabSaveError?: string | null
  asDefault?: boolean
  onAsDefaultChange?: (v: boolean) => void
  onClose: () => void
  onPick: (a: Agent) => void
  onAddFromMarket?: () => void
  onToggleTeamMode?: (v: boolean) => void
  onCollabModeChange?: (mode: 'solo' | 'advisor' | 'team') => void
  onAdvisorModelChange?: (id: string) => void
  /**
   * 未就绪智能体(Plugin 待授权 / 能力待修复)的恢复入口(C-06):传入则卡片内出现「去授权」并可点整卡跳转
   * (调用方通常接到管理中心插件页);不传则卡片只保留说明,不阻塞合入。
   */
  onOpenPluginAuth?: (agent: Agent) => void
}) {
  const mode = collabMode ?? (teamMode ? 'team' : 'solo')
  const advisorBlocked = !advisorParentCapabilityAllowed({
    parentEngine,
    advisorConsultParents,
    advisorConsultAllowed,
  })
  // 服务端下发的原因文案优先;前端兜底句统一走 collaborationConfig 常量(OCV5-220),
  // 与 sendCollabFields 同源,不再带「一期 / CCB」这类内部代号(审计 C-32 的诉求由常量兑现)。
  const advisorBlockReason = advisorConsultParentReason || ADVISOR_PARENT_BLOCK_REASON
  const [agents, setAgents] = useState<Agent[]>([MAIN_AGENT])
  const [loading, setLoading] = useState(false)
  const advisorSelectId = useId()

  useEffect(() => {
    if (!open || !auth) return
    let alive = true
    setLoading(true)
    api
      .listMyAgents(auth)
      .then((rows) => {
        if (!alive) return
        const mapped = rows.map(agentFromApiRow)
        setAgents(mapped.length > 0 ? mapped : [MAIN_AGENT])
      })
      .catch(() => alive && setAgents([MAIN_AGENT]))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [open, auth])

  const defaultAgent = agents.find((a) => a.isDefault) ?? MAIN_AGENT
  const others = agents.filter((a) => !a.isDefault)
  const defaultActive = defaultAgent.id === current.id

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="选择智能体"
      description="全能助手与官方预设助手开箱即用，更多智能体可从市场安装。"
      className="max-w-2xl"
    >
      {/* 已有列表时的重拉只给一行轻提示;首次加载(网格还空着)改在网格位置放骨架卡(见下),避免先空后跳(C-33)。 */}
      {loading && others.length > 0 && (
        <div className="mb-2 flex items-center gap-2 text-meta text-faint">
          <Loader2 size={13} className="animate-spin" /> 加载你的智能体…
        </div>
      )}

      {/* 全能助手(默认)—— featured 整块占满宽度,团队模式开关为其内嵌页脚 */}
      <div
        className={cn(
          'mb-3 overflow-hidden rounded-xl border transition-colors',
          defaultActive ? 'border-accent' : 'border-accent/35',
        )}
      >
        <button
          type="button"
          data-product-feature={PRODUCT_CAPABILITIES.agents.id}
          onClick={() => onPick(defaultAgent)}
          className={cn(
            'flex w-full items-start gap-3 p-3.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
            defaultActive ? 'bg-accent-soft' : 'bg-accent-soft/40 hover:bg-accent-soft',
          )}
        >
          <AgentAvatar
            agent={defaultAgent}
            className="size-10 rounded-lg shadow-sm"
            iconSize={19}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="text-[14.5px] font-semibold text-fg">{defaultAgent.name}</span>
              <span className="rounded bg-accent/15 px-1.5 py-0.5 text-micro font-medium text-accent">
                默认
              </span>
              {defaultActive && <Check size={14} className="text-accent" />}
            </span>
            <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted">
              {defaultAgent.description}
            </span>
          </span>
        </button>

        {onCollabModeChange ? (
          <div className="flex flex-col gap-2 border-t border-accent/20 bg-surface/70 px-3.5 py-2.5">
            <span className="text-meta font-semibold text-fg">协作方式</span>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
              <button
                type="button"
                data-product-feature="agents"
                aria-pressed={mode === 'solo'}
                onClick={() => onCollabModeChange('solo')}
                className={cn(
                  "rounded-lg border px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  mode === 'solo'
                    ? "border-accent bg-accent-soft text-fg"
                    : "border-border bg-surface text-muted hover:border-border-strong",
                )}
              >
                <span className="flex items-center gap-1 text-[12.5px] font-semibold">单人</span>
                <span className="mt-0.5 block text-[11px] leading-snug">主模型独立完成</span>
              </button>
              <button
                type="button"
                data-product-feature="advisor-mode"
                data-product-control
                aria-pressed={mode === 'advisor'}
                disabled={advisorBlocked}
                title={advisorBlocked ? advisorBlockReason : undefined}
                onClick={() => {
                  if (advisorBlocked) return
                  onCollabModeChange('advisor')
                }}
                className={cn(
                  "rounded-lg border px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-65",
                  mode === 'advisor'
                    ? "border-accent bg-accent-soft text-fg"
                    : "border-border bg-surface text-muted hover:border-border-strong",
                )}
              >
                <span className="flex items-center gap-1 text-[12.5px] font-semibold">
                  <ShieldCheck size={13} />
                  顾问
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug">
                  {advisorBlocked ? advisorBlockReason : ADVISOR_ENABLED_HINT}
                </span>
              </button>
              <button
                type="button"
                data-product-feature="team-mode"
                data-product-control
                aria-pressed={mode === 'team'}
                onClick={() => onCollabModeChange('team')}
                className={cn(
                  "rounded-lg border px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  mode === 'team'
                    ? "border-accent bg-accent-soft text-fg"
                    : "border-border bg-surface text-muted hover:border-border-strong",
                )}
              >
                <span className="flex items-center gap-1 text-[12.5px] font-semibold">
                  <Users size={13} />
                  团队
                </span>
                {/* 审计 C-32:副标题不再手抄内部代号,引擎展示名与下方说明 / ModelSelector 同源
                    (@openclaude/protocol DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME)。 */}
                <span className="mt-0.5 block text-[11px] leading-snug">
                  队长切换为 {DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME} 并委派已安装智能体
                </span>
              </button>
            </div>
            {mode === 'team' && (
              <span className="text-[11.5px] leading-snug text-muted">
                开启后队长引擎将切换为 {DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME}（计费高于默认模型），并按需委派已安装智能体组队协作。每次委派按对应智能体的模型计费。
              </span>
            )}
            {mode === 'advisor' && (
              <div className="flex flex-col gap-1.5">
                {advisorModels.length > 0 ? (
                  <label htmlFor={advisorSelectId} className="text-[11.5px] leading-snug text-muted">
                    顾问型号
                    {/* 合并取舍(发布预演 t-1279):控件沿用 ui/Select(审计 C-33,设计系统同构、jsdom 可测),
                        语义取 canonical OCV5-223 —— 已配置的顾问不在可用列表时不再静默回退到第一项,
                        而是 value="" + 占位项 + 一行警示,由用户自己重选。 */}
                    {advisorModel && !advisorModels.some((row) => row.id === advisorModel) ? (
                      <span className="mt-1 block text-warning">
                        已配置的顾问 {advisorModel} 当前不可用，请重新选择。不会自动改成别的型号。
                      </span>
                    ) : null}
                    <Select
                      id={advisorSelectId}
                      className="mt-1"
                      inputSize="sm"
                      value={
                        advisorModel && advisorModels.some((row) => row.id === advisorModel)
                          ? advisorModel
                          : ''
                      }
                      placeholder={
                        advisorModel && !advisorModels.some((row) => row.id === advisorModel)
                          ? '请重新选择顾问型号'
                          : '选择顾问型号'
                      }
                      onValueChange={(id) => {
                        if (id) onAdvisorModelChange?.(id)
                      }}
                      options={advisorModels.map((row) => ({
                        value: row.id,
                        label: `${row.label}（${row.engine}）`,
                      }))}
                      data-product-control
                      aria-label="选择顾问型号"
                    />
                  </label>
                ) : (
                  <span className="text-[11.5px] leading-snug text-warning">
                    {advisorUnavailableReason || ADVISOR_UNAVAILABLE_REASON}
                  </span>
                )}
                <span className="text-[11.5px] leading-snug text-muted">
                  顾问只出主意，不能改文件、跑命令或再派人。主模型必须用证据验证建议后再交付。咨询按实际顾问型号计费，不承诺更省。
                </span>
              </div>
            )}
            {onAsDefaultChange && (
              // 保持原生 checkbox(App.test / ocv5-210 真浏览器用例按 checkbox 契约 check/isChecked),
              // 只把控件尺寸与触控行高对齐设计系统(C-33)。
              <label className="flex items-center gap-2 text-[11.5px] text-muted [@media(hover:none)]:min-h-11">
                <input
                  type="checkbox"
                  checked={!!asDefault}
                  onChange={(e) => onAsDefaultChange(e.target.checked)}
                  data-product-control
                  className="size-4 shrink-0 cursor-pointer rounded border-border accent-accent"
                />
                同时设为新对话的默认协作方式
              </label>
            )}
            {collabSaveError && (
              <span className="text-[11.5px] leading-snug text-danger">{collabSaveError}</span>
            )}
          </div>
        ) : onToggleTeamMode ? (
          <div className="flex items-center justify-between gap-3 border-t border-accent/20 bg-surface/70 px-3.5 py-2.5">
            <span className="flex min-w-0 flex-col">
              <span className="flex items-center gap-1.5 text-meta font-semibold text-fg">
                <Users size={13} className="text-accent" /> 团队模式
              </span>
              <span className="mt-0.5 text-[11.5px] leading-snug text-muted">
                开启后队长引擎将切换为 {DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME}（计费高于默认模型），并按需委派已安装智能体组队协作。每次委派按对应智能体的模型计费。
              </span>
            </span>
            <Switch
              data-product-feature={PRODUCT_CAPABILITIES.teamMode.id}
              checked={teamMode}
              onCheckedChange={onToggleTeamMode}
              aria-label="启用团队模式"
            />
          </div>
        ) : null}
      </div>

      {/* 其它已安装 agent + 市场入口 —— 2 列均匀网格 */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {loading && others.length === 0 && <ListSkeleton variant="card" rows={2} className="contents" />}
        {others.map((a) => {
          const active = a.id === current.id
          const unavailable = a.ready === false
          const needsAuth = (a.needsAuthorization?.length ?? 0) > 0
          const whyId = `agent-unavailable-${a.id}`
          if (unavailable) {
            // 不可用卡此前整卡 disabled(C-06):不可聚焦、读屏读不到原因、也没有任何去处理的入口。
            // 现在保持可聚焦(aria-disabled 表达「不能选」),说明文案挂 aria-describedby,并在传入
            // onOpenPluginAuth 时提供「去授权」—— 整卡点击同样跳转,不会静默无反应。
            // 作为 agents 的教程 CTA 入口登记(data-product-feature):教程正文「按任务而不是名字选择」
            // 已描述待授权 / 待修复卡与「去授权 / 去处理」(t-1046,agents v5),q-1076 的临时降级到此恢复。
            return (
              <div
                key={a.id}
                data-testid={`agent-card-unavailable-${a.id}`}
                className="flex flex-col overflow-hidden rounded-xl border border-warning/35 bg-warning-soft/25"
              >
                <button
                  type="button"
                  data-product-feature={PRODUCT_CAPABILITIES.agents.id}
                  aria-disabled="true"
                  aria-describedby={whyId}
                  title={onOpenPluginAuth ? '前往授权 / 修复所需能力' : undefined}
                  onClick={() => onOpenPluginAuth?.(a)}
                  className={cn(
                    'flex w-full items-start gap-3 p-3.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                    onOpenPluginAuth ? 'hover:bg-warning-soft/60' : 'cursor-default',
                  )}
                >
                  <AgentAvatar agent={a} className="size-10 rounded-lg opacity-80 shadow-sm" iconSize={19} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="text-[14.5px] font-semibold text-fg">{a.name}</span>
                      {a.preset && <Badge tone="accent">预设</Badge>}
                      <Badge tone="warning">{needsAuth ? 'Plugin 待授权' : '能力待修复'}</Badge>
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted">
                      {a.description}
                    </span>
                    <span id={whyId} className="mt-1 block text-[11.5px] leading-snug text-warning">
                      {needsAuth
                        ? `有 ${a.needsAuthorization?.length ?? 0} 项插件待授权，完成授权后即可使用`
                        : '所需能力暂不可用，修复后即可使用'}
                    </span>
                  </span>
                </button>
                {onOpenPluginAuth && (
                  <div className="flex justify-end border-t border-warning/25 px-3 py-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      data-product-control
                      onClick={() => onOpenPluginAuth(a)}
                    >
                      <KeyRound size={13} />
                      {needsAuth ? '去授权' : '去处理'}
                    </Button>
                  </div>
                )}
              </div>
            )
          }
          return (
            <button
              type="button"
              data-product-feature={PRODUCT_CAPABILITIES.agents.id}
              key={a.id}
              onClick={() => onPick(a)}
              className={cn(
                'group flex items-start gap-3 rounded-xl border p-3.5 text-left outline-none transition-[transform,box-shadow,border-color,background-color] duration-150 ease-standard focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                active
                  ? 'border-accent bg-accent-soft'
                  : 'border-border bg-surface hover:-translate-y-0.5 hover:border-border-strong hover:shadow-soft',
              )}
            >
              <AgentAvatar agent={a} className="size-10 rounded-lg shadow-sm" iconSize={19} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="text-[14.5px] font-semibold text-fg">{a.name}</span>
                  {a.preset && <Badge tone="accent">预设</Badge>}
                  {active && <Check size={14} className="text-accent" />}
                </span>
                <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted">
                  {a.description}
                </span>
              </span>
            </button>
          )
        })}

        {onAddFromMarket && (
          <button
            type="button"
            data-product-feature={PRODUCT_CAPABILITIES.marketplace.id}
            onClick={onAddFromMarket}
            className="group flex items-center justify-center gap-2 rounded-xl border border-dashed border-border p-3.5 text-section text-muted outline-none transition-colors hover:border-accent/50 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Store size={16} />
            从市场添加更多智能体
          </button>
        )}
      </div>
    </Modal>
  )
}
