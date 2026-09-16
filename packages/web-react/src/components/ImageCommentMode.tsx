/**
 * 评论模式(ChatGPT 同款「模型驱动精确修改」):在图片上落数字锚点(蓝底白字圆点),点图新增、
 * 点锚点改文案/删除。提交时**不再客户端合成 mask/guide** —— 而是发一条**普通对话消息**:
 *   media = [原图(可见,非 hidden)]
 *   text  = 固定前导 + 每锚点一行「n. (x: NN%, y: NN%) 文案」(左上角为原点,百分比整数)
 * 由 GPT 看图 + 坐标调它自己的原生 imagegen 完成精确修改。原图能复用持久 /api/media 引用就
 * 直接复用,否则取签名 URL 字节交 App 上传一次(签名 URL 会过期,禁当持久 MediaRef)。
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, Trash2, X } from 'lucide-react'
import { apiErrorMessage } from '../lib/api'
import { fetchImageBlobWithResign } from '../lib/chat/media'
import { useProgressiveImage } from '../lib/chat/useProgressiveImage'
import { cn } from '../lib/utils'
import type { ImageCommentSubmit } from './chat/imageEditActions'

type Anchor = { id: string; x: number; y: number; text: string }

const COMMENT_TEXT_LEAD =
  '请按下列标注修改这张图片，编号对应以下坐标（图片左上角为原点，百分比）：'

/** 前导 + 每锚点一行「n. (x: NN%, y: NN%) 文案」;NN = 归一化坐标 ×100 后取整。 */
function buildCommentText(anchors: Anchor[]): string {
  const lines = anchors.map((a, i) => {
    const x = Math.round(a.x * 100)
    const y = Math.round(a.y * 100)
    return `${i + 1}. (x: ${x}%, y: ${y}%) ${a.text.trim()}`
  })
  return [COMMENT_TEXT_LEAD, ...lines].join('\n')
}

/** 上传件扩展名跟 blob 真实类型走(签名源可能是 jpeg/webp),不再一律 .png。 */
function fileExtensionFor(type: string): string {
  const subtype = type.split('/')[1]?.split(';')[0]?.toLowerCase() ?? ''
  if (subtype === 'jpeg' || subtype === 'jpg') return 'jpg'
  if (subtype === 'webp' || subtype === 'gif' || subtype === 'png') return subtype
  return 'png'
}

export function ImageCommentMode({
  src,
  alt,
  resolveSrc,
  cacheIdentity,
  canSubmit,
  onBack,
  onSubmit,
  escapeHandlerRef,
}: {
  src: string
  alt: string
  resolveSrc: (opts?: { forceResign?: boolean }) => Promise<string | null>
  /**
   * 字节缓存身份(signPath)。传入即让展示图与提交取字节都**零请求复用**查看器/气泡已下载的
   * 原图字节(共享 LRU 命中),并在原图到达前先铺已缓存缩略图(渐进、禁灰/白屏)。
   */
  cacheIdentity?: string | null
  canSubmit: boolean
  onBack: () => void
  onSubmit: (value: ImageCommentSubmit) => Promise<void>
  /**
   * 宿主(ImageViewer)的 Esc 委托口。Radix DismissableLayer 在 document **捕获**阶段派发 Esc,
   * 宿主的 onEscapeKeyDown 永远先于本组件输入框的 onKeyDown 触发 —— 此前宿主见 comment 模式就
   * 直接退回浏览态,用户在输入框里按 Esc 想取消一条草稿,结果整个评论模式连同已落锚点全丢
   * (审计 M-02)。现在宿主先调这里:返回 true = 本组件已消费(取消草稿 / 弹确认 / 提交中吞掉),
   * 宿主什么都不做;false = 没有可丢的东西,宿主照旧退回浏览态。
   */
  escapeHandlerRef?: RefObject<(() => boolean) | null>
}) {
  const [anchors, setAnchors] = useState<Anchor[]>([])
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [inputText, setInputText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 误触保护(审计 M-03):有未发送锚点时点 X / 按 Esc → 先弹确认层,空白直接退。与圈选编辑器同口径。
  const [confirmBack, setConfirmBack] = useState(false)
  // 直链(data:/blob:/http)裂图只能靠 <img onError> 感知(渐进 hook 对直链是透传不 fetch)。
  const [imgError, setImgError] = useState(false)
  // 展示态 src:重试时重签后更新它,让展示管线换新 URL 重载(此前重试只重签 provider
  // 缓存却不换 src,过期裂图点重试无效)。
  const [displaySrc, setDisplaySrc] = useState(src)
  useEffect(() => {
    setDisplaySrc(src)
    setImgError(false)
  }, [src])
  // 展示图收口到渐进 hook:签名 URL 命中共享 LRU 即**零请求复用**查看器/气泡已下载的原图;
  // miss 时先铺已缓存缩略图做即时预览(禁灰/白屏)再无缝换原图,并汇报百分比。lazy=false:
  // 查看器打开即可见,立即拉。403/410 由 hook 内部强制重签自愈。
  const { objectUrl, percent, status, reload } = useProgressiveImage({
    src: displaySrc,
    width: null,
    cacheIdentity,
    resolveSrc,
    lazy: false,
  })
  const loadError = imgError || status === 'error'
  const loading = status === 'loading'

  const editing = draft != null || editingId != null

  const addAt = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (busy) return
    const rect = event.currentTarget.getBoundingClientRect()
    // 键盘触发的 click(Enter/Space)没有坐标(detail===0,clientX/Y 为 0)→ 落在图片中心,
    // 而不是左上角 (0,0)(审计 M-26);之后可点锚点改文案,坐标写在提交文本里可见。
    const fromKeyboard = event.detail === 0
    const x = fromKeyboard || rect.width <= 0 ? 0.5 : (event.clientX - rect.left) / rect.width
    const y = fromKeyboard || rect.height <= 0 ? 0.5 : (event.clientY - rect.top) / rect.height
    setEditingId(null)
    setInputText('')
    setDraft({ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) })
  }

  const openAnchor = (a: Anchor) => {
    setDraft(null)
    setEditingId(a.id)
    setInputText(a.text)
  }

  const confirmInput = () => {
    const text = inputText.trim()
    if (draft) {
      if (!text) {
        setDraft(null)
        return
      }
      setAnchors((cur) => [...cur, { id: crypto.randomUUID(), x: draft.x, y: draft.y, text }])
      setDraft(null)
      setInputText('')
      return
    }
    if (editingId) {
      setAnchors((cur) =>
        text ? cur.map((a) => (a.id === editingId ? { ...a, text } : a)) : cur.filter((a) => a.id !== editingId),
      )
      setEditingId(null)
      setInputText('')
    }
  }

  const cancelInput = () => {
    setDraft(null)
    setEditingId(null)
    setInputText('')
  }

  const removeEditing = () => {
    if (!editingId) return
    setAnchors((cur) => cur.filter((a) => a.id !== editingId))
    setEditingId(null)
    setInputText('')
  }

  // 稳定的 ref 回调:只在确认层挂上那一刻聚焦一次,不随重渲反复抢焦点。
  const focusOnMount = useCallback((el: HTMLButtonElement | null) => el?.focus(), [])

  // 脏状态 = 有已落锚点,或输入条里有没确认的文字。返回请求先过这一关。
  const dirty = anchors.length > 0 || inputText.trim().length > 0
  const requestBack = () => {
    if (busy) return
    if (dirty) setConfirmBack(true)
    else onBack()
  }

  // Esc 委托(见 escapeHandlerRef 说明)。读 ref 里的最新快照:Radix 绑定的是挂载时闭包,
  // 宿主每次拿到的 handler 也必须看到最新 state。
  const escStateRef = useRef({ busy, confirmBack, editing, dirty })
  escStateRef.current = { busy, confirmBack, editing, dirty }
  // biome-ignore lint/correctness/useExhaustiveDependencies: cancelInput 只 setState,捕获首帧闭包即可;状态全部经 escStateRef 读最新值
  useEffect(() => {
    if (!escapeHandlerRef) return
    escapeHandlerRef.current = () => {
      const s = escStateRef.current
      if (s.busy) return true
      if (s.confirmBack) {
        setConfirmBack(false)
        return true
      }
      if (s.editing) {
        cancelInput()
        return true
      }
      if (s.dirty) {
        setConfirmBack(true)
        return true
      }
      return false
    }
    return () => {
      escapeHandlerRef.current = null
    }
  }, [escapeHandlerRef])

  const send = async () => {
    if (!canSubmit || anchors.length === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      const text = buildCommentText(anchors)
      if (/^\/api\/media\//.test(src)) {
        // 持久服务端 URL → 直接复用,不重新上传。
        await onSubmit({ text, reuseUrl: src })
      } else {
        // 容器签名 URL / data: / blob: 等非持久源 → 取字节(过期自愈)交 App 上传一次。
        const url = (await resolveSrc()) ?? src
        const blob = await fetchImageBlobWithResign(url, resolveSrc, { cacheIdentity })
        const type = blob.type || 'image/png'
        const file = new File([blob], `${alt?.trim() || 'image'}.${fileExtensionFor(type)}`, { type })
        await onSubmit({ text, sourceFile: file })
      }
    } catch (err) {
      setError(apiErrorMessage(err, '提交失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  const count = anchors.length

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* 顶栏:X | N 条评论 | 发送 */}
      <header className="relative z-20 flex min-h-14 shrink-0 items-center justify-between gap-3 px-3 pt-[env(safe-area-inset-top)]">
        <button
          type="button"
          aria-label="返回预览"
          // 走 requestBack:有锚点/未确认文字先弹确认,空白直接退(审计 M-03)。
          onClick={requestBack}
          className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20 [@media(hover:none)]:size-11"
        >
          <X size={20} />
        </button>
        <h2 className="text-sm font-semibold text-white">{count} 条评论</h2>
        <button
          type="button"
          disabled={!canSubmit || count === 0 || busy}
          onClick={() => void send()}
          className="flex min-h-10 items-center gap-1.5 rounded-full bg-white px-4 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <span className="animate-pulse">提交…</span> : (
            <>
              发送 <ArrowUp size={16} />
            </>
          )}
        </button>
      </header>

      {/* 图片 + 锚点 */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-4">
        {loadError ? (
          <div role="alert" className="flex flex-col items-center gap-3 text-center text-white/80">
            <p className="text-sm">图片加载失败</p>
            <button
              type="button"
              onClick={() => {
                setImgError(false)
                reload()
                void resolveSrc({ forceResign: true }).then((u) => u && setDisplaySrc(u))
              }}
              className="min-h-10 rounded-full bg-white/10 px-4 text-sm text-white hover:bg-white/20"
            >
              重试
            </button>
          </div>
        ) : (
          <div className="relative inline-block max-h-full max-w-full">
            {objectUrl ? (
              <img
                src={objectUrl}
                alt={alt}
                onError={() => setImgError(true)}
                draggable={false}
                className="max-h-full max-w-full select-none object-contain"
              />
            ) : (
              // 冷加载(无任何缓存字节):深色骨架(禁纯白),给锚点层一个可点区域,shimmer 尊重
              // reduced-motion(oc-img-skeleton CSS 已处理)。
              <div className="oc-img-skeleton h-64 w-64 max-w-full rounded-lg" aria-hidden />
            )}
            {/* 加载中:百分比徽标(命中缓存瞬时 loaded → 不出现)。 */}
            {loading && (
              <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium tabular-nums text-white backdrop-blur">
                {percent != null ? `${percent}%` : '加载中…'}
              </div>
            )}
            {/* 落点层:点空白处新增锚点 */}
            <button
              type="button"
              aria-label="点按图片添加评论"
              onClick={addAt}
              className="absolute inset-0 z-0 cursor-crosshair"
            />
            {/* 已落锚点:28px 圆点视觉不变,外包一圈 44px 透明命中区(审计 M-15,触屏才点得中)。 */}
            {anchors.map((a, i) => (
              <button
                key={a.id}
                type="button"
                aria-label={`评论 ${i + 1}`}
                onClick={() => openAnchor(a)}
                style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%` }}
                className="absolute z-10 flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                <span
                  aria-hidden
                  className={cn(
                    'flex size-7 items-center justify-center rounded-full border-2 border-white text-xs font-bold text-white shadow-float',
                    editingId === a.id ? 'bg-accent' : 'bg-[rgba(56,132,255,0.96)]',
                  )}
                >
                  {i + 1}
                </span>
              </button>
            ))}
            {/* 草稿锚点(未确认) */}
            {draft && (
              <span
                aria-hidden
                style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%` }}
                className="absolute z-10 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-[rgba(56,132,255,0.7)] text-xs font-bold text-white"
              >
                {count + 1}
              </span>
            )}
          </div>
        )}
      </div>

      {/* 底部:输入条 或 空态提示 */}
      <div className="shrink-0 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
        {error && (
          <p role="alert" className="mx-auto mb-2 max-w-2xl rounded-lg bg-danger/25 px-3 py-1.5 text-center text-sm text-white">
            {error}
          </p>
        )}
        {editing ? (
          <div className="mx-auto flex w-full max-w-2xl items-center gap-2 rounded-2xl bg-white/10 px-3 py-2 backdrop-blur">
            {editingId && (
              <button
                type="button"
                aria-label="删除该评论"
                onClick={removeEditing}
                className="flex size-9 shrink-0 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-danger [@media(hover:none)]:size-11"
              >
                <Trash2 size={16} />
              </button>
            )}
            <input
              type="text"
              autoFocus
              aria-label="描述编辑"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  confirmInput()
                } else if (e.key === 'Escape') {
                  cancelInput()
                }
              }}
              placeholder="描述编辑"
              maxLength={400}
              className="min-w-0 flex-1 bg-transparent text-base text-white outline-none placeholder:text-white/40"
            />
            <button
              type="button"
              aria-label="确认"
              onClick={confirmInput}
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-black transition-opacity hover:opacity-90 [@media(hover:none)]:size-11"
            >
              <Check size={16} />
            </button>
          </div>
        ) : (
          <p className="py-2 text-center text-sm text-white/60">
            {count === 0 ? '点按图片添加评论' : '点按图片继续添加，或点锚点修改'}
          </p>
        )}
      </div>

      {/* 误触保护确认层(审计 M-03):有未发送锚点 / 未确认文字时点 X 或按 Esc → 此层;空白直接退。
          与 ImageAnnotationEditor 的「放弃编辑确认」同款,同一入口的两个子模式对未保存工作态度一致。 */}
      {confirmBack && (
        <div
          role="alertdialog"
          aria-label="放弃评论确认"
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 px-6 backdrop-blur-sm"
        >
          <div className="w-full max-w-xs rounded-2xl bg-neutral-900 p-5 text-center shadow-float">
            <p className="text-sm text-white">
              {count > 0 ? `放弃这 ${count} 条评论？返回后已添加的标注不会保留。` : '放弃正在输入的评论？'}
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                // alertdialog 打开即把焦点放到"安全"的那个键上(继续评论),Esc/Enter 都不会误触放弃。
                ref={focusOnMount}
                onClick={() => setConfirmBack(false)}
                className="min-h-11 flex-1 rounded-full bg-white/10 text-sm font-medium text-white transition-colors hover:bg-white/20"
              >
                继续评论
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmBack(false)
                  onBack()
                }}
                className="min-h-11 flex-1 rounded-full bg-danger text-sm font-semibold text-white transition-opacity hover:opacity-90"
              >
                放弃
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
