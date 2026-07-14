import { CheckCircle2, MessageSquareText, ShieldCheck } from 'lucide-react'
import { type FormEvent, useRef, useState } from 'react'
import { type FeedbackCategory, api, apiErrorMessage } from '../../lib/api'
import type { AuthSession } from '../../lib/types'
import { Alert, Button, Spinner, Textarea, alertVariants } from '../ui'

export const FEEDBACK_DESCRIPTION_MIN = 15
export const FEEDBACK_DESCRIPTION_MAX = 10_000

const CATEGORY_OPTIONS: Array<{ value: FeedbackCategory; label: string }> = [
  { value: 'bug', label: '问题反馈' },
  { value: 'feature', label: '功能建议' },
  { value: 'ux', label: '体验问题' },
  { value: 'other', label: '其他' },
]

const DESCRIPTION_HELP_ID = 'settings-feedback-description-help'
const DESCRIPTION_ERROR_ID = 'settings-feedback-description-error'

function currentBuildId(): string | undefined {
  const value = document.querySelector<HTMLMetaElement>('meta[name="oc-build"]')?.content.trim()
  return value || undefined
}

function feedbackMeta() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return {
    source: 'settings' as const,
    ...(navigator.language ? { locale: navigator.language } : {}),
    ...(timezone ? { timezone } : {}),
  }
}

/** 设置中心反馈分区：只发送用户主动填写的正文与最小环境元数据，不附带任何对话内容。 */
export function FeedbackTab({ auth }: { auth: AuthSession }) {
  const [category, setCategory] = useState<FeedbackCategory>('bug')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<{ message: string; field: boolean } | null>(null)
  const [submittedId, setSubmittedId] = useState<string | null>(null)
  const submittingRef = useRef(false)

  const trimmed = description.trim()

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submittingRef.current) return

    if (trimmed.length < FEEDBACK_DESCRIPTION_MIN) {
      setError({
        message: `请至少填写 ${FEEDBACK_DESCRIPTION_MIN} 个字符，说明发生了什么以及你的期望。`,
        field: true,
      })
      return
    }
    if (trimmed.length > FEEDBACK_DESCRIPTION_MAX) {
      setError({
        message: `反馈内容不能超过 ${FEEDBACK_DESCRIPTION_MAX.toLocaleString('zh-CN')} 个字符。`,
        field: true,
      })
      return
    }

    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      const result = await api.submitFeedback(auth, {
        category,
        description: trimmed,
        version: currentBuildId(),
        meta: feedbackMeta(),
      })
      setSubmittedId(result.id)
    } catch (cause) {
      setError({
        message: apiErrorMessage(cause, '提交反馈失败，请稍后重试'),
        field: false,
      })
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  function reset() {
    setCategory('bug')
    setDescription('')
    setError(null)
    setSubmittedId(null)
  }

  return (
    <div className="px-5 py-5">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <MessageSquareText size={20} />
        </div>
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-fg">告诉我们哪里还能更好</h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
            遇到问题、有功能想法或觉得哪里不顺手，都可以直接告诉我们。
          </p>
        </div>
      </div>

      {submittedId ? (
        <div className="mt-5">
          <output
            aria-live="polite"
            className={alertVariants({ tone: 'success', className: 'w-full' })}
          >
            <span className="mt-0.5 shrink-0 text-success">
              <CheckCircle2 size={18} />
            </span>
            <span className="min-w-0 text-fg">
              <span className="block font-semibold">反馈已收到</span>
              <span className="mt-0.5 block text-muted">
                感谢你的反馈。反馈编号为 #{submittedId}，方便后续排查时引用。
              </span>
            </span>
          </output>
          <Button className="mt-4 w-full" variant="secondary" onClick={reset}>
            再提一条
          </Button>
        </div>
      ) : (
        <form className="mt-5" aria-label="反馈表单" aria-busy={submitting} onSubmit={submit}>
          <label
            className="block text-[12.5px] font-medium text-fg"
            htmlFor="settings-feedback-category"
          >
            反馈类型
          </label>
          <select
            id="settings-feedback-category"
            value={category}
            onChange={(event) => setCategory(event.target.value as FeedbackCategory)}
            disabled={submitting}
            className="mt-2 h-10 w-full rounded-lg border border-border bg-surface px-3.5 text-base text-fg outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-2 focus:ring-ring disabled:opacity-50 md:text-sm"
          >
            {CATEGORY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label
            className="mt-4 block text-[12.5px] font-medium text-fg"
            htmlFor="settings-feedback-description"
          >
            反馈内容
          </label>
          <Textarea
            id="settings-feedback-description"
            className="mt-2 min-h-36 resize-y"
            value={description}
            maxLength={FEEDBACK_DESCRIPTION_MAX}
            disabled={submitting}
            aria-invalid={error?.field ? true : undefined}
            aria-describedby={`${DESCRIPTION_HELP_ID}${error?.field ? ` ${DESCRIPTION_ERROR_ID}` : ''}`}
            placeholder={
              '请描述发生了什么、你原本期待怎样，以及必要的复现步骤。\n\n请勿填写密码、密钥等敏感信息。'
            }
            onChange={(event) => {
              setDescription(event.target.value)
              if (error) setError(null)
            }}
          />
          <div
            id={DESCRIPTION_HELP_ID}
            className="mt-1.5 flex items-center justify-between gap-3 text-[11.5px] text-faint"
          >
            <span>至少 {FEEDBACK_DESCRIPTION_MIN} 个字符</span>
            <span>
              {description.length.toLocaleString('zh-CN')} /{' '}
              {FEEDBACK_DESCRIPTION_MAX.toLocaleString('zh-CN')}
            </span>
          </div>

          {error && (
            <Alert
              id={error.field ? DESCRIPTION_ERROR_ID : undefined}
              tone="danger"
              className="mt-3 text-[12.5px]"
            >
              {error.message}
            </Alert>
          )}

          <Button className="mt-4 w-full" variant="primary" type="submit" disabled={submitting}>
            {submitting ? (
              <>
                <Spinner /> 提交中…
              </>
            ) : (
              '提交反馈'
            )}
          </Button>
        </form>
      )}

      <div className="mt-4 flex items-start gap-2 text-[11.5px] leading-relaxed text-faint">
        <ShieldCheck size={14} className="mt-0.5 shrink-0" />
        <p>
          仅发送你填写的内容、反馈类型和基础环境信息，不会自动附带对话内容。反馈会由团队查看，但不承诺逐条回复。
        </p>
      </div>
    </div>
  )
}
