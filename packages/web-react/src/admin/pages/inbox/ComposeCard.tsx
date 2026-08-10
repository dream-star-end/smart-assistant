import {
  BarChart3,
  Bold,
  Code2,
  Eye,
  GitBranch,
  Heading2,
  ImagePlus,
  Link,
  List,
  Send,
  Trash2,
  UploadCloud,
} from 'lucide-react'
import {
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Markdown } from '../../../components/Markdown'
import {
  Badge,
  Button,
  IconButton,
  Input,
  Switch,
  Tabs,
  Textarea,
  useConfirm,
  useToast,
} from '../../../components/ui'
import { INBOX_LEVEL_META } from '../../../lib/inboxLevels'
import { cn } from '../../../lib/utils'
import { SectionCard, SelectFilter } from '../../components'
import { adminGet, adminSend, apiErrorMessage } from '../../lib/adminApi'
import {
  type CreateMessagePayload,
  type EmailConfig,
  INBOX_LEVEL_LABELS,
  type InboxAudience,
  type InboxCategory,
  type InboxLevel,
} from './types'

const AUDIENCE_TABS = [
  { value: 'all', label: '全员广播' },
  { value: 'user', label: '单个用户' },
]

const EDITOR_TABS = [
  { value: 'edit', label: '编辑' },
  { value: 'preview', label: '预览' },
]

const LEVEL_OPTIONS: { label: string; value: InboxLevel }[] = (
  Object.keys(INBOX_LEVEL_LABELS) as InboxLevel[]
).map((level) => ({ label: INBOX_LEVEL_LABELS[level], value: level }))
const CATEGORY_OPTIONS: { label: string; value: InboxCategory }[] = [
  { label: '用户沟通', value: 'user' },
  { label: '自动化', value: 'automation' },
  { label: '计费', value: 'billing' },
  { label: '运维', value: 'operations' },
  { label: '营销', value: 'marketing' },
]

const USER_ID_RE = /^[1-9]\d{0,19}$/
const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024
const MAX_IMAGES = 8

const CHART_TEMPLATE = `\n\n\`\`\`chart
{"type":"bar","data":{"labels":["一月","二月","三月"],"datasets":[{"label":"数量","data":[12,19,8]}]}}
\`\`\`\n`

const MERMAID_TEMPLATE = `\n\n\`\`\`mermaid
flowchart LR
  A[开始] --> B{条件}
  B -->|是| C[完成]
  B -->|否| D[调整]
\`\`\`\n`

type ComposerAsset = {
  clientId: string
  file: File
  previewUrl: string
}

function fileToBase64(file: File): Promise<string> {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
    }
    return btoa(binary)
  })
}

function imageAlt(filename: string): string {
  return (
    filename
      .replace(/[\[\]\\\r\n]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || '图片'
  )
}

/** 站内信发送卡：富 Markdown 编辑、图片上传、图表模板与实时卡片预览。 */
export function ComposeCard({ onSent }: { onSent: () => void }) {
  const toast = useToast()
  const [confirm, confirmEl] = useConfirm()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const assetsRef = useRef<ComposerAsset[]>([])

  const [audience, setAudience] = useState<InboxAudience>('all')
  const [userId, setUserId] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [level, setLevel] = useState<InboxLevel>('info')
  const [category, setCategory] = useState<InboxCategory>('user')
  const [expires, setExpires] = useState('')
  const [notifyEmail, setNotifyEmail] = useState(false)
  const [busy, setBusy] = useState(false)
  const [mobilePane, setMobilePane] = useState<'edit' | 'preview'>('edit')
  const [dragging, setDragging] = useState(false)
  const [assets, setAssets] = useState<ComposerAsset[]>([])

  const [emailCfg, setEmailCfg] = useState<EmailConfig | null>(null)
  const [emailHint, setEmailHint] = useState('加载中…')

  assetsRef.current = assets
  useEffect(
    () => () => {
      for (const asset of assetsRef.current) URL.revokeObjectURL(asset.previewUrl)
    },
    [],
  )

  useEffect(() => {
    let alive = true
    adminGet<EmailConfig>('/messages/email-config')
      .then((cfg) => {
        if (!alive) return
        setEmailCfg(cfg)
        if (cfg.enabled === false) {
          setEmailHint('邮件 worker 已禁用（COMMERCIAL_INBOX_EMAIL_DISABLED=1），勾选无效。')
        } else if (cfg.provider === 'stub') {
          setEmailHint('当前为 stub mailer（未配 RESEND_API_KEY），邮件只打日志，不真发出。')
        } else {
          setEmailHint(`已启用，provider=${cfg.provider}。富内容在邮件中降级为登录查看提示。`)
        }
      })
      .catch((error) => {
        if (!alive) return
        setEmailCfg({ enabled: false, provider: 'stub' })
        setEmailHint(`探测邮件配置失败：${apiErrorMessage(error, '请求失败')}`)
      })
    return () => {
      alive = false
    }
  }, [])

  const emailDisabled = emailCfg?.enabled === false
  const previewBody = useMemo(() => {
    let value = body
    for (const asset of assets) {
      value = value.replaceAll(`inbox-asset://${asset.clientId}`, asset.previewUrl)
    }
    return value
  }, [assets, body])
  const hasExternalImage = /!\[[^\]]*\]\((?:https?:)?\/\//i.test(body)

  const insertText = useCallback(
    (text: string, wrapEnd = '', fallback = '文字') => {
      const el = textareaRef.current
      const start = el?.selectionStart ?? body.length
      const end = el?.selectionEnd ?? body.length
      const selected = body.slice(start, end) || fallback
      const inserted = wrapEnd ? `${text}${selected}${wrapEnd}` : text
      const next = `${body.slice(0, start)}${inserted}${body.slice(end)}`
      setBody(next)
      const caret = start + inserted.length
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        textareaRef.current?.setSelectionRange(caret, caret)
      })
    },
    [body],
  )

  const addFiles = useCallback(
    (incoming: File[]) => {
      if (incoming.length === 0) return
      if (incoming.some((file) => !ACCEPTED_IMAGE_TYPES.has(file.type))) {
        toast('仅支持 PNG、JPEG、WebP 图片', 'error')
        return
      }
      if (incoming.some((file) => file.size > MAX_IMAGE_BYTES)) {
        toast('单张图片不能超过 5 MiB', 'error')
        return
      }
      if (assets.length + incoming.length > MAX_IMAGES) {
        toast('每条站内信最多 8 张图片', 'error')
        return
      }
      const total = [...assets.map((asset) => asset.file), ...incoming].reduce(
        (sum, file) => sum + file.size,
        0,
      )
      if (total > MAX_TOTAL_IMAGE_BYTES) {
        toast('图片总大小不能超过 15 MiB', 'error')
        return
      }

      const added = incoming.map((file) => ({
        clientId: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
      }))
      setAssets((current) => [...current, ...added])
      insertText(
        `${body && !body.endsWith('\n') ? '\n' : ''}${added
          .map((asset) => `![${imageAlt(asset.file.name)}](inbox-asset://${asset.clientId})`)
          .join('\n')}\n`,
        '',
        '',
      )
    },
    [assets, body, insertText, toast],
  )

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith('image/'),
    )
    if (images.length === 0) return
    event.preventDefault()
    addFiles(images)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    addFiles(Array.from(event.dataTransfer.files))
  }

  const removeAsset = (clientId: string) => {
    const asset = assets.find((item) => item.clientId === clientId)
    if (asset) URL.revokeObjectURL(asset.previewUrl)
    setAssets((current) => current.filter((item) => item.clientId !== clientId))
    const marker = `inbox-asset://${clientId}`
    setBody((current) =>
      current
        .split('\n')
        .filter((line) => !line.includes(marker))
        .join('\n')
        .replaceAll(marker, ''),
    )
  }

  const send = async () => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      toast('标题不能为空', 'error')
      return
    }
    if (!body.trim()) {
      toast('正文不能为空', 'error')
      return
    }
    if (assets.some((asset) => !body.includes(`inbox-asset://${asset.clientId}`))) {
      toast('有图片未插入正文，请删除或重新插入', 'error')
      return
    }
    if (audience === 'user' && !USER_ID_RE.test(userId.trim())) {
      toast('user_id 必须是正整数', 'error')
      return
    }
    let expiresAt: string | undefined
    if (expires) {
      const date = new Date(expires)
      if (Number.isNaN(date.getTime())) {
        toast('过期时间格式不对', 'error')
        return
      }
      expiresAt = date.toISOString()
    }

    const ok = await confirm({
      title:
        audience === 'all' ? '向全体用户发送站内信？' : `向用户 #${userId.trim()} 发送站内信？`,
      body:
        notifyEmail && !emailDisabled
          ? '站内富内容会完整展示；邮件将以纯文本降级发送。操作不可撤销。'
          : '站内信发出后用户铃铛即可拉取，图片与图表会在卡片内渲染。',
      confirmText: '发送',
    })
    if (!ok) return

    setBusy(true)
    try {
      const payload: CreateMessagePayload = {
        audience,
        title: trimmedTitle,
        body_md: body,
        level,
        category,
      }
      if (audience === 'user') payload.user_id = userId.trim()
      if (expiresAt) payload.expires_at = expiresAt
      if (notifyEmail && !emailDisabled) payload.notify_email = true
      if (assets.length > 0) {
        payload.assets = await Promise.all(
          assets.map(async (asset) => ({
            client_id: asset.clientId,
            filename: asset.file.name,
            mime_type: asset.file.type as 'image/png' | 'image/jpeg' | 'image/webp',
            data_base64: await fileToBase64(asset.file),
          })),
        )
      }

      const result = await adminSend<{
        message?: { notify_email?: boolean; email_summary?: { total?: number } }
      }>('POST', '/messages', payload)
      if (result?.message?.notify_email) {
        toast(
          `已发送，邮件 worker 将异步发出 ${result.message.email_summary?.total ?? 0} 封`,
          'success',
        )
      } else {
        toast('已发送', 'success')
      }
      for (const asset of assets) URL.revokeObjectURL(asset.previewUrl)
      setAssets([])
      setTitle('')
      setBody('')
      setExpires('')
      setMobilePane('edit')
      onSent()
    } catch (error) {
      toast(apiErrorMessage(error, '发送失败'), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionCard title="新建站内信" hint="卡片消息 · Markdown · 图片 · 数据图表">
      {confirmEl}
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Field label="收件范围">
            <Tabs
              value={audience}
              onValueChange={(value) => setAudience(value as InboxAudience)}
              items={AUDIENCE_TABS}
              aria-label="收件范围"
            />
          </Field>
          {audience === 'user' && (
            <Field label="user_id">
              <Input
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                placeholder="例如 1234"
                inputMode="numeric"
              />
            </Field>
          )}
        </div>

        <Field label="标题">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            placeholder="≤200 字"
          />
        </Field>

        <Field label="正文" hint="支持 GFM Markdown、Chart.js 与 Mermaid；图片可选择、粘贴或拖入">
          <div className="mb-2 lg:hidden">
            <Tabs
              value={mobilePane}
              onValueChange={(value) => setMobilePane(value as 'edit' | 'preview')}
              items={EDITOR_TABS}
              aria-label="编辑或预览"
            />
          </div>
          <div
            className={cn(
              'overflow-hidden rounded-xl border bg-surface transition-colors',
              dragging ? 'border-accent ring-2 ring-ring' : 'border-border',
            )}
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <div
              className={cn(
                'flex flex-wrap items-center gap-0.5 border-b border-border bg-hover/50 px-2 py-1.5',
                mobilePane === 'preview' && 'hidden lg:flex',
              )}
            >
              <ToolButton label="二级标题" onClick={() => insertText('## ', '', '')}>
                <Heading2 size={15} />
              </ToolButton>
              <ToolButton label="加粗" onClick={() => insertText('**', '**')}>
                <Bold size={15} />
              </ToolButton>
              <ToolButton label="列表" onClick={() => insertText('- ', '', '')}>
                <List size={15} />
              </ToolButton>
              <ToolButton
                label="链接"
                onClick={() => insertText('[', '](https://example.com)', '链接文字')}
              >
                <Link size={15} />
              </ToolButton>
              <ToolButton label="代码" onClick={() => insertText('`', '`')}>
                <Code2 size={15} />
              </ToolButton>
              <span className="mx-1 h-5 w-px bg-border" aria-hidden />
              <ToolButton label="上传图片" onClick={() => fileInputRef.current?.click()}>
                <ImagePlus size={15} />
              </ToolButton>
              <ToolButton
                label="插入数据图表模板"
                onClick={() => insertText(CHART_TEMPLATE, '', '')}
              >
                <BarChart3 size={15} />
              </ToolButton>
              <ToolButton
                label="插入流程图模板"
                onClick={() => insertText(MERMAID_TEMPLATE, '', '')}
              >
                <GitBranch size={15} />
              </ToolButton>
              <span className="ml-auto hidden items-center gap-1 text-[11px] text-faint sm:inline-flex">
                <Eye size={12} /> 右侧实时预览
              </span>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                aria-label="选择站内信图片"
                onChange={(event) => {
                  addFiles(Array.from(event.target.files ?? []))
                  event.target.value = ''
                }}
              />
            </div>

            <div className="grid min-h-[22rem] lg:grid-cols-2">
              <div
                className={cn(
                  'min-w-0 border-border lg:block lg:border-r',
                  mobilePane === 'preview' && 'hidden',
                )}
              >
                <Textarea
                  ref={textareaRef}
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  onPaste={onPaste}
                  rows={14}
                  maxLength={16_384}
                  placeholder="输入 Markdown，或把图片拖到这里…"
                  className="min-h-[22rem] resize-y rounded-none border-0 bg-transparent font-mono text-[13px] focus:ring-0"
                />
                <div className="flex items-center justify-between border-t border-border px-3 py-2 text-[11px] text-faint">
                  <span className="inline-flex items-center gap-1">
                    <UploadCloud size={12} /> 最多 8 张，共 15 MiB
                  </span>
                  <span className="tabular-nums">{body.length} / 16,384</span>
                </div>
              </div>

              <div
                className={cn(
                  'min-w-0 bg-bg/50 p-3 lg:block sm:p-4',
                  mobilePane === 'edit' && 'hidden',
                )}
              >
                <PreviewCard title={title.trim()} level={level} body={previewBody} />
              </div>
            </div>
          </div>
        </Field>

        {assets.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {assets.map((asset) => (
              <div
                key={asset.clientId}
                className="flex items-center gap-2 rounded-lg border border-border bg-surface p-2"
              >
                <img
                  src={asset.previewUrl}
                  alt=""
                  className="size-11 shrink-0 rounded-md object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-fg">{asset.file.name}</p>
                  <p className="text-[11px] text-faint">
                    {(asset.file.size / 1024 / 1024).toFixed(2)} MiB
                  </p>
                </div>
                <IconButton
                  size="sm"
                  aria-label={`删除图片 ${asset.file.name}`}
                  onClick={() => removeAsset(asset.clientId)}
                >
                  <Trash2 size={14} />
                </IconButton>
              </div>
            ))}
          </div>
        )}

        {hasExternalImage && (
          <p className="rounded-lg bg-warning-soft px-3 py-2 text-[12px] leading-relaxed text-warning">
            外链图片会让第三方图片服务器看到收件人的 IP 与访问时间；敏感内容请使用平台上传。
          </p>
        )}

        <div className="flex flex-wrap gap-4">
          <Field label="消息分类">
            <SelectFilter value={category} options={CATEGORY_OPTIONS} onChange={setCategory} />
          </Field>
          <Field label="级别">
            <SelectFilter value={level} options={LEVEL_OPTIONS} onChange={setLevel} />
          </Field>
          <Field label="过期时间" hint="留空则永不过期">
            <Input
              type="datetime-local"
              value={expires}
              onChange={(event) => setExpires(event.target.value)}
              className="sm:w-56"
            />
          </Field>
        </div>

        <Field label="邮件推送">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2.5">
              <Switch
                checked={notifyEmail && !emailDisabled}
                disabled={emailDisabled}
                onCheckedChange={setNotifyEmail}
                aria-label="同时发邮件到用户邮箱"
              />
              <span className="text-[13px] text-fg">
                同时发邮件到用户邮箱（图片和图表降级为“登录站内信查看”）
              </span>
            </div>
            <p className="text-[12px] text-faint">{emailHint}</p>
          </div>
        </Field>

        <div className="flex justify-end">
          <Button variant="primary" onClick={send} disabled={busy}>
            <Send size={15} />
            {busy ? '发送中…' : '发送'}
          </Button>
        </div>
      </div>
    </SectionCard>
  )
}

function PreviewCard({ title, level, body }: { title: string; level: InboxLevel; body: string }) {
  const meta = INBOX_LEVEL_META[level]
  return (
    <article className="mx-auto overflow-hidden rounded-xl border border-border bg-elevated shadow-soft">
      <header className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-[14px] font-semibold text-fg">
            {title || '站内信标题'}
          </p>
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </div>
        <p className="mt-1 text-[11px] text-faint">用户收到的卡片预览</p>
      </header>
      <div className="min-h-52 overflow-hidden px-4 py-4 text-[13px] text-fg">
        {body.trim() ? (
          <Markdown signMedia readOnly>
            {body}
          </Markdown>
        ) : (
          <p className="text-muted">在左侧输入 Markdown，预览会实时更新。</p>
        )}
      </div>
    </article>
  )
}

function ToolButton({
  label,
  onClick,
  children,
}: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="size-8 text-muted"
    >
      {children}
    </Button>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[12px] font-medium text-faint">{label}</span>
        {hint && <span className="text-[11px] text-faint/80">{hint}</span>}
      </div>
      {children}
    </div>
  )
}
