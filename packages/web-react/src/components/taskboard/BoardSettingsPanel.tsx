import { Settings } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AuthEpochStaleError } from '../../lib/api'
import {
  type TaskboardSettings,
  type TaskboardSettingsSnapshot,
  formatRunCostUsd,
  taskboardApi,
  taskboardErrorMessage,
} from '../../lib/taskboard'
import type { AuthSession } from '../../lib/types'
import {
  Button,
  IconButton,
  Input,
  ListSkeleton,
  Select,
  Sheet,
  useConfirm,
  useToast,
} from '../ui'

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

export function BoardSettingsPanel({ auth }: { auth: AuthSession }) {
  const toast = useToast()
  const [confirm, confirmEl] = useConfirm()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pausing, setPausing] = useState(false)
  const [snap, setSnap] = useState<TaskboardSettingsSnapshot | null>(null)
  const [draft, setDraft] = useState<TaskboardSettings>(emptySettings())
  const [costText, setCostText] = useState('')

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
        setCostText(fresh.maxCostPerDayUsd == null ? '' : String(fresh.maxCostPerDayUsd))
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
    setCostText(fresh.maxCostPerDayUsd == null ? '' : String(fresh.maxCostPerDayUsd))
  }

  const parseCost = (): number | null | undefined => {
    const raw = costText.trim()
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
    const maxConcurrentRuns = Number(draft.maxConcurrentRuns)
    const maxRunsPerDay = Number(draft.maxRunsPerDay)
    if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
      toast('并发上限至少为 1', 'error')
      return
    }
    if (!Number.isInteger(maxRunsPerDay) || maxRunsPerDay < 1) {
      toast('每日巡检上限至少为 1', 'error')
      return
    }
    setSaving(true)
    try {
      const out = await taskboardApi.patchSettings(auth, {
        maxConcurrentRuns,
        maxRunsPerDay,
        maxCostPerDayUsd: cost,
        quietHoursStart: draft.quietHoursStart,
        quietHoursEnd: draft.quietHoursEnd,
        circuitBreakerThreshold: draft.circuitBreakerThreshold,
        maxStageLoops: draft.maxStageLoops,
        maxRunsPerTick: draft.maxRunsPerTick,
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
  const costLimit = draft.maxCostPerDayUsd
  const costToday = usage ? formatRunCostUsd(usage.costTodayUsd) : null

  return (
    <>
      <IconButton
        data-testid="board-settings-open"
        aria-label="护栏设置"
        shape="square"
        onClick={() => setOpen(true)}
      >
        <Settings size={16} />
      </IconButton>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        side="right"
        srTitle="护栏设置"
        className="w-[24rem] max-w-[92vw]"
      >
        <div data-testid="board-settings" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <div>
            <h2 className="text-title font-semibold text-fg">护栏设置</h2>
            <p className="mt-1 text-caption text-muted">仅本人可改。agent 调用会被拒绝。</p>
          </div>
          {loading && !snap ? (
            <ListSkeleton rows={6} variant="row" />
          ) : (
            <>
              {usage && (
                <p className="rounded-lg bg-hover px-3 py-2 text-meta text-muted">
                  今天已跑 {usage.runsToday} / {draft.maxRunsPerDay}，进行中 {usage.activeRuns} /{' '}
                  {draft.maxConcurrentRuns}
                  {costToday ? `，成本 ${costToday}` : ''}
                  {costLimit == null ? ' / 不限' : ` / $${costLimit}`}
                </p>
              )}
              {draft.patrolPaused && (
                <p className="rounded-lg bg-danger-soft px-3 py-2 text-body text-danger">
                  全局巡检已急停
                </p>
              )}
              <label className="flex flex-col gap-1.5">
                <span className="text-meta font-medium text-muted">并发上限</span>
                <Input
                  aria-label="并发上限"
                  type="number"
                  min={1}
                  inputSize="sm"
                  value={String(draft.maxConcurrentRuns)}
                  onChange={(e) =>
                    setDraft((cur) => ({ ...cur, maxConcurrentRuns: Number(e.target.value) }))
                  }
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-meta font-medium text-muted">每日巡检上限</span>
                <Input
                  aria-label="每日巡检上限"
                  type="number"
                  min={1}
                  inputSize="sm"
                  value={String(draft.maxRunsPerDay)}
                  onChange={(e) =>
                    setDraft((cur) => ({ ...cur, maxRunsPerDay: Number(e.target.value) }))
                  }
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-meta font-medium text-muted">每日成本上限（美元）</span>
                <Input
                  aria-label="每日成本上限"
                  type="number"
                  min={0}
                  step="0.01"
                  inputSize="sm"
                  placeholder="留空不限"
                  value={costText}
                  onChange={(e) => setCostText(e.target.value)}
                />
              </label>
              <div className="flex gap-2">
                <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="text-meta font-medium text-muted">静默开始</span>
                  <Select
                    aria-label="静默开始"
                    inputSize="sm"
                    value={String(draft.quietHoursStart)}
                    onValueChange={(v) =>
                      setDraft((cur) => ({ ...cur, quietHoursStart: Number(v) }))
                    }
                    options={HOUR_OPTIONS}
                  />
                </label>
                <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="text-meta font-medium text-muted">静默结束</span>
                  <Select
                    aria-label="静默结束"
                    inputSize="sm"
                    value={String(draft.quietHoursEnd)}
                    onValueChange={(v) =>
                      setDraft((cur) => ({ ...cur, quietHoursEnd: Number(v) }))
                    }
                    options={HOUR_OPTIONS}
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-1 pt-1">
                <Button
                  type="button"
                  size="sm"
                  loading={saving}
                  data-testid="board-settings-save"
                  onClick={() => void save()}
                >
                  保存设置
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={draft.patrolPaused ? 'secondary' : 'danger'}
                  loading={pausing}
                  data-testid="board-settings-pause"
                  onClick={() => void togglePause()}
                >
                  {draft.patrolPaused ? '恢复巡检' : '急停巡检'}
                </Button>
              </div>
            </>
          )}
        </div>
      </Sheet>
      {confirmEl}
    </>
  )
}
