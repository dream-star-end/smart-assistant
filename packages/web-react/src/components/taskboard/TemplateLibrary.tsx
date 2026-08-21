import { Library } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { AuthEpochStaleError } from '../../lib/api'
import {
  type PipelineTemplate,
  TICKET_TYPE_LABEL,
  type TicketType,
  taskboardApi,
  taskboardErrorMessage,
} from '../../lib/taskboard'
import type { AuthSession } from '../../lib/types'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  ListSkeleton,
  Sheet,
  Switch,
  useConfirm,
  useToast,
} from '../ui'

function typeLabel(type: TicketType | null): string {
  return type ? TICKET_TYPE_LABEL[type] : '通用'
}

export function TemplateLibrary({
  auth,
  projectId,
  onChanged,
  compact = false,
}: {
  auth: AuthSession
  projectId: string | null
  onChanged?: () => void
  compact?: boolean
}) {
  const toast = useToast()
  const [confirm, confirmEl] = useConfirm()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [items, setItems] = useState<PipelineTemplate[] | null>(null)
  const [asDefault, setAsDefault] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await taskboardApi.listTemplates(auth)
      setItems(list)
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      setError(taskboardErrorMessage(e, '加载模板失败'))
    } finally {
      setLoading(false)
    }
  }, [auth])

  useEffect(() => {
    if (!open) return
    void reload()
  }, [open, reload])

  const apply = async (template: PipelineTemplate) => {
    if (!projectId) {
      toast('请先选择项目', 'error')
      return
    }
    setBusyId(template.id)
    try {
      const out = await taskboardApi.applyTemplate(auth, template.id, {
        projectId,
        asDefault,
      })
      if (out.createdPipelines === 0 && out.skippedPipelines > 0) {
        toast(`「${template.name}」已在该项目中，未重复种入`, 'success')
      } else {
        toast(
          `已套用「${template.name}」：新建 ${out.createdPipelines} 条流水线、${out.createdStages} 个阶段`,
          'success',
        )
      }
      onChanged?.()
      await reload()
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      toast(taskboardErrorMessage(e, '套用模板失败'), 'error')
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (template: PipelineTemplate) => {
    if (template.source === 'builtin') {
      toast('内置模板不能删除', 'error')
      return
    }
    const ok = await confirm({
      title: `删除模板「${template.name}」？`,
      body: '只删模板，已经套用到项目里的流水线不会被删。',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    setBusyId(template.id)
    try {
      await taskboardApi.deleteTemplate(auth, template.id)
      toast('已删除自定义模板', 'success')
      await reload()
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      toast(taskboardErrorMessage(e, '删除模板失败'), 'error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      {compact ? (
        <IconButton
          type="button"
          shape="square"
          data-testid="template-library-open"
          aria-label="流水线模板"
          title="流水线模板"
          onClick={() => setOpen(true)}
        >
          <Library size={16} />
        </IconButton>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          data-testid="template-library-open"
          onClick={() => setOpen(true)}
        >
          <Library size={14} />
          流水线模板
        </Button>
      )}
      <Sheet
        open={open}
        onOpenChange={setOpen}
        side="right"
        srTitle="流水线模板"
        className="w-[36rem] max-w-[96vw]"
      >
        <div
          data-testid="template-library"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
        >
          <div>
            <h2 className="text-title font-semibold text-fg">流水线模板</h2>
            <p className="mt-1 text-caption text-muted">
              内置四条与新建项目时的默认线相同，不能删除。自定义模板可从现有流水线另存。
            </p>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg bg-hover px-3 py-2">
            <span className="text-meta font-medium text-muted">套用时设为该类型默认线</span>
            <Switch
              aria-label="套用时设为默认"
              checked={asDefault}
              onCheckedChange={setAsDefault}
            />
          </div>
          {loading && !items ? (
            <ListSkeleton rows={4} variant="row" />
          ) : error ? (
            <EmptyState
              icon={Library}
              title="模板加载失败"
              hint={error}
              action={
                <Button type="button" variant="secondary" onClick={() => void reload()}>
                  重试
                </Button>
              }
            />
          ) : !items || items.length === 0 ? (
            <EmptyState icon={Library} title="还没有模板" hint="内置模板应始终可见，请重试加载。" />
          ) : (
            items.map((t) => {
              const builtin = t.source === 'builtin'
              return (
                <Card
                  key={t.id}
                  padding="sm"
                  className="flex flex-col gap-2"
                  data-testid={`template-card-${t.id}`}
                  data-source={t.source}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="min-w-0 flex-1 truncate text-body font-medium text-fg">
                      {t.name}
                    </h3>
                    <Badge size="sm" tone={builtin ? 'info' : 'accent'}>
                      {builtin ? '内置' : '自定义'}
                    </Badge>
                    <Badge size="sm" tone="neutral">
                      {typeLabel(t.ticketType)}
                    </Badge>
                  </div>
                  <p className="text-caption text-muted">
                    {t.stages.length} 个阶段
                    {t.stages.length ? `：${t.stages.map((s) => s.name).join(' → ')}` : ''}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      type="button"
                      size="sm"
                      data-testid={`template-apply-${t.id}`}
                      disabled={!projectId}
                      loading={busyId === t.id}
                      onClick={() => void apply(t)}
                    >
                      套用到当前项目
                    </Button>
                    {builtin ? (
                      <span className="self-center text-caption text-faint">不可删除</span>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        data-testid={`template-delete-${t.id}`}
                        loading={busyId === t.id}
                        onClick={() => void remove(t)}
                      >
                        删除
                      </Button>
                    )}
                  </div>
                </Card>
              )
            })
          )}
        </div>
      </Sheet>
      {confirmEl}
    </>
  )
}
