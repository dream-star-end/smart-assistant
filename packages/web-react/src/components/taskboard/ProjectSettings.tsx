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
import { Button, Field, IconButton, Input, Sheet, Textarea, useConfirm, useToast } from '../ui'

type Mode = 'create' | 'edit'

export function ProjectSettings({
  auth,
  current,
  onCreate,
  onPatch,
  onArchive,
  onUnarchive,
  compact = false,
}: {
  auth: AuthSession
  current: Project | null
  onCreate: (input: ProjectCreateInput) => Promise<Project | null>
  onPatch: (id: string, input: ProjectPatchInput) => Promise<Project | null>
  onArchive: (id: string) => Promise<boolean>
  onUnarchive: (id: string) => Promise<boolean>
  compact?: boolean
}) {
  const toast = useToast()
  const [confirm, confirmEl] = useConfirm()
  const [mode, setMode] = useState<Mode | null>(null)
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [archived, setArchived] = useState<Project[]>([])
  const [templateIds, setTemplateIds] = useState<string[]>(() =>
    BUILTIN_TEMPLATE_OPTIONS.map((t) => t.id),
  )
  const [workspaceKind, setWorkspaceKind] = useState<'default' | 'isolated' | 'container_path'>(
    'default',
  )
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
        setWorkspaceError('容器路径必须是绝对路径，且落在 workspace/ 或 repos/ 下。')
        return null
      }
      if (path.includes('/projects/') && !path.includes('/workspace/projects/')) {
        setWorkspaceError('~/.openclaude/projects 是项目数据目录，不能当工作区。')
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
      {compact ? (
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
              aria-label="编辑项目"
              shape="square"
              onClick={() => setMode('edit')}
            >
              <Pencil size={16} />
            </IconButton>
          )}
        </>
      )}
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) close()
        }}
        side="right"
        srTitle={mode === 'edit' ? '编辑项目' : '新建项目'}
        className="w-[36rem] max-w-[96vw]"
      >
        <div
          data-testid={mode === 'edit' ? 'project-edit' : 'project-create'}
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
        >
          <div>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-title font-semibold text-fg">
                {mode === 'edit' ? '编辑项目' : '新建项目'}
              </h2>
              {compact && mode === 'edit' && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setMode('create')}
                >
                  <FolderPlus size={14} />
                  新建项目
                </Button>
              )}
            </div>
            <p className="mt-1 text-caption text-muted">
              {mode === 'edit'
                ? '前缀创建后不可改。归档项目默认不出现在下拉里。'
                : '创建后会自动切到该项目。可选择要种的流水线模板；默认四条内置线全选，全部取消则不种。'}
            </p>
          </div>
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
            hint="绑定会话默认用项目工作区。若该会话绑定了 GitHub 仓库且 clone 就绪，聊天会切到仓库快照（覆盖项目工作区）。数据目录 ~/.openclaude/projects 不能当 cwd。"
            error={workspaceError || undefined}
          >
            <div className="flex flex-col gap-1.5" data-testid="project-workspace-spec">
              {(
                [
                  ['default', '默认（OPENCLAUDE_DEFAULT_WORKSPACE / 进程 cwd）'],
                  ['isolated', '隔离（workspace/projects/<项目id>）'],
                  ['container_path', '容器绝对路径（仅 workspace/ 或 repos/）'],
                ] as const
              ).map(([kind, label]) => (
                <label
                  key={kind}
                  className="flex items-center gap-2 rounded-lg bg-hover px-3 py-2 text-body text-fg"
                >
                  <input
                    type="radio"
                    name="project-workspace-kind"
                    data-testid={`project-workspace-${kind}`}
                    checked={workspaceKind === kind}
                    onChange={() => {
                      setWorkspaceKind(kind)
                      setWorkspaceError('')
                    }}
                  />
                  <span>{label}</span>
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
                loading={saving}
                data-testid="project-create-submit"
                onClick={() => void submitCreate()}
              >
                创建项目
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  size="sm"
                  loading={saving}
                  data-testid="project-edit-save"
                  onClick={() => void submitEdit()}
                >
                  保存
                </Button>
                {current && !current.archivedAt && (
                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    loading={saving}
                    data-testid="project-archive"
                    onClick={() => void archiveCurrent()}
                  >
                    归档
                  </Button>
                )}
              </>
            )}
          </div>
          {mode === 'edit' && current && (
            <>
              <ProjectContextPanel auth={auth} project={current} />
              <ProjectMemoryReview auth={auth} project={current} />
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
        </div>
      </Sheet>
      {confirmEl}
    </>
  )
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
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3" data-testid="project-context-panel">
      <h3 className="text-section font-semibold text-fg">项目上下文</h3>
      <p className="text-caption text-muted">仅审计，不可逐字重放。动态事实须 live 核验。</p>
      {summary && (
        <dl className="grid grid-cols-2 gap-1 text-caption text-muted">
          <dt>version</dt>
          <dd className="text-fg">{String(summary.version ?? project.contextVersion ?? 0)}</dd>
          <dt>工作区</dt>
          <dd className="text-fg">{JSON.stringify(summary.workspaceSpec ?? project.workspaceSpec ?? { kind: 'default' })}</dd>
        </dl>
      )}
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
        预览注入槽
      </Button>
      {preview && Array.isArray(preview.slots) && (
        <ul className="text-caption text-muted">
          {(preview.slots as Array<{ name: string; bytes: number; redacted?: boolean; volatile?: boolean }>).map(
            (s) => (
              <li key={s.name}>
                {s.name} · {s.bytes}B{s.volatile ? ' · live' : ''}
                {s.redacted ? ' · 已脱敏' : ''}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  )
}

function ProjectMemoryReview({ auth, project }: { auth: AuthSession; project: Project }) {
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

  if (!items) return null
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3" data-testid="project-memory-review">
      <h3 className="text-section font-semibold text-fg">项目记忆</h3>
      <p className="text-caption text-muted">
        候选需人工采纳后才会注入下一轮。Agent 直接改 memory/*.md 不会绕过晋升。
      </p>
      {items.candidates.length === 0 ? (
        <p className="text-caption text-faint">没有待审核候选。</p>
      ) : (
        items.candidates.map((c) => (
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
                    .catch((e) => toast(taskboardErrorMessage(e, '丢弃失败'), 'error'))
                }}
              >
                丢弃
              </Button>
            </div>
          </div>
        ))
      )}
      <h4 className="text-meta font-semibold text-fg">正式 / 废弃</h4>
      {items.official.length === 0 ? (
        <p className="text-caption text-faint">尚无正式项目记忆。</p>
      ) : (
        items.official.map((o) => (
          <div key={o.slug} className="flex items-center justify-between gap-2 text-body">
            <span>
              {o.slug}
              {o.deprecated ? '（已废弃）' : ''}
              {o.tampered ? '（文件被篡改，未注入）' : ''}
            </span>
            {!o.deprecated && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  void taskboardApi
                    .deprecateProjectMemory(auth, project.id, o.slug, o.version)
                    .then(() => refresh())
                    .catch((e) => toast(taskboardErrorMessage(e, '废弃失败'), 'error'))
                }}
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
