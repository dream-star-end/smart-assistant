import { BookOpen, Search, Trash2, Upload } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, apiErrorMessage } from '../../lib/api'
import type { AuthSession, ResearchLibraryDoc } from '../../lib/types'
import { cn } from '../../lib/utils'
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  IconButton,
  ListSkeleton,
  PanelHeader,
  Spinner,
  TimeAgo,
  Toolbar,
  buttonVariants,
  useConfirm,
  useToast,
} from '../ui'

const LANG_LABEL: Record<string, string> = { zh: '中文', en: '英文', other: '其他' }

/**
 * 上传入口的 input id。**必须走 `<label htmlFor>` 原生激活**：
 * 国产内核（鸿蒙 / 华为 / Quark）会静默吞掉 `display:none` input 上的合成 click
 * （实证 61de46e2 / de16e2be），那批用户点「上传入库」是完全没反应的，也没有任何报错。
 * 同理不挂 accept 白名单 —— 它会把国产内核的选择器整个灰掉；类型判定交给后端，
 * 前端在失败时给中文提示。写法照 Composer.tsx 已在线上验证过的那套。
 */
const UPLOAD_INPUT_ID = 'library-upload-input'

/** 超过这个条数才出检索框 —— 少量条目时搜索框只是噪音（与技能库同一口径）。 */
const FILTER_THRESHOLD = 5

/**
 * 文献库中心:列出已入库的权威文档(oc-ingest / UI 上传统一落 research_documents),
 * 支持上传 PDF/文本入库与删除。数据在 master(非容器代理):/api/me/research/library*。
 * 删除语义:已生成报告的历史引用不受影响;之后再 cite/check 回查不到该文档会按
 * fail-closed 判未核查 —— 与"证据必须可回查"的红线一致。
 */
export function LibraryPanel({ auth }: { auth: AuthSession }) {
  const [docs, setDocs] = useState<ResearchLibraryDoc[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  /** 入库降级提示（扫描件等"这次其实没成功"的情况）。成功走 toast，不与失败共用一种语气。 */
  const [warning, setWarning] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadingName, setUploadingName] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [reload, setReload] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)
  const [confirmDialog, confirmDialogEl] = useConfirm()
  const toast = useToast()

  useEffect(() => {
    let alive = true
    setLoading(true)
    setErr(null)
    api
      .listResearchLibrary(auth)
      .then((d) => {
        if (alive) setDocs(d)
      })
      .catch((e) => {
        if (alive) setErr(apiErrorMessage(e, '加载文献库失败'))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [auth, reload])

  const refresh = useCallback(() => setReload((n) => n + 1), [])

  const onUpload = useCallback(
    async (file: File) => {
      setUploading(true)
      setUploadingName(file.name)
      setErr(null)
      setWarning(null)
      try {
        const r = await api.uploadResearchDoc(auth, file)
        if (r.needsOcr) {
          // 这一路其实**没有入库成功**，不能和成功共用同一种蓝色提示。
          setWarning(
            `「${file.name}」是扫描件（没有文字层），暂时无法入库。可以先用 OCR 工具转成可复制文字的 PDF 再上传。`,
          )
        } else {
          // 新行会出现在列表里（可能在视口外）→ 反馈走 toast，不留在按钮旁边。
          toast(`「${r.title || file.name}」已入库（${r.spanCount ?? 0} 个片段）`, 'success')
          refresh()
        }
      } catch (e) {
        setErr(apiErrorMessage(e, '上传入库失败，仅支持 PDF / TXT / Markdown / HTML'))
      } finally {
        setUploading(false)
        setUploadingName(null)
        if (fileRef.current) fileRef.current.value = ''
      }
    },
    [auth, refresh, toast],
  )

  const remove = useCallback(
    async (doc: ResearchLibraryDoc) => {
      const title = doc.title || '(无标题文档)'
      const ok = await confirmDialog({
        title: `删除文献「${title}」?`,
        body: (
          <>
            删除后新的引用核查将无法回查到该文档;已生成的报告不受影响。
            <span className="mt-2 block text-caption text-faint">
              文档 ID：<span className="select-all font-mono">{doc.docId}</span>
            </span>
          </>
        ),
        confirmText: '删除',
        danger: true,
      })
      if (!ok) return
      try {
        await api.deleteResearchDoc(auth, doc.docId)
        toast(`已删除「${title}」`, 'success')
        refresh()
      } catch (e) {
        toast(apiErrorMessage(e, '删除失败'), 'error')
      }
    },
    [auth, confirmDialog, refresh, toast],
  )

  const filtered = useMemo(() => {
    if (!docs) return []
    const q = query.trim().toLowerCase()
    if (!q) return docs
    return docs.filter((d) => (d.title || '').toLowerCase().includes(q))
  }, [docs, query])

  const total = docs?.length ?? 0
  const showFilter = total > FILTER_THRESHOLD

  const uploadControl = (
    <>
      <input
        id={UPLOAD_INPUT_ID}
        ref={fileRef}
        type="file"
        tabIndex={-1}
        // 两个 label（头部 + 空态 CTA）都指向这一个 input，名字由 aria-label 钉死，
        // 免得读屏把两段按钮文案拼成一个名字。
        aria-label="选择要入库的文献文件"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onUpload(f)
        }}
      />
      <label
        htmlFor={UPLOAD_INPUT_ID}
        className={cn(
          buttonVariants({ size: 'sm' }),
          'cursor-pointer',
          uploading && 'pointer-events-none opacity-60',
        )}
      >
        {uploading ? (
          <>
            <Spinner size={13} /> 正在解析入库…
          </>
        ) : (
          <>
            <Upload size={14} /> 上传入库
          </>
        )}
      </label>
    </>
  )

  return (
    <div className="flex flex-col">
      <PanelHeader
        title={total > 0 ? `文献库（${total}）` : '文献库'}
        hint="已入库的权威文档（报告引用证据从这里回查）。支持 PDF / TXT / Markdown / HTML，单篇上限 25MB。"
        action={uploadControl}
      />

      {showFilter && (
        <Toolbar
          search={query}
          onSearchChange={setQuery}
          searchPlaceholder="按标题过滤…"
          count={query.trim() ? filtered.length : null}
          debounceMs={120}
        />
      )}

      <div className="flex flex-col gap-3 px-4 py-3">
        {err && (
          <Alert
            tone="danger"
            density="compact"
            action={
              docs === null ? (
                <Button size="sm" variant="secondary" onClick={refresh}>
                  重试
                </Button>
              ) : undefined
            }
            onDismiss={docs === null ? undefined : () => setErr(null)}
          >
            {err}
          </Alert>
        )}
        {warning && (
          <Alert tone="warning" density="compact" onDismiss={() => setWarning(null)}>
            {warning}
          </Alert>
        )}

        {loading ? (
          <ListSkeleton rows={4} />
        ) : err && docs === null ? null : total === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="文献库为空"
            hint="上传一篇 PDF 就能开始：入库后报告里的引用可以逐条回查。也可以在对话里让科研助手自动检索并入库。"
            action={
              <label
                htmlFor={UPLOAD_INPUT_ID}
                className={cn(
                  buttonVariants({ variant: 'accent', size: 'sm' }),
                  'cursor-pointer',
                  uploading && 'pointer-events-none opacity-60',
                )}
              >
                {uploading ? (
                  <>
                    <Spinner size={13} /> 正在解析入库…
                  </>
                ) : (
                  <>
                    <Upload size={14} /> 上传第一篇文献
                  </>
                )}
              </label>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Search}
            title="没有匹配的文献"
            hint="换个关键词试试，或清空搜索框查看全部。"
            action={
              <Button size="sm" variant="secondary" onClick={() => setQuery('')}>
                清空搜索
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {/* 等待发生在内容所在的位置：25MB 的 PDF 要走上传 + 服务端解析切片，
                只在按钮上转圈会让人以为卡死。 */}
            {uploading && uploadingName && (
              <li className="flex items-center gap-3 px-3.5 py-2.5">
                <BookOpen size={15} className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-section font-medium text-fg">{uploadingName}</div>
                  <div className="mt-0.5 text-caption text-faint">正在解析并切片…</div>
                </div>
                <Badge tone="accent" size="sm">
                  解析中
                </Badge>
              </li>
            )}
            {filtered.map((d) => (
              <li key={d.docId} className="flex items-center gap-3 px-3.5 py-2.5">
                <BookOpen size={15} className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-section font-medium text-fg">
                    {d.title || '(无标题文档)'}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge tone="neutral" size="sm">
                      {LANG_LABEL[d.lang] ?? d.lang}
                    </Badge>
                    <Badge tone="neutral" size="sm">
                      {d.spanCount} 段
                    </Badge>
                    <span className="text-caption text-faint">
                      <TimeAgo value={d.createdAt} format="short" tooltip={false} /> 入库
                    </span>
                  </div>
                </div>
                <IconButton
                  variant="danger"
                  size="sm"
                  aria-label={`删除文献「${d.title || '(无标题文档)'}」`}
                  title="删除文献"
                  onClick={() => void remove(d)}
                >
                  <Trash2 size={14} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </div>
      {confirmDialogEl}
    </div>
  )
}
