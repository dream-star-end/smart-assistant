import { Bot, Check, ChevronDown, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { api, apiErrorMessage } from '../../lib/api'
import type {
  KnowledgePlanetAutomationGroup,
  KnowledgePlanetAutomationRule,
  KnowledgePlanetAutomationView,
  RuntimePluginAccount,
} from '../../lib/connectors'
import type { AuthSession } from '../../lib/types'
import {
  Alert,
  Button,
  Input,
  Modal,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
  Switch,
  Textarea,
  useConfirm,
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

function validateRuleDraft(
  draft: RuleDraft,
): { ok: true; values: RuleValues } | { ok: false; error: string } {
  const name = draft.name.trim()
  if (name.length === 0) return { ok: false, error: '请输入规则名称' }
  if (name.includes('\0')) return { ok: false, error: '规则名称包含无效字符' }
  if (name.length > 100) return { ok: false, error: '规则名称不能超过 100 个字符' }

  const instructions = draft.instructions.trim()
  if (instructions.length === 0) return { ok: false, error: '请输入回复要求' }
  if (instructions.includes('\0')) return { ok: false, error: '回复要求包含无效字符' }
  if (instructions.length > 4_000)
    return { ok: false, error: '回复要求不能超过 4000 个字符' }

  if (draft.triggerKind !== 'new_topic' && draft.triggerKind !== 'new_question')
    return { ok: false, error: '请选择有效的触发范围' }

  const dailyLimit = Number(draft.dailyLimit)
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 10)
    return { ok: false, error: '每日上限必须是 1–10 的整数' }

  const cooldownMinutes = Number(draft.cooldownMinutes)
  if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 5 || cooldownMinutes > 1_440)
    return { ok: false, error: '冷却时间必须是 5–1440 分钟的整数' }

  const maxReplyChars = Number(draft.maxReplyChars)
  if (!Number.isInteger(maxReplyChars) || maxReplyChars < 100 || maxReplyChars > 1_200)
    return { ok: false, error: '回复字符上限必须是 100–1200 的整数' }

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

function errorText(error: unknown, fallback: string): string {
  return apiErrorMessage(error, fallback)
}

export function KnowledgePlanetAutomationPanel({
  auth,
  account,
}: {
  auth: AuthSession
  account: RuntimePluginAccount
}) {
  const [view, setView] = useState<KnowledgePlanetAutomationView | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [consentOpen, setConsentOpen] = useState(false)
  const [consentChecked, setConsentChecked] = useState(false)
  const [accountLimit, setAccountLimit] = useState('10')
  const [editing, setEditing] = useState<KnowledgePlanetAutomationRule | 'new' | null>(null)
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_RULE)
  const [ruleError, setRuleError] = useState<string | null>(null)
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
  const configuredGroupIds = useMemo(
    () => new Set(view?.rules.map((rule) => rule.groupId) ?? []),
    [view?.rules],
  )
  const remainingRuleSlots = Math.max(0, 10 - (view?.rules.length ?? 0))
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

  const disableAutomation = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.setKnowledgePlanetAutomation(auth, account.id, { enabled: false })
      await reload()
    } catch (disableError) {
      setError(errorText(disableError, '关闭无人值守自动回复失败'))
    } finally {
      setBusy(false)
    }
  }

  const enableAutomation = async () => {
    if (!view || !consentChecked || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.setKnowledgePlanetAutomation(auth, account.id, {
        enabled: true,
        accepted: true,
        disclaimerVersion: view.control.disclaimerVersion,
        accountDailyLimit: Number(accountLimit),
      })
      setConsentOpen(false)
      setConsentChecked(false)
      await reload()
    } catch (enableError) {
      setError(errorText(enableError, '开启无人值守自动回复失败'))
    } finally {
      setBusy(false)
    }
  }

  const openNewRule = () => {
    setDraft(EMPTY_RULE)
    setRuleError(null)
    setSelectedGroupIds([])
    setGroupSearch('')
    setEditing('new')
    void loadGroups()
  }

  const openEditRule = (rule: KnowledgePlanetAutomationRule) => {
    setDraft(draftFrom(rule))
    setRuleError(null)
    setSelectedGroupIds([])
    setEditing(rule)
    void loadGroups()
  }

  const saveRule = async () => {
    if (!editing || busy) return
    const validated = validateRuleDraft(draft)
    if (!validated.ok) {
      setRuleError(validated.error)
      return
    }
    setBusy(true)
    setError(null)
    setRuleError(null)
    try {
      if (editing === 'new') {
        await api.createKnowledgePlanetAutomationRulesBatch(auth, account.id, {
          groupIds: selectedGroupIds,
          ...validated.values,
        })
      } else {
        await api.patchKnowledgePlanetAutomationRule(
          auth,
          account.id,
          editing.id,
          validated.values,
        )
      }
      setEditing(null)
      await reload()
    } catch (saveError) {
      setRuleError(errorText(saveError, '保存自动回复规则失败'))
    } finally {
      setBusy(false)
    }
  }

  const toggleRule = async (rule: KnowledgePlanetAutomationRule, enabled: boolean) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.patchKnowledgePlanetAutomationRule(auth, account.id, rule.id, { enabled })
      await reload()
    } catch (toggleError) {
      setError(errorText(toggleError, '切换自动回复规则失败'))
    } finally {
      setBusy(false)
    }
  }

  const deleteRule = async (rule: KnowledgePlanetAutomationRule) => {
    const accepted = await confirm({
      title: `删除规则「${rule.name}」?`,
      body: '删除后不会再扫描该星球；尚未进入发送阶段的自动回复会停止。此操作不可撤销。',
      confirmText: '删除',
      danger: true,
    })
    if (!accepted || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteKnowledgePlanetAutomationRule(auth, account.id, rule.id)
      await reload()
    } catch (deleteError) {
      setError(errorText(deleteError, '删除自动回复规则失败'))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-lg bg-hover px-3 py-2 text-[11.5px] text-faint">
        <Spinner /> 加载无人值守设置…
      </div>
    )
  }

  if (!view)
    return error ? (
      <Alert tone="danger" className="mt-2">
        {error}
      </Alert>
    ) : null

  return (
    <div className="mt-2 rounded-xl border border-warning/30 bg-warning-soft/30 p-3">
      <div className="flex flex-wrap items-start gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning-soft text-warning">
          <Bot size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-fg">无人值守自动回复</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-faint">
            仅自动发送带 AI 标识的文字评论；不会自动发主题、上传媒体、点赞、编辑或删除。
            默认关闭，每账号每日最多 {view.control.accountDailyLimit} 条。
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11.5px] text-muted">
          <span>{view.control.enabled ? '已开启' : '已关闭'}</span>
          <Switch
            aria-label="知识星球无人值守自动回复"
            checked={view.control.enabled}
            disabled={
              busy ||
              (!view.control.enabled &&
                (!view.control.available || !manualWriteEnabled || !account.executable))
            }
            onCheckedChange={(checked) => {
              if (checked) {
                setConsentChecked(false)
                setConsentOpen(true)
              } else {
                void disableAutomation()
              }
            }}
          />
        </div>
      </div>

      {!manualWriteEnabled && (
        <Alert tone="warning" className="mt-2 text-[11.5px]">
          请先开启上方“写入能力”，再单独同意并开启无人值守自动回复。
        </Alert>
      )}
      {view.control.pausedReason && (
        <Alert tone="danger" className="mt-2 text-[11.5px]">
          已安全停用：{REASON[view.control.pausedReason] ?? view.control.pausedReason}
          。核实知识星球中的实际结果后，可重新阅读免责声明并开启。
        </Alert>
      )}
      {error && (
        <Alert tone="danger" className="mt-2 text-[11.5px]">
          {error}
        </Alert>
      )}

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-warning/20 pt-3">
        <div className="text-[11.5px] font-medium text-fg">规则（{view.rules.length}/10）</div>
        <Button
          size="sm"
          variant="secondary"
          disabled={!view.control.enabled || busy || view.rules.length >= 10}
          onClick={openNewRule}
        >
          <Plus size={13} /> 添加规则
        </Button>
      </div>

      {view.rules.length === 0 ? (
        <p className="py-3 text-center text-[11.5px] text-faint">
          尚无规则；即使总开关开启也不会自动回复。
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {view.rules.map((rule) => (
            <li key={rule.id} className="rounded-lg border border-border bg-surface p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-fg">{rule.name}</div>
                  <div className="mt-0.5 text-[10.5px] text-faint">
                    {groupById.get(rule.groupId)?.name ?? `星球 ${rule.groupId}`} ·{' '}
                    {rule.triggerKind === 'new_question' ? '仅新提问' : '全部新主题'} · 每日{' '}
                    {rule.dailyLimit} 条 · 冷却 {rule.cooldownMinutes} 分钟
                  </div>
                  {rule.pausedReason && (
                    <div className="mt-1 text-[10.5px] text-danger">
                      已暂停：{REASON[rule.pausedReason] ?? rule.pausedReason}
                    </div>
                  )}
                </div>
                <Switch
                  aria-label={`${rule.name}（${groupById.get(rule.groupId)?.name ?? rule.groupId}）自动回复规则`}
                  checked={rule.enabled}
                  disabled={!view.control.enabled || busy}
                  onCheckedChange={(checked) => void toggleRule(rule, checked)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => openEditRule(rule)}
                >
                  <Pencil size={12} /> 编辑
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger"
                  disabled={busy}
                  onClick={() => void deleteRule(rule)}
                >
                  <Trash2 size={12} /> 删除
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {view.recentRuns.length > 0 && (
        <details className="mt-3 border-t border-warning/20 pt-2 text-[11px]">
          <summary className="cursor-pointer text-muted">最近执行记录</summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {view.recentRuns.slice(0, 10).map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded bg-hover px-2 py-1.5"
              >
                <span className="text-faint">主题 {run.sourceTopicId}</span>
                <span
                  className={
                    run.status === 'unknown' || run.status === 'failed'
                      ? 'text-danger'
                      : 'text-muted'
                  }
                >
                  {RUN_STATUS[run.status] ?? run.status}
                  {run.reasonCode ? ` · ${REASON[run.reasonCode] ?? run.reasonCode}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <Modal
        open={consentOpen}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setConsentOpen(false)
            setConsentChecked(false)
          }
        }}
        title="开启无人值守自动回复"
        description="这是独立于手动写入的高风险开关。开启后，新主题可在你离线时由 AI 自动计费并发布回复。"
        footer={
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConsentOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!consentChecked || busy}
              onClick={() => void enableAutomation()}
            >
              {busy ? '正在开启…' : '同意并开启'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Alert tone="warning" className="text-[12px] leading-relaxed">
            {view.control.disclaimerText}
          </Alert>
          <label
            htmlFor="kp-automation-account-limit"
            className="flex items-center gap-2 text-[12px] text-muted"
          >
            每账号每日最多
            <Input
              id="kp-automation-account-limit"
              className="w-20"
              type="number"
              min={1}
              max={30}
              value={accountLimit}
              onChange={(event) => setAccountLimit(event.target.value)}
            />
            条自动回复
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 text-[12px] leading-relaxed text-muted">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-accent"
              checked={consentChecked}
              onChange={(event) => setConsentChecked(event.target.checked)}
            />
            <span>我已阅读并理解风险、模型费用与责任，并同意无人值守自动发布。</span>
          </label>
        </div>
      </Modal>

      <Modal
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setEditing(null)
            setRuleError(null)
            setGroupPickerOpen(false)
          }
        }}
        title={editing === 'new' ? '批量添加自动回复规则' : '编辑自动回复规则'}
        description="新规则保存后立即启用，并从保存时刻之后的新主题开始扫描，不补发历史主题。"
        footer={
          <div className="flex w-full min-w-0 flex-col gap-2">
            {ruleError && (
              <Alert tone="danger" className="text-left text-[11.5px]">
                {ruleError}
              </Alert>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(null)}>
                取消
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={busy || (editing === 'new' && selectedGroupIds.length === 0)}
                onClick={() => void saveRule()}
              >
                {busy
                  ? '正在保存…'
                  : editing === 'new'
                    ? `保存并启用 ${selectedGroupIds.length} 条规则`
                    : '保存规则'}
              </Button>
            </div>
          </div>
        }
      >
        <div className="grid gap-3">
          {editing === 'new' ? (
            <div className="grid gap-1 text-[11.5px] text-muted">
              <span>选择知识星球（可多选）</span>
              <Popover open={groupPickerOpen} onOpenChange={setGroupPickerOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex min-h-9 w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-left text-[12px] text-fg outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className={selectedGroupIds.length > 0 ? '' : 'text-faint'}>
                      {selectedGroupIds.length > 0
                        ? `已选择 ${selectedGroupIds.length} 个星球`
                        : '从当前账号已加入的星球中选择'}
                    </span>
                    <ChevronDown size={14} className="shrink-0 text-faint" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-[min(30rem,calc(100vw-2rem))] p-0" align="start">
                  <div className="border-b border-border p-2.5">
                    <Input
                      aria-label="搜索知识星球"
                      value={groupSearch}
                      placeholder="搜索星球名称或 ID"
                      onChange={(event) => setGroupSearch(event.target.value)}
                    />
                    <div className="mt-2 flex items-center justify-between gap-2 text-[10.5px] text-faint">
                      <span>
                        还可选择 {Math.max(0, remainingRuleSlots - selectedGroupIds.length)} 个
                      </span>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          className="rounded px-1.5 py-1 text-accent hover:bg-accent-soft disabled:text-faint"
                          disabled={selectableGroups.length === 0 || remainingRuleSlots === 0}
                          onClick={() =>
                            setSelectedGroupIds(
                              selectableGroups.slice(0, remainingRuleSlots).map((group) => group.id),
                            )
                          }
                        >
                          选择可用
                        </button>
                        <button
                          type="button"
                          className="rounded px-1.5 py-1 text-muted hover:bg-hover disabled:text-faint"
                          disabled={selectedGroupIds.length === 0}
                          onClick={() => setSelectedGroupIds([])}
                        >
                          清空
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="max-h-64 overflow-y-auto p-1.5">
                    {groupsLoading ? (
                      <div className="flex items-center justify-center gap-2 py-8 text-[11.5px] text-faint">
                        <Spinner /> 正在读取星球列表…
                      </div>
                    ) : groupsError ? (
                      <div className="p-2">
                        <Alert tone="danger" className="text-[11px]">
                          {groupsError}
                        </Alert>
                        <Button
                          variant="secondary"
                          size="sm"
                          className="mt-2 w-full"
                          onClick={() => void loadGroups()}
                        >
                          <RefreshCw size={12} /> 重试
                        </Button>
                      </div>
                    ) : filteredGroups.length === 0 ? (
                      <div className="py-8 text-center text-[11.5px] text-faint">
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
                            disabled={configured || atLimit}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-hover disabled:cursor-not-allowed disabled:opacity-45"
                            onClick={() =>
                              setSelectedGroupIds((current) =>
                                current.includes(group.id)
                                  ? current.filter((id) => id !== group.id)
                                  : [...current, group.id],
                              )
                            }
                          >
                            <span
                              className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                                selected
                                  ? 'border-accent bg-accent text-white'
                                  : 'border-border bg-surface'
                              }`}
                            >
                              {selected && <Check size={11} />}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[12px] text-fg">{group.name}</span>
                              <span className="block truncate text-[10px] text-faint">
                                ID {group.id}
                                {group.memberCount === null ? '' : ` · ${group.memberCount} 位成员`}
                              </span>
                            </span>
                            {configured && <span className="text-[10px] text-faint">已配置</span>}
                          </button>
                        )
                      })
                    )}
                  </div>
                </PopoverContent>
              </Popover>
              {selectedGroupIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {selectedGroupIds.map((groupId) => (
                    <span
                      key={groupId}
                      className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent-soft px-2 py-1 text-[10.5px] text-accent"
                    >
                      <span className="truncate">{groupById.get(groupId)?.name ?? groupId}</span>
                      <button
                        type="button"
                        aria-label={`移除${groupById.get(groupId)?.name ?? groupId}`}
                        className="shrink-0 rounded-full hover:bg-accent/10"
                        onClick={() =>
                          setSelectedGroupIds((current) => current.filter((id) => id !== groupId))
                        }
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="grid gap-1 text-[11.5px] text-muted">
              <span>知识星球</span>
              <div className="rounded-lg border border-border bg-hover px-3 py-2 text-[12px] text-fg">
                {groupById.get(draft.groupId)?.name ?? `星球 ${draft.groupId}`}
              </div>
            </div>
          )}
          <label htmlFor="kp-automation-rule-name" className="grid gap-1 text-[11.5px] text-muted">
            规则名称
            <Input
              id="kp-automation-rule-name"
              value={draft.name}
              maxLength={100}
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
          </label>
          <label
            htmlFor="kp-automation-instructions"
            className="grid gap-1 text-[11.5px] text-muted"
          >
            回复要求
            <Textarea
              id="kp-automation-instructions"
              value={draft.instructions}
              maxLength={4000}
              rows={6}
              placeholder="说明什么情况回复、语气、事实边界与应跳过的主题。"
              onChange={(event) =>
                setDraft((current) => ({ ...current, instructions: event.target.value }))
              }
            />
          </label>
          <label className="grid gap-1 text-[11.5px] text-muted">
            触发范围
            <select
              className="h-9 rounded-lg border border-border bg-surface px-2 text-[12px] text-fg"
              value={draft.triggerKind}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  triggerKind: event.target.value as RuleDraft['triggerKind'],
                }))
              }
            >
              <option value="new_topic">全部新主题</option>
              <option value="new_question">仅新提问</option>
            </select>
          </label>
          <div className="grid grid-cols-3 gap-2">
            <label
              htmlFor="kp-automation-daily-limit"
              className="grid gap-1 text-[10.5px] text-muted"
            >
              每日上限
              <Input
                id="kp-automation-daily-limit"
                type="number"
                min={1}
                max={10}
                value={draft.dailyLimit}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, dailyLimit: event.target.value }))
                }
              />
            </label>
            <label htmlFor="kp-automation-cooldown" className="grid gap-1 text-[10.5px] text-muted">
              冷却（分钟）
              <Input
                id="kp-automation-cooldown"
                type="number"
                min={5}
                max={1440}
                value={draft.cooldownMinutes}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, cooldownMinutes: event.target.value }))
                }
              />
            </label>
            <label
              htmlFor="kp-automation-max-reply"
              className="grid gap-1 text-[10.5px] text-muted"
            >
              回复字符上限
              <Input
                id="kp-automation-max-reply"
                type="number"
                min={100}
                max={1200}
                value={draft.maxReplyChars}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, maxReplyChars: event.target.value }))
                }
              />
            </label>
          </div>
        </div>
      </Modal>
      {confirmElement}
    </div>
  )
}
