import {
  Bot,
  Check,
  ChevronDown,
  ListChecks,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { api, apiErrorMessage } from '../../lib/api'
import type {
  KnowledgePlanetAutomationGroup,
  KnowledgePlanetAutomationRule,
  KnowledgePlanetAutomationRun,
  KnowledgePlanetAutomationView,
  RuntimePluginAccount,
} from '../../lib/connectors'
import type { AuthSession } from '../../lib/types'
import { cn } from '../../lib/utils'
import {
  Alert,
  Badge,
  Button,
  CardRow,
  Chip,
  EmptyState,
  Field,
  Input,
  Modal,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  Spinner,
  Switch,
  Textarea,
  TimeAgo,
  useConfirm,
  useToast,
} from '../ui'

const RUN_STATUS: Record<string, string> = {
  reserved: '等待生成',
  generating: 'AI 生成中',
  ready: '等待发送',
  dispatching: '发送中',
  succeeded: '已回复',
  skipped: '已跳过',
  failed: '失败',
  unknown: '结果待核实',
}

/** 执行记录状态 → 徽章语义色:进行中 info、成功 success、跳过中性、失败 / 待核实 danger。 */
function runStatusTone(
  status: KnowledgePlanetAutomationRun['status'],
): 'info' | 'success' | 'neutral' | 'danger' {
  if (status === 'succeeded') return 'success'
  if (status === 'skipped') return 'neutral'
  if (status === 'failed' || status === 'unknown') return 'danger'
  return 'info'
}

const REASON: Record<string, string> = {
  SELF_AUTHORED: '自己的主题不自动回复',
  TRIGGER_MISMATCH: '不符合触发条件',
  DAILY_LIMIT: '达到当日限额',
  MODEL_SKIPPED: 'AI 判断无需回复',
  SOURCE_UNAVAILABLE: '主题已不可读取',
  SOURCE_CHANGED: '主题在 AI 生成后发生变化，已跳过',
  AUTHOR_UNKNOWN: '无法确认主题作者，已安全跳过',
  AUTOMATION_DISABLED: '自动回复已关闭',
  RULE_DISABLED: '规则已关闭',
  RULE_CHANGED: '规则已修改，旧任务已安全取消',
  RULE_DELETED: '规则已删除',
  MANUAL_WRITE_DISABLED: '手动写入能力已关闭',
  ACCOUNT_UNAVAILABLE: '插件账号不可用，已自动停用',
  CONSENT_OUTDATED: '免责声明版本已更新，请重新确认后启用',
  RELINK_REQUIRED: '登录已失效',
  DISPATCH_UNKNOWN: '发送结果不明确，已自动停用',
  SUCCESS_COMMIT_UNKNOWN: '发送成功但审计结果不明确，已自动停用',
  STALE_DISPATCH: '发送超时，结果需人工核实',
  STALE_GENERATION: 'AI 生成超时',
  SCAN_FAILED: '扫描新主题失败',
  CURSOR_NOT_FOUND: '主题游标失效，已暂停规则',
  GENERATION_FAILED: 'AI 生成失败',
  MODEL_UNAVAILABLE: 'AI 模型暂不可用',
}

/** 规则上限(与后端一致)。 */
const MAX_RULES = 10
/** 账号级每日上限的取值范围(与 setKnowledgePlanetAutomation 的后端校验一致)。 */
const ACCOUNT_LIMIT_MIN = 1
const ACCOUNT_LIMIT_MAX = 30

type RuleDraft = {
  groupId: string
  name: string
  instructions: string
  triggerKind: 'new_topic' | 'new_question'
  dailyLimit: string
  cooldownMinutes: string
  maxReplyChars: string
}

type RuleValues = {
  name: string
  instructions: string
  triggerKind: 'new_topic' | 'new_question'
  dailyLimit: number
  cooldownMinutes: number
  maxReplyChars: number
}

/** 校验失败要落到具体字段上(标 aria-invalid + 聚焦),不能只在底部报一句。 */
export type RuleField = Exclude<keyof RuleDraft, 'groupId'>

/** 表单控件 id:校验失败时据此聚焦;Field 的 htmlFor 也用它。 */
const RULE_FIELD_ID: Record<RuleField, string> = {
  name: 'kp-automation-rule-name',
  instructions: 'kp-automation-instructions',
  triggerKind: 'kp-automation-trigger-kind',
  dailyLimit: 'kp-automation-daily-limit',
  cooldownMinutes: 'kp-automation-cooldown',
  maxReplyChars: 'kp-automation-max-reply',
}

const EMPTY_RULE: RuleDraft = {
  groupId: '',
  name: '',
  instructions: '',
  triggerKind: 'new_topic',
  dailyLimit: '5',
  cooldownMinutes: '15',
  maxReplyChars: '800',
}

function draftFrom(rule: KnowledgePlanetAutomationRule): RuleDraft {
  return {
    groupId: rule.groupId,
    name: rule.name,
    instructions: rule.instructions,
    triggerKind: rule.triggerKind,
    dailyLimit: String(rule.dailyLimit),
    cooldownMinutes: String(rule.cooldownMinutes),
    maxReplyChars: String(rule.maxReplyChars),
  }
}

export type RuleValidation =
  | { ok: true; values: RuleValues }
  | { ok: false; field: RuleField; error: string }

export function validateRuleDraft(draft: RuleDraft): RuleValidation {
  const name = draft.name.trim()
  if (name.length === 0) return { ok: false, field: 'name', error: '请输入规则名称' }
  if (name.includes('\0')) return { ok: false, field: 'name', error: '规则名称包含无效字符' }
  if (name.length > 100)
    return { ok: false, field: 'name', error: '规则名称不能超过 100 个字符' }

  const instructions = draft.instructions.trim()
  if (instructions.length === 0)
    return { ok: false, field: 'instructions', error: '请输入回复要求' }
  if (instructions.includes('\0'))
    return { ok: false, field: 'instructions', error: '回复要求包含无效字符' }
  if (instructions.length > 4_000)
    return { ok: false, field: 'instructions', error: '回复要求不能超过 4000 个字符' }

  if (draft.triggerKind !== 'new_topic' && draft.triggerKind !== 'new_question')
    return { ok: false, field: 'triggerKind', error: '请选择有效的触发范围' }

  const dailyLimit = Number(draft.dailyLimit)
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 10)
    return { ok: false, field: 'dailyLimit', error: '每日上限必须是 1–10 的整数' }

  const cooldownMinutes = Number(draft.cooldownMinutes)
  if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 5 || cooldownMinutes > 1_440)
    return { ok: false, field: 'cooldownMinutes', error: '冷却时间必须是 5–1440 分钟的整数' }

  const maxReplyChars = Number(draft.maxReplyChars)
  if (!Number.isInteger(maxReplyChars) || maxReplyChars < 100 || maxReplyChars > 1_200)
    return { ok: false, field: 'maxReplyChars', error: '回复字符上限必须是 100–1200 的整数' }

  return {
    ok: true,
    values: {
      name,
      instructions,
      triggerKind: draft.triggerKind,
      dailyLimit,
      cooldownMinutes,
      maxReplyChars,
    },
  }
}

/** 账号级每日上限:开启前在客户端先拦一道,别让「同意并开启」点了没反应。 */
export function validateAccountLimit(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const value = Number(raw)
  if (raw.trim() === '' || !Number.isInteger(value) || value < ACCOUNT_LIMIT_MIN || value > ACCOUNT_LIMIT_MAX)
    return {
      ok: false,
      error: `每账号每日上限必须是 ${ACCOUNT_LIMIT_MIN}–${ACCOUNT_LIMIT_MAX} 的整数`,
    }
  return { ok: true, value }
}

function errorText(error: unknown, fallback: string): string {
  return apiErrorMessage(error, fallback)
}

/** 把用户带到出错的控件:先聚焦(浏览器会顺带滚进视口)。jsdom 没有 scrollIntoView,故只探测后调用。 */
function focusField(field: RuleField) {
  if (typeof document === 'undefined') return
  const el = document.getElementById(RULE_FIELD_ID[field])
  if (!el) return
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' })
  if (typeof el.focus === 'function') el.focus({ preventScroll: true })
}

export function KnowledgePlanetAutomationPanel({
  auth,
  account,
}: {
  auth: AuthSession
  account: RuntimePluginAccount
}) {
  const toast = useToast()
  const [view, setView] = useState<KnowledgePlanetAutomationView | null>(null)
  const [loading, setLoading] = useState(true)
  /**
   * 正在进行的写操作:'control'(总开关 / 同意)、'save'(规则表单)、`rule:<id>`(某一行的
   * 切换 / 删除)。改造前是一个布尔值,切一条规则会把所有行的开关和按钮一起变灰,
   * 用户分不清是在等还是坏了;按目标记键后只锁住正在操作的那一处。
   */
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const busy = busyKey !== null
  const [error, setError] = useState<string | null>(null)
  const [consentOpen, setConsentOpen] = useState(false)
  const [consentChecked, setConsentChecked] = useState(false)
  /** 同意弹层自己的错误(服务端拒绝):弹层开着时面板顶部的 Alert 在遮罩之下,等于没有反馈。 */
  const [consentError, setConsentError] = useState<string | null>(null)
  /** 账号级每日上限的客户端校验错误,落在输入框下。 */
  const [limitError, setLimitError] = useState<string | null>(null)
  const [accountLimit, setAccountLimit] = useState('10')
  const [editing, setEditing] = useState<KnowledgePlanetAutomationRule | 'new' | null>(null)
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_RULE)
  /**
   * 规则表单的错误文案,落在表单底部紧挨「保存」按钮(用户点完按钮视线就在那);
   * 客户端校验失败时同一句话只在这里出现一次,出错的字段另以 aria-invalid + 红描边 + 聚焦标出。
   */
  const [ruleError, setRuleError] = useState<string | null>(null)
  /** 当前被校验标红的字段(只有客户端校验会设;服务端拒绝不指向具体字段)。 */
  const [invalidField, setInvalidField] = useState<RuleField | null>(null)
  const [groups, setGroups] = useState<KnowledgePlanetAutomationGroup[]>([])
  const [groupsLoading, setGroupsLoading] = useState(false)
  const [groupsError, setGroupsError] = useState<string | null>(null)
  const [groupSearch, setGroupSearch] = useState('')
  const [groupPickerOpen, setGroupPickerOpen] = useState(false)
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])
  const [confirm, confirmElement] = useConfirm()
  const manualWriteEnabled = account.writeControl?.enabled === true

  const groupById = useMemo(
    () => new Map(groups.map((group) => [group.id, group])),
    [groups],
  )
  const ruleById = useMemo(
    () => new Map((view?.rules ?? []).map((rule) => [rule.id, rule])),
    [view?.rules],
  )
  const configuredGroupIds = useMemo(
    () => new Set(view?.rules.map((rule) => rule.groupId) ?? []),
    [view?.rules],
  )
  const remainingRuleSlots = Math.max(0, MAX_RULES - (view?.rules.length ?? 0))
  const selectableGroups = useMemo(
    () => groups.filter((group) => !configuredGroupIds.has(group.id)),
    [configuredGroupIds, groups],
  )
  const filteredGroups = useMemo(() => {
    const needle = groupSearch.trim().toLocaleLowerCase()
    if (!needle) return groups
    return groups.filter(
      (group) =>
        group.name.toLocaleLowerCase().includes(needle) || group.id.includes(needle),
    )
  }, [groupSearch, groups])

  const loadGroups = useCallback(async () => {
    setGroupsLoading(true)
    setGroupsError(null)
    try {
      setGroups(await api.listKnowledgePlanetAutomationGroups(auth, account.id))
    } catch (loadError) {
      setGroupsError(errorText(loadError, '加载知识星球列表失败'))
    } finally {
      setGroupsLoading(false)
    }
  }, [account.id, auth])

  const reload = useCallback(async () => {
    setError(null)
    try {
      const next = await api.getKnowledgePlanetAutomation(auth, account.id)
      setView(next)
      setAccountLimit(String(next.control.accountDailyLimit))
    } catch (loadError) {
      setError(errorText(loadError, '加载无人值守自动回复失败'))
    } finally {
      setLoading(false)
    }
  }, [account.id, auth])

  useEffect(() => {
    if (!manualWriteEnabled) setConsentOpen(false)
    setLoading(true)
    void reload()
    if (account.executable) void loadGroups()
  }, [account.executable, loadGroups, manualWriteEnabled, reload])

  const retryLoad = () => {
    setLoading(true)
    void reload()
  }

  const disableAutomation = async () => {
    if (busy) return
    setBusyKey('control')
    setError(null)
    try {
      await api.setKnowledgePlanetAutomation(auth, account.id, { enabled: false })
      await reload()
    } catch (disableError) {
      setError(errorText(disableError, '关闭无人值守自动回复失败'))
    } finally {
      setBusyKey(null)
    }
  }

  const openConsent = () => {
    setConsentChecked(false)
    setConsentError(null)
    setLimitError(null)
    setConsentOpen(true)
  }

  const closeConsent = () => {
    setConsentOpen(false)
    setConsentChecked(false)
    setConsentError(null)
    setLimitError(null)
  }

  const enableAutomation = async () => {
    if (!view || !consentChecked || busy) return
    const limit = validateAccountLimit(accountLimit)
    if (!limit.ok) {
      setLimitError(limit.error)
      document.getElementById('kp-automation-account-limit')?.focus()
      return
    }
    setBusyKey('control')
    setConsentError(null)
    setLimitError(null)
    try {
      await api.setKnowledgePlanetAutomation(auth, account.id, {
        enabled: true,
        accepted: true,
        disclaimerVersion: view.control.disclaimerVersion,
        accountDailyLimit: limit.value,
      })
      closeConsent()
      await reload()
      toast('无人值守自动回复已开启', 'success')
    } catch (enableError) {
      // 就地报错:弹层还开着,写到面板顶部的 Alert 用户根本看不见。
      setConsentError(errorText(enableError, '开启无人值守自动回复失败'))
    } finally {
      setBusyKey(null)
    }
  }

  const resetRuleForm = () => {
    setRuleError(null)
    setInvalidField(null)
    setGroupSearch('')
    setGroupPickerOpen(false)
  }

  const openNewRule = () => {
    setDraft(EMPTY_RULE)
    setSelectedGroupIds([])
    resetRuleForm()
    setEditing('new')
    void loadGroups()
  }

  const openEditRule = (rule: KnowledgePlanetAutomationRule) => {
    setDraft(draftFrom(rule))
    setSelectedGroupIds([])
    resetRuleForm()
    setEditing(rule)
    void loadGroups()
  }

  const closeRuleForm = () => {
    setEditing(null)
    resetRuleForm()
  }

  const updateDraft = (patch: Partial<RuleDraft>) => {
    setDraft((current) => ({ ...current, ...patch }))
    // 用户一动出错的字段,错误就撤:留着一条已过时的红字只会让人反复核对。
    if (invalidField && Object.keys(patch).includes(invalidField)) {
      setInvalidField(null)
      setRuleError(null)
    }
  }

  const saveRule = async () => {
    if (!editing || busy) return
    const validated = validateRuleDraft(draft)
    if (!validated.ok) {
      setRuleError(validated.error)
      setInvalidField(validated.field)
      focusField(validated.field)
      return
    }
    setBusyKey('save')
    setError(null)
    setRuleError(null)
    setInvalidField(null)
    try {
      if (editing === 'new') {
        const created = await api.createKnowledgePlanetAutomationRulesBatch(auth, account.id, {
          groupIds: selectedGroupIds,
          ...validated.values,
        })
        closeRuleForm()
        await reload()
        toast(`已保存并启用 ${created.length || selectedGroupIds.length} 条规则`, 'success')
      } else {
        await api.patchKnowledgePlanetAutomationRule(
          auth,
          account.id,
          editing.id,
          validated.values,
        )
        closeRuleForm()
        await reload()
        toast(`规则「${validated.values.name}」已保存`, 'success')
      }
    } catch (saveError) {
      setRuleError(errorText(saveError, '保存自动回复规则失败'))
    } finally {
      setBusyKey(null)
    }
  }

  const toggleRule = async (rule: KnowledgePlanetAutomationRule, enabled: boolean) => {
    if (busy) return
    setBusyKey(`toggle:${rule.id}`)
    setError(null)
    try {
      await api.patchKnowledgePlanetAutomationRule(auth, account.id, rule.id, { enabled })
      await reload()
    } catch (toggleError) {
      // 行内动作的失败就近可见:面板顶部的 Alert 在长列表里早已滚出视口。
      toast(errorText(toggleError, '切换自动回复规则失败'), 'error', {
        actionLabel: '重试',
        onAction: () => void toggleRule(rule, enabled),
      })
    } finally {
      setBusyKey(null)
    }
  }

  const deleteRule = async (rule: KnowledgePlanetAutomationRule) => {
    const accepted = await confirm({
      title: `删除规则「${rule.name}」？`,
      body: '删除后不会再扫描该星球；尚未进入发送阶段的自动回复会停止。此操作不可撤销。',
      confirmText: '删除',
      danger: true,
    })
    if (!accepted || busy) return
    setBusyKey(`delete:${rule.id}`)
    setError(null)
    try {
      await api.deleteKnowledgePlanetAutomationRule(auth, account.id, rule.id)
      await reload()
      // 行会消失 —— 结果离开了当前上下文,只有 Toast 追得上。
      toast(`已删除规则「${rule.name}」`, 'success')
    } catch (deleteError) {
      setError(errorText(deleteError, '删除自动回复规则失败'))
    } finally {
      setBusyKey(null)
    }
  }

  if (loading) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-lg bg-hover px-3 py-2 text-caption text-faint">
        <Spinner /> 加载无人值守设置…
      </div>
    )
  }

  if (!view)
    return error ? (
      <Alert
        tone="danger"
        className="mt-2"
        title="没能加载无人值守自动回复设置"
        action={
          <Button size="sm" variant="secondary" onClick={retryLoad}>
            <RefreshCw size={13} /> 重试
          </Button>
        }
      >
        {error}
      </Alert>
    ) : null

  const control = view.control
  const canAddRule = control.enabled && view.rules.length < MAX_RULES
  const addRuleHint = !control.enabled
    ? '先开启上方总开关，再添加规则。'
    : view.rules.length >= MAX_RULES
      ? `每个账号最多 ${MAX_RULES} 条规则，已达上限。`
      : null
  const groupName = (groupId: string) => groupById.get(groupId)?.name ?? `星球 ${groupId}`
  /** 校验标红:aria-invalid 给辅助技术,红描边给眼睛;文案在底部 Alert 里,不重复。 */
  const invalidProps = (field: RuleField) =>
    invalidField === field
      ? { 'aria-invalid': true as const, className: 'border-danger focus-visible:ring-danger' }
      : {}

  return (
    <div className="mt-2 rounded-xl border border-warning/30 bg-warning-soft/30 p-3 sm:p-4">
      <div className="flex flex-wrap items-start gap-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-warning-soft text-warning">
          <Bot size={17} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 basis-40">
          <div className="text-section font-semibold text-fg">无人值守自动回复</div>
          <p className="mt-0.5 text-caption leading-relaxed text-muted">
            仅自动发送带 AI 标识的文字评论；不会自动发主题、上传媒体、点赞、编辑或删除。
            默认关闭，每账号每日最多 {control.accountDailyLimit} 条。
          </p>
        </div>
        <div className="flex items-center gap-2 text-caption text-muted">
          <span>{control.enabled ? '已开启' : '已关闭'}</span>
          <Switch
            aria-label="知识星球无人值守自动回复"
            checked={control.enabled}
            disabled={
              busyKey === 'control' ||
              (!control.enabled &&
                (!control.available || !manualWriteEnabled || !account.executable))
            }
            onCheckedChange={(checked) => {
              if (checked) openConsent()
              else void disableAutomation()
            }}
          />
        </div>
      </div>

      {!manualWriteEnabled && (
        <Alert tone="warning" density="compact" className="mt-3">
          请先在插件账号里开启「写入能力」，再单独同意并开启无人值守自动回复。
        </Alert>
      )}
      {manualWriteEnabled && !control.enabled && !control.available && (
        <Alert tone="info" density="compact" className="mt-3">
          当前账号暂不支持无人值守自动回复（插件版本或账号状态不满足），总开关不可用。
        </Alert>
      )}
      {control.pausedReason && (
        <Alert tone="danger" density="compact" className="mt-3">
          已安全停用：{REASON[control.pausedReason] ?? control.pausedReason}
          。核实知识星球中的实际结果后，可重新阅读免责声明并开启。
        </Alert>
      )}
      {error && (
        <Alert
          tone="danger"
          density="compact"
          className="mt-3"
          onDismiss={() => setError(null)}
        >
          {error}
        </Alert>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-warning/20 pt-3">
        <div className="min-w-0">
          <div className="text-body font-medium text-fg">
            规则（{view.rules.length}/{MAX_RULES}）
          </div>
          {addRuleHint && <p className="mt-0.5 text-caption text-faint">{addRuleHint}</p>}
        </div>
        <Button size="sm" variant="secondary" disabled={!canAddRule || busy} onClick={openNewRule}>
          <Plus size={13} aria-hidden="true" /> 添加规则
        </Button>
      </div>

      {view.rules.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="还没有自动回复规则"
          hint={
            control.enabled
              ? '为每个要托管的星球添加一条规则，说明什么情况回复、语气与边界；没有规则时即使总开关开着也不会发任何内容。'
              : '先开启上方总开关，再为每个要托管的星球添加规则；没有规则时不会自动回复。'
          }
          action={
            canAddRule ? (
              <Button size="sm" variant="primary" disabled={busy} onClick={openNewRule}>
                <Plus size={13} aria-hidden="true" /> 添加第一条规则
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {view.rules.map((rule) => {
            const toggling = busyKey === `toggle:${rule.id}`
            const deleting = busyKey === `delete:${rule.id}`
            const rowBusy = toggling || deleting
            return (
              <li key={rule.id}>
                {/* CardRow:主名单行截断、说明最多两行;操作区在窄屏自动落到第二行右对齐 ——
                    改造前 390px 下开关 + 编辑 + 删除挤在主名旁边,主名只剩六个字。 */}
                <CardRow
                  title={rule.name}
                  description={
                    <>
                      {groupName(rule.groupId)} ·{' '}
                      {rule.triggerKind === 'new_question' ? '仅新提问' : '全部新主题'} · 每日{' '}
                      {rule.dailyLimit} 条 · 冷却 {rule.cooldownMinutes} 分钟 · 最多{' '}
                      {rule.maxReplyChars} 字
                    </>
                  }
                  meta={
                    rule.pausedReason ? (
                      <Badge tone="danger">
                        已暂停：{REASON[rule.pausedReason] ?? rule.pausedReason}
                      </Badge>
                    ) : rule.enabled && control.enabled ? (
                      <Badge tone="success">运行中</Badge>
                    ) : (
                      <Badge tone="neutral">{rule.enabled ? '待总开关开启' : '已停用'}</Badge>
                    )
                  }
                  actions={
                    <>
                      <Switch
                        aria-label={`${rule.name}（${groupName(rule.groupId)}）自动回复规则`}
                        checked={rule.enabled}
                        disabled={!control.enabled || rowBusy}
                        onCheckedChange={(checked) => void toggleRule(rule, checked)}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={rowBusy}
                        onClick={() => openEditRule(rule)}
                      >
                        <Pencil size={13} aria-hidden="true" /> 编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger hover:text-danger"
                        disabled={toggling}
                        loading={deleting}
                        onClick={() => void deleteRule(rule)}
                      >
                        {deleting ? null : <Trash2 size={13} aria-hidden="true" />} 删除
                      </Button>
                    </>
                  }
                />
              </li>
            )
          })}
        </ul>
      )}

      {view.recentRuns.length > 0 && (
        <details className="mt-4 border-t border-warning/20 pt-3 text-caption">
          <summary className="cursor-pointer rounded-md text-body font-medium text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11 [@media(hover:none)]:py-2">
            最近执行记录（{Math.min(view.recentRuns.length, 10)}）
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {view.recentRuns.slice(0, 10).map((run) => {
              const rule = ruleById.get(run.ruleId)
              return (
                <li
                  key={run.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-surface px-2.5 py-2"
                >
                  <Badge tone={runStatusTone(run.status)} size="sm">
                    {RUN_STATUS[run.status] ?? run.status}
                  </Badge>
                  <span className="min-w-0 flex-1 basis-40 truncate text-meta text-fg">
                    {rule ? rule.name : '（规则已删除）'}
                    <span className="text-faint"> · 主题 {run.sourceTopicId}</span>
                  </span>
                  <TimeAgo value={run.createdAt} className="shrink-0 text-caption text-faint" />
                  {run.reasonCode && (
                    <span
                      className={cn(
                        'basis-full text-caption',
                        run.status === 'failed' || run.status === 'unknown'
                          ? 'text-danger'
                          : 'text-muted',
                      )}
                    >
                      {REASON[run.reasonCode] ?? run.reasonCode}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </details>
      )}

      <Modal
        open={consentOpen}
        onOpenChange={(open) => {
          if (!open && busyKey !== 'control') closeConsent()
        }}
        title="开启无人值守自动回复"
        description="这是独立于手动写入的高风险开关。开启后，AI 会在你离线时自动生成并发布回复，每条回复都会消耗你的模型额度。"
        footer={
          <>
            <Button variant="ghost" size="sm" disabled={busyKey === 'control'} onClick={closeConsent}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!consentChecked}
              loading={busyKey === 'control'}
              onClick={() => void enableAutomation()}
            >
              同意并开启
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Alert tone="warning" density="compact">
            {control.disclaimerText}
          </Alert>
          <Field
            label="每账号每日最多自动回复（条）"
            hint={`${ACCOUNT_LIMIT_MIN}–${ACCOUNT_LIMIT_MAX} 条。这是账号级总量，所有规则加起来每天不会超过它。`}
            error={limitError ?? undefined}
            htmlFor="kp-automation-account-limit"
          >
            <Input
              id="kp-automation-account-limit"
              className="w-28"
              type="number"
              inputMode="numeric"
              min={ACCOUNT_LIMIT_MIN}
              max={ACCOUNT_LIMIT_MAX}
              value={accountLimit}
              onChange={(event) => {
                setAccountLimit(event.target.value)
                setLimitError(null)
              }}
            />
          </Field>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 text-meta leading-relaxed text-muted [@media(hover:none)]:min-h-11">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-accent"
              checked={consentChecked}
              onChange={(event) => setConsentChecked(event.target.checked)}
            />
            <span>我已阅读并理解风险、模型费用与责任，并同意无人值守自动发布。</span>
          </label>
          {/* 开启失败必须在弹层内报:面板顶部的 Alert 被遮罩盖住,用户只会看到按钮"点了没反应"。 */}
          {consentError && (
            <Alert tone="danger" density="compact">
              {consentError}
            </Alert>
          )}
        </div>
      </Modal>

      <Modal
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && busyKey !== 'save') closeRuleForm()
        }}
        title={editing === 'new' ? '批量添加自动回复规则' : '编辑自动回复规则'}
        description={
          editing === 'new'
            ? '新规则保存后立即启用，并从保存时刻之后的新主题开始扫描，不补发历史主题。'
            : '修改保存后立即生效；尚未发送的旧任务会被安全取消，不补发历史主题。'
        }
        footer={
          <div className="flex w-full min-w-0 flex-col gap-2">
            {ruleError && (
              <Alert tone="danger" density="compact" className="text-left">
                {ruleError}
              </Alert>
            )}
            <div className="flex justify-end gap-2 max-sm:flex-col-reverse max-sm:[&>button]:w-full">
              <Button variant="ghost" size="sm" disabled={busyKey === 'save'} onClick={closeRuleForm}>
                取消
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={editing === 'new' && selectedGroupIds.length === 0}
                loading={busyKey === 'save'}
                onClick={() => void saveRule()}
              >
                {editing === 'new' ? `保存并启用 ${selectedGroupIds.length} 条规则` : '保存规则'}
              </Button>
            </div>
          </div>
        }
      >
        <div className="grid gap-4">
          {editing === 'new' ? (
            <div className="grid gap-1.5">
              <span className="text-meta font-medium text-muted">选择知识星球（可多选）</span>
              <Popover open={groupPickerOpen} onOpenChange={setGroupPickerOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex min-h-10 w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-left text-base text-fg outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
                  >
                    <span className={selectedGroupIds.length > 0 ? '' : 'text-faint'}>
                      {selectedGroupIds.length > 0
                        ? `已选择 ${selectedGroupIds.length} 个星球`
                        : '从当前账号已加入的星球中选择'}
                    </span>
                    <ChevronDown size={14} className="shrink-0 text-faint" aria-hidden="true" />
                  </button>
                </PopoverTrigger>
                {/* 宽度跟触发器走:改造前固定 30rem,390px 下会探出弹层右缘。 */}
                <PopoverContent
                  className="w-[var(--radix-popover-trigger-width)] min-w-[16rem] p-0"
                  align="start"
                >
                  <div className="border-b border-border p-2.5">
                    <Input
                      aria-label="搜索知识星球"
                      inputSize="sm"
                      value={groupSearch}
                      placeholder="搜索星球名称或 ID"
                      onChange={(event) => setGroupSearch(event.target.value)}
                    />
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-caption text-faint">
                      <span>
                        还可选择 {Math.max(0, remainingRuleSlots - selectedGroupIds.length)} 个
                      </span>
                      <div className="flex gap-1">
                        <Button
                          variant="link"
                          size="sm"
                          disabled={selectableGroups.length === 0 || remainingRuleSlots === 0}
                          onClick={() =>
                            setSelectedGroupIds(
                              selectableGroups.slice(0, remainingRuleSlots).map((group) => group.id),
                            )
                          }
                        >
                          全选可用
                        </Button>
                        <Button
                          variant="link"
                          size="sm"
                          className="text-muted"
                          disabled={selectedGroupIds.length === 0}
                          onClick={() => setSelectedGroupIds([])}
                        >
                          清空
                        </Button>
                      </div>
                    </div>
                  </div>
                  <fieldset className="max-h-64 min-w-0 overflow-y-auto p-1.5">
                    <legend className="sr-only">可选择的知识星球</legend>
                    {groupsLoading ? (
                      <div className="flex items-center justify-center gap-2 py-8 text-caption text-faint">
                        <Spinner /> 正在读取星球列表…
                      </div>
                    ) : groupsError ? (
                      <div className="p-2">
                        <Alert
                          tone="danger"
                          density="compact"
                          action={
                            <Button variant="secondary" size="sm" onClick={() => void loadGroups()}>
                              <RefreshCw size={12} aria-hidden="true" /> 重试
                            </Button>
                          }
                        >
                          {groupsError}
                        </Alert>
                      </div>
                    ) : filteredGroups.length === 0 ? (
                      <div className="py-8 text-center text-caption text-faint">
                        {groups.length === 0 ? '当前账号没有可用星球' : '没有匹配的星球'}
                      </div>
                    ) : (
                      filteredGroups.map((group) => {
                        const configured = configuredGroupIds.has(group.id)
                        const selected = selectedGroupIds.includes(group.id)
                        const atLimit = !selected && selectedGroupIds.length >= remainingRuleSlots
                        return (
                          <button
                            key={group.id}
                            type="button"
                            // 选中态要能被读屏读到:视觉上的方框打勾对辅助技术是不存在的。
                            aria-pressed={selected}
                            disabled={configured || atLimit}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45 [@media(hover:none)]:min-h-11"
                            onClick={() =>
                              setSelectedGroupIds((current) =>
                                current.includes(group.id)
                                  ? current.filter((id) => id !== group.id)
                                  : [...current, group.id],
                              )
                            }
                          >
                            <span
                              aria-hidden="true"
                              className={cn(
                                'flex size-4 shrink-0 items-center justify-center rounded border',
                                selected
                                  ? 'border-accent bg-accent text-white'
                                  : 'border-border bg-surface',
                              )}
                            >
                              {selected && <Check size={11} />}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-meta text-fg">{group.name}</span>
                              <span className="block truncate text-caption text-faint">
                                ID {group.id}
                                {group.memberCount === null ? '' : ` · ${group.memberCount} 位成员`}
                              </span>
                            </span>
                            {configured && <span className="text-caption text-faint">已配置</span>}
                          </button>
                        )
                      })
                    )}
                  </fieldset>
                </PopoverContent>
              </Popover>
              {selectedGroupIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {/* 整枚芯片就是「移除」按钮(Chip 原语自带 ≥36px 触控靶):改造前只有 11px 的 ✕ 可点。 */}
                  {selectedGroupIds.map((groupId) => (
                    <Chip
                      key={groupId}
                      selected
                      size="sm"
                      aria-label={`移除 ${groupName(groupId)}`}
                      onClick={() =>
                        setSelectedGroupIds((current) => current.filter((id) => id !== groupId))
                      }
                    >
                      <span className="max-w-[12rem] truncate">{groupName(groupId)}</span>
                      <X size={11} aria-hidden="true" />
                    </Chip>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="grid gap-1.5">
              <span className="text-meta font-medium text-muted">知识星球</span>
              <div className="rounded-lg border border-border bg-hover px-3 py-2 text-meta text-fg">
                {groupName(draft.groupId)}
              </div>
            </div>
          )}
          {/* 标签文字保持纯词(规则名称 / 回复要求 / 触发范围):ConnectorsTab.test 按精确标签文本找控件,
              必填语义走控件自身的 aria-required,不在标签里加星号。 */}
          <Field
            label="规则名称"
            htmlFor={RULE_FIELD_ID.name}
            hint="最多 100 字，用来在列表里认出这条规则。"
          >
            <Input
              id={RULE_FIELD_ID.name}
              aria-required="true"
              value={draft.name}
              maxLength={100}
              placeholder="例：产品经理营 · 新提问自动答疑"
              onChange={(event) => updateDraft({ name: event.target.value })}
              {...invalidProps('name')}
            />
          </Field>
          <Field
            label="回复要求"
            htmlFor={RULE_FIELD_ID.instructions}
            hint="说明什么情况回复、语气、事实边界与应跳过的主题；最多 4000 字。"
          >
            <Textarea
              id={RULE_FIELD_ID.instructions}
              aria-required="true"
              value={draft.instructions}
              maxLength={4000}
              rows={6}
              placeholder="例：只回答与产品方法论直接相关的提问，先给结论再给两条依据；涉及公司内部数据、薪资、法律问题一律跳过。"
              onChange={(event) => updateDraft({ instructions: event.target.value })}
              {...invalidProps('instructions')}
            />
          </Field>
          <Field label="触发范围" htmlFor={RULE_FIELD_ID.triggerKind}>
            <Select
              id={RULE_FIELD_ID.triggerKind}
              value={draft.triggerKind}
              onValueChange={(value) =>
                updateDraft({ triggerKind: value as RuleDraft['triggerKind'] })
              }
              options={[
                { value: 'new_topic', label: '全部新主题' },
                { value: 'new_question', label: '仅新提问' },
              ]}
              {...(invalidField === 'triggerKind' ? { 'aria-invalid': true } : {})}
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="每日上限（条）" htmlFor={RULE_FIELD_ID.dailyLimit} hint="1–10">
              <Input
                id={RULE_FIELD_ID.dailyLimit}
                type="number"
                inputMode="numeric"
                min={1}
                max={10}
                value={draft.dailyLimit}
                onChange={(event) => updateDraft({ dailyLimit: event.target.value })}
                {...invalidProps('dailyLimit')}
              />
            </Field>
            <Field label="冷却（分钟）" htmlFor={RULE_FIELD_ID.cooldownMinutes} hint="5–1440">
              <Input
                id={RULE_FIELD_ID.cooldownMinutes}
                type="number"
                inputMode="numeric"
                min={5}
                max={1440}
                value={draft.cooldownMinutes}
                onChange={(event) => updateDraft({ cooldownMinutes: event.target.value })}
                {...invalidProps('cooldownMinutes')}
              />
            </Field>
            <Field label="回复字数上限" htmlFor={RULE_FIELD_ID.maxReplyChars} hint="100–1200">
              <Input
                id={RULE_FIELD_ID.maxReplyChars}
                type="number"
                inputMode="numeric"
                min={100}
                max={1200}
                value={draft.maxReplyChars}
                onChange={(event) => updateDraft({ maxReplyChars: event.target.value })}
                {...invalidProps('maxReplyChars')}
              />
            </Field>
          </div>
        </div>
      </Modal>
      {confirmElement}
    </div>
  )
}
