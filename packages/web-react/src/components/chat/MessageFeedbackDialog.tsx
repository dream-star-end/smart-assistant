import { CheckCircle2, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, apiErrorMessage } from '../../lib/api'
import { reportClientFriction } from '../../lib/clientFriction'
import type { AuthSession } from '../../lib/types'
import { cn } from '../../lib/utils'
import { Alert, Button, Modal, Spinner, Textarea, alertVariants } from '../ui'
import type { FeedbackContext } from './cards'

const REASONS = [
  '不准确',
  '没完成',
  '没按要求',
  '工具失败',
  '太慢',
  '太啰嗦',
  '格式问题',
  '其他',
] as const

/**
 * 从单条消息动作打开的反馈弹窗。只发送显式列出的关联字段；回复摘录由用户可见勾选控制，
 * 不读取前序消息、完整会话、工具记录、URL 或诊断日志。
 */
export function MessageFeedbackDialog({
  open,
  onOpenChange,
  auth,
  sessionId,
  context,
  returnFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  auth: AuthSession
  sessionId: string | null
  context: FeedbackContext | null
  /** 打开弹窗的消息动作按钮；关闭时把键盘焦点准确还给它。 */
  returnFocus?: HTMLElement | null
}) {
  const [reason, setReason] = useState<string>('')
  const [detail, setDetail] = useState('')
  const [includeExcerpt, setIncludeExcerpt] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submittedId, setSubmittedId] = useState<string | null>(null)
  const submittingRef = useRef(false)
  const telemetryIdRef = useRef<string | null>(null)
  const generationRef = useRef(0)
  const responseExcerpt = context?.textPreview.slice(0, 120) ?? ''

  useEffect(() => {
    generationRef.current += 1
    if (!open || !context) return
    setReason('')
    setDetail('')
    setIncludeExcerpt(Boolean(context.textPreview.slice(0, 120)))
    setSubmitting(false)
    setError(null)
    setSubmittedId(null)
    submittingRef.current = false
    telemetryIdRef.current = reportClientFriction(
      {
        surface: 'feedback',
        stage: 'message_open',
        code: 'MESSAGE_OPENED',
        outcome: 'succeeded',
        traceId: context.traceId ?? undefined,
        sessionId: sessionId ?? undefined,
      },
      auth.snapshot().token,
    )
  }, [open, context, sessionId, auth])

  async function submit() {
    if (!context || submittingRef.current) return
    const generation = generationRef.current
    const trimmed = detail.trim()
    if (!reason && !trimmed) {
      setError('请选择一个原因，或补充具体情况。')
      return
    }

    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    const telemetryId =
      telemetryIdRef.current ??
      reportClientFriction(
        {
          surface: 'feedback',
          stage: 'message_open',
          code: 'MESSAGE_OPENED',
          outcome: 'succeeded',
          traceId: context.traceId ?? undefined,
          sessionId: sessionId ?? undefined,
        },
        auth.snapshot().token,
      )
    reportClientFriction(
      {
        eventId: telemetryId,
        surface: 'feedback',
        stage: 'submit',
        code: 'SUBMIT',
        outcome: 'pending',
        traceId: context.traceId ?? undefined,
        sessionId: sessionId ?? undefined,
      },
      auth.snapshot().token,
    )

    try {
      const result = await api.submitFeedback(auth, {
        category: 'response',
        description: [reason, trimmed].filter(Boolean).join('：'),
        requestId: context.traceId ?? undefined,
        sessionId: sessionId ?? undefined,
        meta: {
          source: 'message',
          messageId: context.messageId,
          role: context.role,
          ...(context.errorCode ? { errorCode: context.errorCode } : {}),
          ...(reason ? { reason } : {}),
          ...(includeExcerpt && responseExcerpt ? { responseExcerpt } : {}),
        },
      })
      if (generation === generationRef.current) setSubmittedId(result.id)
      reportClientFriction(
        {
          eventId: telemetryId,
          surface: 'feedback',
          stage: 'submit',
          code: 'SUBMIT',
          outcome: 'succeeded',
          traceId: context.traceId ?? undefined,
          sessionId: sessionId ?? undefined,
        },
        auth.snapshot().token,
      )
    } catch (cause) {
      if (generation === generationRef.current) {
        setError(apiErrorMessage(cause, '提交反馈失败，请稍后重试'))
      }
      reportClientFriction(
        {
          eventId: telemetryId,
          surface: 'feedback',
          stage: 'submit',
          code: 'SUBMIT',
          outcome: 'failed',
          traceId: context.traceId ?? undefined,
          sessionId: sessionId ?? undefined,
        },
        auth.snapshot().token,
      )
    } finally {
      if (generation === generationRef.current) {
        submittingRef.current = false
        setSubmitting(false)
      }
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="反馈这条回复"
      description="选择一个原因即可提交，也可以补充更多细节。"
      className="max-w-md"
      onCloseAutoFocus={(event) => {
        if (!returnFocus?.isConnected) return
        event.preventDefault()
        returnFocus.focus()
      }}
    >
      {submittedId ? (
        <output
          aria-live="polite"
          className={alertVariants({ tone: 'success', className: 'w-full' })}
        >
          <span className="mt-0.5 shrink-0 text-success">
            <CheckCircle2 size={18} />
          </span>
          <span className="min-w-0 text-fg">
            <span className="block font-semibold">反馈已收到</span>
            <span className="mt-0.5 block text-muted">反馈编号 #{submittedId}</span>
          </span>
        </output>
      ) : (
        <>
          {responseExcerpt && (
            <div className="mb-4 rounded-lg border border-border bg-surface px-3 py-2.5">
              <p className="line-clamp-3 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-muted">
                {responseExcerpt}
              </p>
              <label className="mt-2 flex cursor-pointer items-start gap-2 text-[11.5px] leading-relaxed text-faint">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-accent"
                  checked={includeExcerpt}
                  disabled={submitting}
                  onChange={(event) => setIncludeExcerpt(event.target.checked)}
                />
                附上以上回复摘录，帮助定位问题
              </label>
            </div>
          )}

          <fieldset disabled={submitting}>
            <legend className="text-[12.5px] font-medium text-fg">哪里不够好？</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {REASONS.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={reason === item}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                    reason === item
                      ? 'border-accent/50 bg-accent-soft text-accent'
                      : 'border-border text-muted hover:border-accent/40 hover:text-fg',
                  )}
                  onClick={() => {
                    setReason((current) => (current === item ? '' : item))
                    if (error) setError(null)
                  }}
                >
                  {item}
                </button>
              ))}
            </div>
          </fieldset>

          <label
            className="mt-4 block text-[12.5px] font-medium text-fg"
            htmlFor="message-feedback-detail"
          >
            补充说明（可选）
          </label>
          <Textarea
            id="message-feedback-detail"
            className="mt-2 min-h-24 resize-y"
            value={detail}
            maxLength={10_000}
            disabled={submitting}
            placeholder="例如：哪一步不对、你原本期待什么"
            onChange={(event) => {
              setDetail(event.target.value)
              if (error) setError(null)
            }}
          />

          {error && (
            <Alert tone="danger" className="mt-3 text-[12.5px]">
              {error}
            </Alert>
          )}

          <Button className="mt-4 w-full" variant="primary" disabled={submitting} onClick={submit}>
            {submitting ? (
              <>
                <Spinner /> 提交中…
              </>
            ) : (
              '提交反馈'
            )}
          </Button>
        </>
      )}

      <div className="mt-4 flex items-start gap-2 text-[11.5px] leading-relaxed text-faint">
        <ShieldCheck size={14} className="mt-0.5 shrink-0" />
        <p>不会附带前序对话、工具记录或诊断日志；回复摘录是否发送由你决定。</p>
      </div>
    </Modal>
  )
}
