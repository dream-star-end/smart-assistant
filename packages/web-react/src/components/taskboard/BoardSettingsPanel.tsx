import { Settings } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AuthEpochStaleError } from '../../lib/api'
import {
  type TaskboardSettings,
  type TaskboardSettingsSnapshot,
  formatUsageReferenceCost,
  taskboardApi,
  taskboardErrorMessage,
} from '../../lib/taskboard'
import type { AuthSession } from '../../lib/types'
import {
  Button,
  DescriptionList,
  DescriptionRow,
  Field,
  IconButton,
  Input,
  ListSkeleton,
  Select,
  useConfirm,
  useToast,
} from '../ui'
import { PanelSheet } from './PanelSheet'

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: `${String(h).padStart(2, '0')}:00`,
}))

function emptySettings(): TaskboardSettings {
  return {
    maxConcurrentRuns: 2,
    maxRunsPerDay: 200,
    maxCostPerDayUsd: null,
    quietHoursStart: 23,
    quietHoursEnd: 8,
    circuitBreakerThreshold: 3,
    maxStageLoops: 5,
    maxRunsPerTick: 2,
    patrolPaused: false,
  }
}

/** 数字字段一律用字符串草稿:清空输入框不该立刻变成 0(审计 T-22 ①),保存时再统一校验。 */
interface NumericDraft {
  maxConcurrentRuns: string
  maxRunsPerDay: string
  maxCostPerDayUsd: string
  circuitBreakerThreshold: string
  maxStageLoops: string
  maxRunsPerTick: string
}

function draftFromSettings(s: TaskboardSettings): NumericDraft {
  return {
    maxConcurrentRuns: String(s.maxConcurrentRuns),
    maxRunsPerDay: String(s.maxRunsPerDay),
    maxCostPerDayUsd: s.maxCostPerDayUsd == null ? '' : String(s.maxCostPerDayUsd),
    circuitBreakerThreshold: String(s.circuitBreakerThreshold),
    maxStageLoops: String(s.maxStageLoops),
    maxRunsPerTick: String(s.maxRunsPerTick),
  }
}

type NumericField = {
  key: keyof Omit<NumericDraft, 'maxCostPerDayUsd'>
  label: string
  hint: string
  min: number
  error: string
}

const NUMERIC_FIELDS: NumericField[] = [
  {
    key: 'maxConcurrentRuns',
    label: '同时执行上限',
    hint: '同一时刻最多有几条单据在跑。',
    min: 1,
    error: '同时执行上限至少为 1',
  },
  {
    key: 'maxRunsPerDay',
    label: '每日执行上限',
    hint: '一天内 agent 最多启动多少次执行，到达后当天不再自动开工。',
    min: 1,
    error: '每日执行上限至少为 1',
  },
  {
    key: 'maxRunsPerTick',
    label: '每轮巡检最多启动',
    hint: '每次巡检最多同时拉起几条单据，避免一口气把额度用完。',
    min: 1,
    error: '每轮巡检至少启动 1 条',
  },
  {
    key: 'circuitBreakerThreshold',
    label: '连续失败熔断',
    hint: '同一阶段连续失败达到这个次数后暂停该阶段，等人处理。',
    min: 1,
    error: '熔断阈值至少为 1',
  },
  {
    key: 'maxStageLoops',
    label: '同一阶段最多打回次数',
    hint: '一张单在同一阶段来回超过这个次数就标记受阻，防止无限循环。',
    min: 1,
    error: '同一阶段打回次数至少为 1',
  },
]

export function BoardSettingsPanel({
  auth,
  open: openProp,
  onOpenChange,
  hideTrigger = false,
}: {
  auth: AuthSession
  /** 受控打开(TaskboardView 的移动端「配置」菜单)。不传则自管。 */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  hideTrigger?: boolean
}) {
  const toast = useToast()
  const [confirm, confirmEl] = useConfirm()
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const setOpen = (next: boolean) => {
    setOpenState(next)
    onOpenChange?.(next)
  }
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pausing, setPausing] = useState(false)
  const [snap, setSnap] = useState<TaskboardSettingsSnapshot | null>(null)
  const [draft, setDraft] = useState<TaskboardSettings>(emptySettings())
  const [numbers, setNumbers] = useState<NumericDraft>(() => draftFromSettings(emptySettings()))

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    void taskboardApi
      .getSettings(auth)
      .then((fresh) => {
        if (cancelled) return
        setSnap(fresh)
        setDraft(fresh)
        setNumbers(draftFromSettings(fresh))
      })
      .catch((e) => {
        if (e instanceof AuthEpochStaleError || cancelled) return
        toast(taskboardErrorMessage(e, '加载护栏设置失败'), 'error')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [auth, open, toast])

  const applySnapshot = (fresh: TaskboardSettingsSnapshot) => {
    setSnap(fresh)
    setDraft(fresh)
    setNumbers(draftFromSettings(fresh))
  }

  const parseCost = (): number | null | undefined => {
    const raw = numbers.maxCostPerDayUsd.trim()
    if (!raw) return null
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) {
      toast('每日成本上限必须是非负数，留空表示不限', 'error')
      return undefined
    }
    return n
  }

  const save = async () => {
    const cost = parseCost()
    if (cost === undefined) return
    const parsed: Partial<Record<NumericField['key'], number>> = {}
    for (const field of NUMERIC_FIELDS) {
      const n = Number(numbers[field.key])
      if (!numbers[field.key].trim() || !Number.isInteger(n) || n < field.min) {
        toast(field.error, 'error')
        return
      }
      parsed[field.key] = n
    }
    setSaving(true)
    try {
      const out = await taskboardApi.patchSettings(auth, {
        maxConcurrentRuns: parsed.maxConcurrentRuns,
        maxRunsPerDay: parsed.maxRunsPerDay,
        maxCostPerDayUsd: cost,
        quietHoursStart: draft.quietHoursStart,
        quietHoursEnd: draft.quietHoursEnd,
        circuitBreakerThreshold: parsed.circuitBreakerThreshold,
        maxStageLoops: parsed.maxStageLoops,
        maxRunsPerTick: parsed.maxRunsPerTick,
      })
      applySnapshot(out)
      toast('已保存护栏设置', 'success')
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      toast(taskboardErrorMessage(e, '保存护栏设置失败'), 'error')
    } finally {
      setSaving(false)
    }
  }

  const togglePause = async () => {
    const next = !draft.patrolPaused
    const ok = await confirm({
      title: next ? '急停全部巡检？' : '恢复自动巡检？',
      body: next
        ? '正在跑的任务不受影响，但不会再启动新的巡检。'
        : '恢复后将按护栏配置继续自动巡检。',
      confirmText: next ? '急停' : '恢复',
      cancelText: '返回',
      danger: next,
    })
    if (!ok) return
    setPausing(true)
    try {
      const out = await taskboardApi.patchSettings(auth, { patrolPaused: next })
      applySnapshot(out)
      toast(next ? '已急停巡检' : '已恢复巡检', 'success')
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      toast(taskboardErrorMessage(e, '更新急停开关失败'), 'error')
    } finally {
      setPausing(false)
    }
  }

  const usage = snap?.usage
  const costLimitRaw = numbers.maxCostPerDayUsd.trim()
  const costToday = usage ? formatUsageReferenceCost(usage) : null
  const quietSame = draft.quietHoursStart === draft.quietHoursEnd

  return (
    <>
      {hideTrigger ? null : (
        <IconButton
          data-testid="board-settings-open"
          aria-label="护栏设置"
          title="护栏设置"
          shape="square"
          onClick={() => setOpen(true)}
        >
          <Settings size={16} />
        </IconButton>
      )}
      <PanelSheet
        open={open}
        onOpenChange={setOpen}
        title="护栏设置"
        hint="限制 agent 自动执行的频率与花费。只有你本人能改，agent 调用会被拒绝。"
        testId="board-settings"
        width="narrow"
      >
        {loading && !snap ? (
          <ListSkeleton rows={6} variant="row" />
        ) : (
          <>
            {usage && (
              <div className="rounded-lg bg-hover px-3 py-1" data-testid="board-settings-usage">
                <DescriptionList>
                  <DescriptionRow
                    label="今天已执行"
                    value={`${usage.runsToday} / ${numbers.maxRunsPerDay || '—'} 次`}
                  />
                  <DescriptionRow
                    label="正在执行"
                    value={`${usage.activeRuns} / ${numbers.maxConcurrentRuns || '—'} 条`}
                  />
                  <DescriptionRow
                    label="今日花费"
                    value={`${costToday ?? '暂无记录'} · 上限 ${costLimitRaw ? `$${costLimitRaw}` : '不限'}`}
                  />
                </DescriptionList>
              </div>
            )}
            {draft.patrolPaused && (
              <p className="rounded-lg bg-danger-soft px-3 py-2 text-body text-danger">
                全局巡检已急停，恢复前不会自动启动新的执行。
              </p>
            )}
            <section className="flex flex-col gap-3">
              <h3 className="text-section font-semibold text-fg">额度</h3>
              {NUMERIC_FIELDS.slice(0, 2).map((field) => (
                <Field key={field.key} label={field.label} hint={field.hint}>
                  <Input
                    aria-label={field.label}
                    data-testid={`board-settings-${field.key}`}
                    type="number"
                    min={field.min}
                    inputSize="sm"
                    value={numbers[field.key]}
                    onChange={(e) =>
                      setNumbers((cur) => ({ ...cur, [field.key]: e.target.value }))
                    }
                  />
                </Field>
              ))}
              <Field
                label="每日成本上限（美元）"
                hint="只统计有单价的执行；留空表示不限。"
              >
                <Input
                  aria-label="每日成本上限"
                  type="number"
                  min={0}
                  step="0.01"
                  inputSize="sm"
                  placeholder="留空不限"
                  value={numbers.maxCostPerDayUsd}
                  onChange={(e) =>
                    setNumbers((cur) => ({ ...cur, maxCostPerDayUsd: e.target.value }))
                  }
                />
              </Field>
            </section>
            <section className="flex flex-col gap-3">
              <h3 className="text-section font-semibold text-fg">节奏与保护</h3>
              {NUMERIC_FIELDS.slice(2).map((field) => (
                <Field key={field.key} label={field.label} hint={field.hint}>
                  <Input
                    aria-label={field.label}
                    data-testid={`board-settings-${field.key}`}
                    type="number"
                    min={field.min}
                    inputSize="sm"
                    value={numbers[field.key]}
                    onChange={(e) =>
                      setNumbers((cur) => ({ ...cur, [field.key]: e.target.value }))
                    }
                  />
                </Field>
              ))}
              <div className="grid grid-cols-2 gap-2">
                <Field label="静默开始">
                  <Select
                    aria-label="静默开始"
                    inputSize="sm"
                    value={String(draft.quietHoursStart)}
                    onValueChange={(v) =>
                      setDraft((cur) => ({ ...cur, quietHoursStart: Number(v) }))
                    }
                    options={HOUR_OPTIONS}
                  />
                </Field>
                <Field label="静默结束">
                  <Select
                    aria-label="静默结束"
                    inputSize="sm"
                    value={String(draft.quietHoursEnd)}
                    onValueChange={(v) => setDraft((cur) => ({ ...cur, quietHoursEnd: Number(v) }))}
                    options={HOUR_OPTIONS}
                  />
                </Field>
              </div>
              <p className="text-caption text-muted" data-testid="board-settings-quiet-hint">
                {quietSame
                  ? '开始与结束相同，表示不设静默时段，全天都可能自动执行。'
                  : `${String(draft.quietHoursStart).padStart(2, '0')}:00 到 ${String(draft.quietHoursEnd).padStart(2, '0')}:00 之间不会自动启动新的执行。`}
              </p>
            </section>
            <div className="pt-1">
              <Button
                type="button"
                size="sm"
                variant="primary"
                loading={saving}
                data-testid="board-settings-save"
                onClick={() => void save()}
              >
                保存设置
              </Button>
            </div>
            <section className="mt-2 flex flex-col gap-2 border-t border-border pt-3">
              <h3 className="text-section font-semibold text-danger">紧急</h3>
              <p className="text-caption text-muted">
                {draft.patrolPaused
                  ? '恢复后将按上面的护栏配置继续自动巡检。'
                  : '急停后不再启动新的执行；正在跑的任务不受影响。'}
              </p>
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className={
                    draft.patrolPaused
                      ? undefined
                      : 'border-danger text-danger hover:border-danger hover:bg-danger-soft'
                  }
                  loading={pausing}
                  data-testid="board-settings-pause"
                  onClick={() => void togglePause()}
                >
                  {draft.patrolPaused ? '恢复巡检' : '急停巡检'}
                </Button>
              </div>
            </section>
          </>
        )}
      </PanelSheet>
      {confirmEl}
    </>
  )
}
