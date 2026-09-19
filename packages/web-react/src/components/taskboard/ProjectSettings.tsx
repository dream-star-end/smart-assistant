import { FolderCog, FolderPlus, Pencil } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AuthEpochStaleError } from '../../lib/api'
import {
  BUILTIN_TEMPLATE_OPTIONS,
  PROJECT_KEY_RE,
  type Project,
  type ProjectCreateInput,
  type ProjectMemoryItem,
  type ProjectPatchInput,
  taskboardApi,
  taskboardErrorMessage,
} from '../../lib/taskboard'
import type { AuthSession } from '../../lib/types'
import { Button, Field, IconButton, Input, Textarea, useConfirm, useToast } from '../ui'
import { PanelSheet } from './PanelSheet'

type Mode = 'create' | 'edit'
type WorkspaceKind = 'default' | 'isolated' | 'container_path'

/** 工作区选项:面向用户的说法,环境变量 / 目录约定收进 hint(审计 T-14)。 */
const WORKSPACE_OPTIONS: Array<{ kind: WorkspaceKind; label: string; hint: string }> = [
  {
    kind: 'default',
    label: '默认工作区',
    hint: '跟随全局设置，与不属于任何项目的会话共用同一个目录。',
  },
  {
    kind: 'isolated',
    label: '每个项目独立目录',
    hint: '为这个项目单独开一个目录，agent 的产出不会和其他项目混在一起。',
  },
  {
    kind: 'container_path',
    label: '指定容器内目录',
    hint: '填写容器里的绝对路径，须位于 workspace/ 或 repos/ 之下。',
  },
]

export function ProjectSettings({
  auth,
  current,
  onCreate,
  onPatch,
  onArchive,
  onUnarchive,
  compact = false,
  mode: modeProp,
  onModeChange,
  hideTrigger = false,
}: {
  auth: AuthSession
  current: Project | null
  onCreate: (input: ProjectCreateInput) => Promise<Project | null>
  onPatch: (id: string, input: ProjectPatchInput) => Promise<Project | null>
  onArchive: (id: string) => Promise<boolean>
  onUnarchive: (id: string) => Promise<boolean>
  compact?: boolean
  /** 受控打开:'create' / 'edit' / null(TaskboardView 的移动端「配置」菜单与空态从外部打开)。不传则自管。 */
  mode?: Mode | null
  onModeChange?: (mode: Mode | null) => void
  /** 由外部提供入口时隐藏自带按钮。 */
  hideTrigger?: boolean
}) {
  const toast = useToast()
  const [confirm, confirmEl] = useConfirm()
  const [modeState, setModeState] = useState<Mode | null>(null)
  const mode = modeProp !== undefined ? modeProp : modeState
  const setMode = (next: Mode | null) => {
    setModeState(next)
    onModeChange?.(next)
  }
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [archived, setArchived] = useState<Project[]>([])
  const [templateIds, setTemplateIds] = useState<string[]>(() =>
    BUILTIN_TEMPLATE_OPTIONS.map((t) => t.id),
  )
  const [workspaceKind, setWorkspaceKind] = useState<WorkspaceKind>('default')
  const [workspacePath, setWorkspacePath] = useState('')
  const [workspaceError, setWorkspaceError] = useState('')

  const open = mode !== null

  useEffect(() => {
    if (mode === 'edit' && current) {
      setKey(current.key)
      setName(current.name)
      setDescription(current.description ?? '')
      setWorkspaceKind(current.workspaceSpec?.kind ?? 'default')
      setWorkspacePath(current.workspaceSpec?.path ?? current.workspace ?? '')
      setWorkspaceError('')
    }
    if (mode === 'create') {
      setKey('')
      setName('')
      setDescription('')
      setTemplateIds(BUILTIN_TEMPLATE_OPTIONS.map((t) => t.id))
      setWorkspaceKind('default')
      setWorkspacePath('')
      setWorkspaceError('')
    }
  }, [mode, current])

  useEffect(() => {
    if (mode !== 'edit') return
    let cancelled = false
    void taskboardApi
      .listProjects(auth, true)
      .then((items) => {
        if (!cancelled) setArchived(items.filter((p) => p.archivedAt != null))
      })
      .catch((e) => {
        if (e instanceof AuthEpochStaleError || cancelled) return
        toast(taskboardErrorMessage(e, '加载已归档项目失败'), 'error')
      })
    return () => {
      cancelled = true
    }
  }, [auth, mode, toast])

  const close = () => setMode(null)

  const workspaceSpecPayload = () => {
    if (workspaceKind === 'container_path') {
      const path = workspacePath.trim()
      if (!path.startsWith('/')) {
        setWorkspaceError('请填写容器内的绝对路径（以 / 开头），且位于 workspace/ 或 repos/ 下。')
        return null
      }
      if (path.includes('/projects/') && !path.includes('/workspace/projects/')) {
        setWorkspaceError('这个目录是项目数据目录，不能当工作区；请选 workspace/ 或 repos/ 下的路径。')
        return null
      }
      return { kind: 'container_path' as const, path }
    }
    setWorkspaceError('')
    return { kind: workspaceKind }
  }

  const submitCreate = async () => {
    const normalized = key.trim().toUpperCase()
    const title = name.trim()
    if (!PROJECT_KEY_RE.test(normalized)) {
      toast('项目前缀须为 2–12 位大写字母或数字，且以字母开头', 'error')
      return
    }
    if (!title) {
      toast('请填写项目名称', 'error')
      return
    }
    const spec = workspaceSpecPayload()
    if (!spec) return
    setSaving(true)
    try {
      const allBuiltin = BUILTIN_TEMPLATE_OPTIONS.every((t) => templateIds.includes(t.id))
      const none = templateIds.length === 0
      const created = await onCreate({
        key: normalized,
        name: title,
        description: description.trim() || null,
        workspaceSpec: spec,
        templateIds: allBuiltin ? undefined : none ? [] : templateIds,
      })
      if (created) close()
    } finally {
      setSaving(false)
    }
  }

  const submitEdit = async () => {
    if (!current) return
    const title = name.trim()
    if (!title) {
      toast('请填写项目名称', 'error')
      return
    }
    const spec = workspaceSpecPayload()
    if (!spec) return
    setSaving(true)
    try {
      const updated = await onPatch(current.id, {
        name: title,
        description: description.trim() || null,
        workspaceSpec: spec,
      })
      if (updated) close()
    } finally {
      setSaving(false)
    }
  }

  const archiveCurrent = async () => {
    if (!current) return
    const ok = await confirm({
      title: `归档 ${current.key}？`,
      body: '归档后项目不再出现在下拉里，单据仍保留。可以稍后取消归档。',
      confirmText: '归档',
      cancelText: '返回',
      danger: true,
    })
    if (!ok) return
    setSaving(true)
    try {
      const done = await onArchive(current.id)
      if (done) close()
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {hideTrigger ? null : compact ? (
        <IconButton
          data-testid={current ? 'project-edit-open' : 'project-create-open'}
          aria-label={current ? '管理项目' : '新建项目'}
          title={current ? '管理项目' : '新建项目'}
          shape="square"
          onClick={() => setMode(current ? 'edit' : 'create')}
        >
          <FolderCog size={16} />
        </IconButton>
      ) : (
        <>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            data-testid="project-create-open"
            onClick={() => setMode('create')}
          >
            <FolderPlus size={14} />
            新建项目
          </Button>
          {current && (
            <IconButton
              data-testid="project-edit-open"
              aria-label="管理项目"
              title="管理项目"
              shape="square"
              onClick={() => setMode('edit')}
            >
              <Pencil size={16} />
            </IconButton>
          )}
        </>
      )}
      <PanelSheet
        open={open}
        onOpenChange={(next) => {
          if (!next) close()
        }}
        title={mode === 'edit' ? '管理项目' : '新建项目'}
        hint={
          mode === 'edit'
            ? '前缀创建后不可改。归档项目默认不出现在下拉里。'
            : '创建后会自动切到该项目。可选择要种的流水线模板；默认四条内置线全选，全部取消则不种。'
        }
        testId={mode === 'edit' ? 'project-edit' : 'project-create'}
        headerExtra={
          mode === 'edit' ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="project-create-from-edit"
              onClick={() => setMode('create')}
            >
              <FolderPlus size={14} />
              新建项目
            </Button>
          ) : undefined
        }
      >
        <Field
          label="项目前缀"
          required={mode === 'create'}
          hint={mode === 'edit' ? '创建后不可改' : '2–12 位大写字母或数字，以字母开头，例如 OCV5'}
        >
          <Input
            aria-label="项目前缀"
            data-testid="project-key"
            inputSize="sm"
            value={key}
            maxLength={12}
            disabled={mode === 'edit'}
            placeholder="OCV5"
            onChange={(e) => setKey(e.target.value.toUpperCase())}
          />
        </Field>
        <Field label="项目名称" required>
          <Input
            aria-label="项目名称"
            data-testid="project-name"
            inputSize="sm"
            value={name}
            placeholder="V5 自用"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void (mode === 'edit' ? submitEdit() : submitCreate())
            }}
          />
        </Field>
        <Field label="说明" hint="可选">
          <Textarea
            aria-label="项目说明"
            data-testid="project-description"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field
          label="工作区"
          hint="绑定到本项目的会话默认在这个目录里干活；若会话绑定了 GitHub 仓库且仓库已就绪，会改用仓库目录。"
          error={workspaceError || undefined}
        >
          <div className="flex flex-col gap-1.5" data-testid="project-workspace-spec">
            {WORKSPACE_OPTIONS.map((opt) => (
              <label
                key={opt.kind}
                className="flex items-start gap-2 rounded-lg bg-hover px-3 py-2 text-body text-fg"
              >
                <input
                  type="radio"
                  name="project-workspace-kind"
                  className="mt-1"
                  data-testid={`project-workspace-${opt.kind}`}
                  checked={workspaceKind === opt.kind}
                  onChange={() => {
                    setWorkspaceKind(opt.kind)
                    setWorkspaceError('')
                  }}
                />
                <span className="flex min-w-0 flex-col">
                  <span>{opt.label}</span>
                  <span className="text-caption text-muted">{opt.hint}</span>
                </span>
              </label>
            ))}
            {workspaceKind === 'container_path' && (
              <Input
                aria-label="容器工作区路径"
                data-testid="project-workspace-path"
                inputSize="sm"
                placeholder="/home/agent/.openclaude/workspace/..."
                value={workspacePath}
                onChange={(e) => setWorkspacePath(e.target.value)}
              />
            )}
          </div>
        </Field>
        {mode === 'create' && (
          <Field
            label="流水线模板"
            hint="默认全选四条内置线。内置模板不能删除，可在「流水线模板」里对已有项目再套用。"
          >
            <div className="flex flex-col gap-1.5" data-testid="project-templates">
              {BUILTIN_TEMPLATE_OPTIONS.map((t) => {
                const checked = templateIds.includes(t.id)
                return (
                  <label
                    key={t.id}
                    className="flex items-center gap-2 rounded-lg bg-hover px-3 py-2 text-body text-fg"
                  >
                    <input
                      type="checkbox"
                      data-testid={`project-template-${t.id}`}
                      checked={checked}
                      onChange={() => {
                        setTemplateIds((cur) =>
                          checked ? cur.filter((id) => id !== t.id) : [...cur, t.id],
                        )
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                    <span className="text-caption text-faint">内置</span>
                  </label>
                )
              })}
            </div>
          </Field>
        )}
        <div className="flex flex-wrap gap-1">
          {mode === 'create' ? (
            <Button
              type="button"
              size="sm"
              variant="primary"
              loading={saving}
              data-testid="project-create-submit"
              onClick={() => void submitCreate()}
            >
              创建项目
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="primary"
              loading={saving}
              data-testid="project-edit-save"
              onClick={() => void submitEdit()}
            >
              保存
            </Button>
          )}
        </div>
        {mode === 'edit' && current && (
          <>
            <ProjectContextPanel auth={auth} project={current} />
            <ProjectMemoryReview auth={auth} project={current} confirm={confirm} />
          </>
        )}
        {mode === 'edit' && archived.length > 0 && (
          <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3">
            <h3 className="text-section font-semibold text-fg">已归档项目</h3>
            <p className="text-caption text-muted">默认不出现在顶栏下拉里。</p>
            {archived.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-2 rounded-lg bg-hover px-3 py-2"
              >
                <span className="min-w-0 truncate text-body text-fg">
                  {p.key} {p.name}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  data-testid={`project-unarchive-${p.id}`}
                  onClick={() => {
                    void onUnarchive(p.id).then((ok) => {
                      if (ok) setArchived((cur) => cur.filter((x) => x.id !== p.id))
                    })
                  }}
                >
                  取消归档
                </Button>
              </div>
            ))}
          </div>
        )}
        {mode === 'edit' && current && !current.archivedAt && (
          // 危险操作单独放在最底部,不再和「保存」并排(审计 T-23)。
          <section
            className="mt-2 flex flex-col gap-2 border-t border-border pt-3"
            data-testid="project-danger-zone"
          >
            <h3 className="text-section font-semibold text-danger">危险操作</h3>
            <p className="text-caption text-muted">
              归档后项目从下拉里消失，单据仍保留，随时可以取消归档。
            </p>
            <div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="border-danger text-danger hover:border-danger hover:bg-danger-soft"
                loading={saving}
                data-testid="project-archive"
                onClick={() => void archiveCurrent()}
              >
                归档项目
              </Button>
            </div>
          </section>
        )}
      </PanelSheet>
      {confirmEl}
    </>
  )
}

const WORKSPACE_KIND_LABEL: Record<string, string> = {
  default: '默认工作区',
  isolated: '每个项目独立目录',
  container_path: '指定容器内目录',
}

/** 注入槽的技术名 → 用户能读懂的说法;未知的原样显示。 */
const SLOT_LABEL: Record<string, string> = {
  'project.instructions': '项目说明',
  'memory.official': '项目记忆',
  'live.git_status': '实时 git 状态',
  'live.workspace': '实时工作区信息',
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function describeWorkspace(spec: unknown): string {
  if (!spec || typeof spec !== 'object') return WORKSPACE_KIND_LABEL.default
  const kind = String((spec as { kind?: unknown }).kind ?? 'default')
  const path = (spec as { path?: unknown }).path
  const label = WORKSPACE_KIND_LABEL[kind] ?? kind
  return typeof path === 'string' && path ? `${label} · ${path}` : label
}

function ProjectContextPanel({ auth, project }: { auth: AuthSession; project: Project }) {
  const toast = useToast()
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null)
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null)
  useEffect(() => {
    let cancelled = false
    void taskboardApi
      .getProjectContext(auth, project.id)
      .then((res) => {
        if (!cancelled) setSummary(res)
      })
      .catch((e) => {
        if (!cancelled) toast(taskboardErrorMessage(e, '加载项目上下文失败'), 'error')
      })
    return () => {
      cancelled = true
    }
  }, [auth, project.id, toast])
  const version = summary?.version ?? project.contextVersion ?? 0
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3" data-testid="project-context-panel">
      <h3 className="text-section font-semibold text-fg">项目上下文</h3>
      <p className="text-caption text-muted">
        agent 开工时会带上这些项目信息；其中的实时信息（如 git 状态）每次执行时重新读取。
      </p>
      {summary && (
        <p className="text-caption text-muted" title={`上下文版本 v${String(version)}`}>
          工作区：<span className="text-fg">{describeWorkspace(summary.workspaceSpec ?? project.workspaceSpec)}</span>
        </p>
      )}
      <div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          data-testid="project-context-preview"
          onClick={() => {
            void taskboardApi
              .previewProjectContext(auth, project.id)
              .then((res) => setPreview(res))
              .catch((e) => toast(taskboardErrorMessage(e, '预览失败'), 'error'))
          }}
        >
          预览 agent 将看到的项目信息
        </Button>
      </div>
      {preview && Array.isArray(preview.slots) && (
        <ul className="flex flex-col gap-1 text-caption text-muted" data-testid="project-context-slots">
          {(preview.slots as Array<{ name: string; bytes: number; redacted?: boolean; volatile?: boolean }>).map(
            (s) => (
              <li key={s.name} className="flex flex-wrap items-center gap-x-2 rounded-lg bg-hover px-3 py-1.5">
                <span className="text-fg">{SLOT_LABEL[s.name] ?? s.name}</span>
                <span>{formatBytes(s.bytes)}</span>
                {s.volatile ? <span>· 每次执行时实时读取</span> : null}
                {s.redacted ? <span>· 已隐去敏感内容</span> : null}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  )
}

function ProjectMemoryReview({
  auth,
  project,
  confirm,
}: {
  auth: AuthSession
  project: Project
  confirm: ReturnType<typeof useConfirm>[0]
}) {
  const toast = useToast()
  const [items, setItems] = useState<{ official: ProjectMemoryItem[]; candidates: ProjectMemoryItem[] } | null>(
    null,
  )
  useEffect(() => {
    let cancelled = false
    void taskboardApi
      .listProjectMemories(auth, project.id)
      .then((res) => {
        if (!cancelled) setItems({ official: res.official, candidates: res.candidates })
      })
      .catch((e) => {
        if (!cancelled) toast(taskboardErrorMessage(e, '加载项目记忆失败'), 'error')
      })
    return () => {
      cancelled = true
    }
  }, [auth, project.id, toast])

  const refresh = () =>
    taskboardApi.listProjectMemories(auth, project.id).then((res) => {
      setItems({ official: res.official, candidates: res.candidates })
    })

  const deprecate = async (o: ProjectMemoryItem) => {
    // 界面上没有反向操作,废弃前二次确认(审计 T-23)。
    const ok = await confirm({
      title: `废弃记忆「${o.slug}」？`,
      body: '废弃后这条记忆不再注入 agent，界面上不能恢复。',
      confirmText: '废弃',
      cancelText: '返回',
      danger: true,
    })
    if (!ok) return
    try {
      await taskboardApi.deprecateProjectMemory(auth, project.id, o.slug, o.version)
      await refresh()
    } catch (e) {
      toast(taskboardErrorMessage(e, '废弃失败'), 'error')
    }
  }

  if (!items) return null
  // 候选队列只剩存量:自动晋升之前写下的 pending/conflict 还需要人工消化,之后这一段消失。
  const leftover = items.candidates.filter((c) => c.status === 'pending' || c.status === 'conflict')
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3" data-testid="project-memory-review">
      <h3 className="text-section font-semibold text-fg">项目记忆</h3>
      <p className="text-caption text-muted">
        agent 整理出的项目记忆会在下一次执行时自动带上；不再需要的可以在下方废弃。
      </p>
      {leftover.length > 0 && (
        <p className="text-caption text-muted">以下条目写于改为自动生效之前，还没有生效：</p>
      )}
      {leftover.map((c) => (
        <div key={c.id ?? c.file} className="rounded-lg bg-hover px-3 py-2 text-body">
          <div className="font-medium">{c.slug}</div>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-caption text-muted">
            {(c.content ?? '').slice(0, 800)}
          </pre>
          <div className="mt-2 flex gap-1">
            <Button
              type="button"
              size="sm"
              data-testid={`project-memory-promote-${c.id}`}
              onClick={() => {
                void taskboardApi
                  .promoteProjectMemory(auth, project.id, c.id ?? '', c.version)
                  .then(() => refresh())
                  .catch((e) => toast(taskboardErrorMessage(e, '采纳失败'), 'error'))
              }}
            >
              采纳
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                void taskboardApi
                  .rejectProjectMemory(auth, project.id, c.id ?? '', c.version)
                  .then(() => refresh())
                  .catch((e) => toast(taskboardErrorMessage(e, '忽略失败'), 'error'))
              }}
            >
              忽略
            </Button>
          </div>
        </div>
      ))}
      <h4 className="text-meta font-semibold text-fg">生效中的记忆</h4>
      {items.official.length === 0 ? (
        <p className="text-caption text-muted">还没有项目记忆。</p>
      ) : (
        items.official.map((o) => (
          <div key={o.slug} className="flex items-center justify-between gap-2 text-body">
            <span>
              {o.slug}
              {o.deprecated ? '（已废弃）' : ''}
              {o.tampered ? '（文件被改动过，未注入）' : ''}
            </span>
            {!o.deprecated && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                data-testid={`project-memory-deprecate-${o.slug}`}
                onClick={() => void deprecate(o)}
              >
                废弃
              </Button>
            )}
          </div>
        ))
      )}
    </div>
  )
}
