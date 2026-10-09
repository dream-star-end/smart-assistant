import { Monitor, Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocalComposerPrefs } from '../../hooks/useLocalComposerPrefs'
import type { Theme } from '../../hooks/useTheme'
import { api, apiErrorMessage } from '../../lib/api'
import { setIntelligentUiPref, useIntelligentUiState } from '../../lib/intelligentUi'
import { longContextCostConfirmationRequired } from '../../lib/cursorModelPicker'
import {
  type PreferenceEffort,
  type PrefsView,
  initialModelFromPreferences,
} from '../../lib/modelPreferences'
import type { AuthSession, PublicModel } from '../../lib/types'
import { cn } from '../../lib/utils'
import {
  LONG_CONTEXT_CANCEL_TEXT,
  LONG_CONTEXT_CONFIRM_TEXT,
  LONG_CONTEXT_CONFIRM_TITLE,
  LongContextCostWarning,
} from '../LongContextCostWarning'
import { Alert, Button, Select, Switch, useConfirm } from '../ui'
import { QqBindingCard } from './QqBindingCard'
import { EFFORT_OPTIONS } from './labels'

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
]

/** UI 主题枚举 ↔ 后端 preferences 枚举（system ↔ auto）。 */
const uiToServerTheme = (t: Theme): 'light' | 'dark' | 'auto' => (t === 'system' ? 'auto' : t)

// 微信两开关(wechat_show_tool_calls / wechat_proactive_push)在 v5 通道下是死开关:
// v5 作为控制面 follower 硬关 wechat broker(index.ts controlPlaneEnabled 恒 false),
// binding/inbound/outbound/proactive 全链缺席,推送尝试被 master 404 静默回退 webchat。
// 在 v5 微信通道接通前(roadmap P1.2 专项决策)不渲染这两个开关,避免 UI 承诺做不到的事。
// 偏好字段本身保留(preferences.ts allowlist),将来通道接通再放回渲染。
//
// Telegram 同理(审计 SET-05):后端只有管理员告警通道(admin/alertChannels),用户侧没有任何
// 绑定入口,`notify_telegram` 打开也不会有消息送达 —— 通道接通并有绑定流程前不渲染。
const NOTIF_FIELDS: { key: keyof PrefsView; label: string; hint?: string }[] = [
  { key: 'notify_email', label: '邮件通知', hint: '支付到账、订阅到期等重要事件发送到账号邮箱' },
]

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)
}

/** 修饰键按平台显示:macOS / iOS 为 ⌘,其余为 Ctrl(发送键选项与快捷键表共用)。 */
export function modifierKeyLabel(): string {
  return isMacPlatform() ? '⌘' : 'Ctrl'
}

/**
 * 偏好 Tab：外观主题（接 useTheme，写穿到 preferences）+ 默认模型 + 思考深度 +
 * 通知开关。（Auto‑Dream「全面优化」开关随管理中心「优化」分区一起下线，OCV5-360；
 * 仍处于开启态的账号只剩一个"只能关"的出口，见 OptimizerOffRow。）快捷键是独立导航，由 SettingsCenter 直接渲染 `BuiltinHotkeysTable`
 * （不经过本组件，也不依赖 prefs）。prefs 状态由 SettingsCenter 集中持有，本组件只负责 patch。
 * 本组件受控（onPatch 返回后由父刷新快照）。
 *
 * 主题权威源仍是 useTheme（live + localStorage）；这里只在用户切换时写穿一份到
 * 后端 preferences（供跨端 / 未来登录态水合用），不在加载时反向覆盖 live 主题，
 * 避免与顶栏快捷开关互相打架。
 */
export function PreferencesTab({
  auth,
  prefs,
  theme,
  onSetTheme,
  onPatch,
}: {
  auth: AuthSession
  prefs: PrefsView
  theme: Theme
  onSetTheme: (t: Theme) => void
  /** 透传 patch 到后端（null 删除该字段）；父组件用返回快照刷新 prefs。 */
  onPatch: (patch: Record<string, unknown>) => Promise<void>
}) {
  const [models, setModels] = useState<PublicModel[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [optimizerClosing, setOptimizerClosing] = useState(false)
  const [confirmLongContext, confirmLongContextEl] = useConfirm()
  const composerPrefs = useLocalComposerPrefs()
  const iui = useIntelligentUiState()

  useEffect(() => {
    let alive = true
    api
      .getPublicModels(auth)
      .then((res) => {
        // 返回体缺 models(旧网关 / 桩)时退化为空列表,而不是让下面的 find 把整页打崩。
        if (alive) setModels(Array.isArray(res?.models) ? res.models : [])
      })
      .catch(() => {
        /* 模型列表拉取失败不致命：default_model 退化为只读展示当前值 */
      })
    return () => {
      alive = false
    }
  }, [auth])

  async function patch(p: Record<string, unknown>) {
    setErr(null)
    try {
      await onPatch(p)
    } catch (e) {
      setErr(apiErrorMessage(e, '保存失败'))
    }
  }

  /** Intelligent UI 开关:先本地生效(新回合与已有消息的渲染立即切换),写失败再回滚。 */
  async function changeIntelligentUi(checked: boolean) {
    const prev = iui.pref
    setIntelligentUiPref(checked)
    setErr(null)
    try {
      await onPatch({ intelligent_ui: checked })
    } catch (e) {
      setIntelligentUiPref(prev)
      setErr(apiErrorMessage(e, '保存失败'))
    }
  }

  function changeTheme(t: Theme) {
    onSetTheme(t) // live 权威：立即切换
    void patch({ theme: uiToServerTheme(t) }) // 写穿后端（best-effort）
  }

  async function changeDefaultModel(value: string) {
    const nextModelId = value === '' ? null : value
    if (nextModelId && longContextCostConfirmationRequired(prefs.default_model, nextModelId)) {
      const confirmed = await confirmLongContext({
        title: LONG_CONTEXT_CONFIRM_TITLE,
        body: <LongContextCostWarning />,
        confirmText: LONG_CONTEXT_CONFIRM_TEXT,
        cancelText: LONG_CONTEXT_CANCEL_TEXT,
      })
      if (!confirmed) return
    }
    await patch({ default_model: nextModelId })
  }

  const effortModelId = initialModelFromPreferences(models, prefs)
  const effortModel = models.find((m) => m.id === effortModelId)
  const supportedEfforts = effortModel?.supported_efforts ?? []
  const effortOptions = EFFORT_OPTIONS.filter((o) => supportedEfforts.includes(o.value))
  const selectedEffort: PreferenceEffort | '' =
    prefs.default_effort && supportedEfforts.includes(prefs.default_effort)
      ? prefs.default_effort
      : ''
  const effortDisabled = models.length > 0 && effortOptions.length === 0
  const modelOptions = [
    { value: '', label: '跟随智能体默认' },
    // 当前值不在可选列表里时（如已下架）仍补一条，避免显示错位
    ...(prefs.default_model && !models.some((m) => m.id === prefs.default_model)
      ? [{ value: prefs.default_model, label: prefs.default_model }]
      : []),
    ...models.map((m) => ({ value: m.id, label: modelLabel(m) })),
  ]
  const effortSelectOptions = [
    { value: '', label: effortDisabled ? '当前模型不支持' : '跟随模型默认' },
    ...effortOptions.map((o) => ({ value: o.value, label: o.label })),
  ]
  const mod = modifierKeyLabel()

  return (
    <div className="flex flex-col">
      {err && (
        <div className="px-5 pt-3">
          <Alert tone="danger" className="text-meta">
            {err}
          </Alert>
        </div>
      )}

      {/* 外观主题 */}
      <div className="px-5 py-4">
        <div className="pb-2 text-caption font-medium uppercase tracking-wide text-faint">
          外观主题
        </div>
        <div className="grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => changeTheme(o.value)}
              aria-pressed={theme === o.value}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3 text-body outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                theme === o.value
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-border text-muted hover:bg-hover hover:text-fg',
              )}
            >
              <o.icon size={18} />
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* 默认模型 + 思考深度 */}
      <div className="border-t border-border px-5 py-4">
        <div className="pb-2 text-caption font-medium uppercase tracking-wide text-faint">
          对话默认
        </div>
        {/* 下拉统一走 ui/Select(与 API 接入页同源),不再自绘一套原生 select(审计 SET-21)。 */}
        <label className="flex items-center justify-between gap-3 py-1.5">
          <span className="text-section text-fg">默认模型</span>
          <Select
            aria-label="默认模型"
            inputSize="sm"
            className="w-auto max-w-[55%]"
            value={prefs.default_model ?? ''}
            onValueChange={(v) => {
              void changeDefaultModel(v)
            }}
            options={modelOptions}
          />
        </label>
        <label className="flex items-center justify-between gap-3 py-1.5">
          <span className="text-section text-fg">思考深度</span>
          <Select
            aria-label="思考深度"
            inputSize="sm"
            className="w-auto max-w-[55%]"
            value={selectedEffort}
            onValueChange={(v) => patch({ default_effort: v === '' ? null : v })}
            disabled={effortDisabled}
            options={effortSelectOptions}
          />
        </label>
      </div>

      {/* 回答样式：Intelligent UI(OCV5-361)。偏好存服务端,跨设备生效;服务端总开关关闭时不可切换。 */}
      <div className="border-t border-border px-5 py-4">
        <div className="pb-2 text-caption font-medium uppercase tracking-wide text-faint">
          回答样式
        </div>
        <div className="flex items-start justify-between gap-4 py-1.5">
          <div className="min-w-0">
            <div className="text-section text-fg">交互式回答</div>
            <p className="mt-0.5 text-meta leading-relaxed text-muted">
              回答里直接给出表格、图表、清单、对比卡和可调的计算器,可以点选、排序、改数。关闭后只用文字回答,已有的组件也按文字显示。
            </p>
            {!iui.available && (
              <p className="mt-1 text-meta text-warning">服务端已暂停此功能。</p>
            )}
          </div>
          <Switch
            aria-label="交互式回答"
            checked={iui.available && iui.pref}
            disabled={!iui.available}
            onCheckedChange={(checked) => {
              void changeIntelligentUi(checked)
            }}
          />
        </div>
      </div>

      {/* 输入：仅本设备 */}
      <div className="border-t border-border px-5 py-4">
        <div className="pb-2 text-caption font-medium uppercase tracking-wide text-faint">
          输入
        </div>
        <p className="pb-3 text-meta text-muted">仅本设备生效</p>
        <div className="pb-2 text-section text-fg">发送键</div>
        <div className="mb-3 grid grid-cols-2 gap-2">
          {(
            [
              { value: 'enter' as const, label: 'Enter 发送' },
              // 修饰键随平台(审计 SET-20):Windows / Linux 用户看到的是 Ctrl,不是 ⌘。
              { value: 'mod-enter' as const, label: `${mod}+Enter 发送` },
            ] as const
          ).map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => composerPrefs.setSendKey(o.value)}
              aria-pressed={composerPrefs.sendKey === o.value}
              className={cn(
                'flex items-center justify-center rounded-xl border px-3 py-3 text-body outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                composerPrefs.sendKey === o.value
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-border text-muted hover:bg-hover hover:text-fg',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="pb-2 text-section text-fg">字号</div>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              { value: 'default' as const, label: '默认' },
              { value: 'large' as const, label: '大' },
            ] as const
          ).map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => composerPrefs.setFontSize(o.value)}
              aria-pressed={composerPrefs.fontSize === o.value}
              className={cn(
                'flex items-center justify-center rounded-xl border px-3 py-3 text-body outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                composerPrefs.fontSize === o.value
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-border text-muted hover:bg-hover hover:text-fg',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* 全面优化已下线：仍开着的账号只给一个关闭出口（关 = 收回授权，无需同意弹窗）；
          未开启时什么都不渲染。后端会把 auto_dream_enabled 一并置 false（normalizeAutoDreamPreferencePatch）。 */}
      {prefs.auto_optimizer_enabled === true && (
        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
          <span className="min-w-0">
            <span className="block text-section text-fg">全面优化已下线</span>
            <span className="block text-caption text-faint">关闭后不再在后台审计你的会话</span>
          </span>
          <Button
            size="sm"
            variant="secondary"
            loading={optimizerClosing}
            onClick={async () => {
              setOptimizerClosing(true)
              try {
                await patch({ auto_optimizer_enabled: false })
              } finally {
                setOptimizerClosing(false)
              }
            }}
          >
            关闭
          </Button>
        </div>
      )}

      {/* 通知 */}
      <div className="border-t border-border px-5 py-4">
        <div className="pb-2 text-caption font-medium uppercase tracking-wide text-faint">通知</div>
        <div className="mb-3">
          <QqBindingCard auth={auth} prefs={prefs} onPatch={patch} />
        </div>
        {NOTIF_FIELDS.map((f) => (
          <label key={String(f.key)} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0">
              <span className="block text-section text-fg">{f.label}</span>
              {f.hint && <span className="block text-caption text-faint">{f.hint}</span>}
            </span>
            <Switch
              checked={prefs[f.key] === true}
              onCheckedChange={(c) => patch({ [f.key]: c })}
            />
          </label>
        ))}
      </div>

      {confirmLongContextEl}
    </div>
  )
}

/** 内置快捷键只读表。由 SettingsCenter 的「快捷键」分区直接渲染,不依赖 prefs / 模型列表。 */
export function BuiltinHotkeysTable() {
  const mod = modifierKeyLabel()
  const rows: Array<{ keys: string; action: string }> = [
    { keys: `${mod}+K`, action: '搜索与跳转（项目、会话、文件）' },
    { keys: `${mod}+Shift+O`, action: '新建会话' },
    { keys: 'Esc', action: '停止生成（生成中）' },
    { keys: 'Enter / Shift+Enter', action: '发送 / 换行（桌面）' },
    { keys: `${mod}+V`, action: '粘贴图片为附件' },
    { keys: `${mod}+F`, action: '会话内查找' },
    { keys: '↑(空输入框)', action: '编辑上一条' },
  ]
  return (
    <div className="px-5 py-4">
      <div className="pb-2 text-caption font-medium uppercase tracking-wide text-faint">
        内置快捷键
      </div>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.action} className="flex items-center gap-3 rounded-lg px-2 py-1.5">
            <kbd className="shrink-0 rounded-md border border-border bg-bg px-1.5 py-0.5 font-mono text-caption text-muted">
              {row.keys}
            </kbd>
            <span className="min-w-0 flex-1 text-body text-fg">{row.action}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function modelLabel(m: PublicModel): string {
  const raw = (m as Record<string, unknown>).label ?? (m as Record<string, unknown>).name
  return typeof raw === 'string' && raw.length > 0 ? raw : m.id
}
