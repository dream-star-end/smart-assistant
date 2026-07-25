import { CheckCircle2, MessageSquareText, ShieldCheck } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { type FeedbackCategory, api, apiErrorMessage } from '../../lib/api'
import { reportClientFriction } from '../../lib/clientFriction'
import type { AuthSession } from '../../lib/types'
import { cn } from '../../lib/utils'
import { Alert, Button, Spinner, Textarea, alertVariants } from '../ui'

export const FEEDBACK_DESCRIPTION_MAX = 10_000

const CATEGORY_OPTIONS: Array<{ value: FeedbackCategory; label: string }> = [
  { value: 'bug', label: '问题反馈' },
  { value: 'feature', label: '功能建议' },
  { value: 'ux', label: '体验问题' },
  { value: 'other', label: '其他' },
]

const DESCRIPTION_HELP_ID = 'settings-feedback-description-help'
const DESCRIPTION_ERROR_ID = 'settings-feedback-description-error'
const DRAFT_VERSION = 1

type FeedbackDraft = {
  version: typeof DRAFT_VERSION
  category: FeedbackCategory
  description: string
}

function draftKey(userId: string): string {
  return `oc.feedback.settings.v${DRAFT_VERSION}.${userId}`
}

function readDraft(userId: string): Omit<FeedbackDraft, 'version'> {
  try {
    const parsed = JSON.parse(
      sessionStorage.getItem(draftKey(userId)) ?? 'null',
    ) as Partial<FeedbackDraft> | null
    const category = parsed?.category
    if (
      parsed?.version === DRAFT_VERSION &&
      typeof category === 'string' &&
      CATEGORY_OPTIONS.some((option) => option.value === category) &&
      typeof parsed.description === 'string' &&
      parsed.description.length <= FEEDBACK_DESCRIPTION_MAX
    ) {
      return { category, description: parsed.description }
    }
  } catch {
    // sessionStorage may be unavailable in privacy-restricted WebViews; draft persistence is best-effort.
  }
  return { category: 'bug', description: '' }
}

function writeDraft(userId: string, category: FeedbackCategory, description: string): void {
  try {
    if (!description) {
      sessionStorage.removeItem(draftKey(userId))
      return
    }
    sessionStorage.setItem(
      draftKey(userId),
      JSON.stringify({ version: DRAFT_VERSION, category, description } satisfies FeedbackDraft),
    )
  } catch {
    // Best-effort only; feedback submission itself must remain available.
  }
}

function clearDraft(userId: string): void {
  try {
    sessionStorage.removeItem(draftKey(userId))
  } catch {
    // ignore unavailable storage
  }
}

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
export function FeedbackTab({
  auth,
  userId,
  context,
}: {
  auth: AuthSession
  userId: string
  context?: { sessionId: string | null; requestId: string | null }
}) {
  const [initialDraft] = useState(() => readDraft(userId))
  const [category, setCategory] = useState<FeedbackCategory>(initialDraft.category)
  const [description, setDescription] = useState(initialDraft.description)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<{ message: string; field: boolean } | null>(null)
  const [submittedId, setSubmittedId] = useState<string | null>(null)
  const [includeContext, setIncludeContext] = useState(
    Boolean(context?.sessionId || context?.requestId),
  )
  const submittingRef = useRef(false)
  const loadedUserRef = useRef(userId)
  const skipNextPersistRef = useRef(false)
  const telemetryIdRef = useRef<string | null>(null)

  const trimmed = description.trim()

  useEffect(() => {
    if (loadedUserRef.current === userId) return
    const next = readDraft(userId)
    loadedUserRef.current = userId
    skipNextPersistRef.current = true
    setCategory(next.category)
    setDescription(next.description)
    setError(null)
    setSubmittedId(null)
  }, [userId])

  useEffect(() => {
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false
      return
    }
    writeDraft(userId, category, description)
  }, [userId, category, description])

  useEffect(() => {
    telemetryIdRef.current = reportClientFriction(
      {
        surface: 'feedback',
        stage: 'settings_open',
        code: 'SETTINGS_OPENED',
        outcome: 'succeeded',
      },
      auth.snapshot().token,
    )
  }, [auth])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submittingRef.current) return

    if (!trimmed) {
      setError({
        message: '请填写反馈内容。',
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
    const telemetryId =
      telemetryIdRef.current ??
      reportClientFriction(
        {
          surface: 'feedback',
          stage: 'settings_open',
          code: 'SETTINGS_OPENED',
          outcome: 'succeeded',
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
      },
      auth.snapshot().token,
    )
    try {
      const result = await api.submitFeedback(auth, {
        category,
        description: trimmed,
        version: currentBuildId(),
        ...(includeContext && context?.requestId ? { requestId: context.requestId } : {}),
        ...(includeContext && context?.sessionId ? { sessionId: context.sessionId } : {}),
        meta: feedbackMeta(),
      })
      setSubmittedId(result.id)
      clearDraft(userId)
      reportClientFriction(
        {
          eventId: telemetryId,
          surface: 'feedback',
          stage: 'submit',
          code: 'SUBMIT',
          outcome: 'succeeded',
        },
        auth.snapshot().token,
      )
    } catch (cause) {
      setError({
        message: apiErrorMessage(cause, '提交反馈失败，请稍后重试'),
        field: false,
      })
      reportClientFriction(
        {
          eventId: telemetryId,
          surface: 'feedback',
          stage: 'submit',
          code: 'SUBMIT',
          outcome: 'failed',
        },
        auth.snapshot().token,
      )
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
    telemetryIdRef.current = reportClientFriction(
      {
        surface: 'feedback',
        stage: 'settings_open',
        code: 'SETTINGS_OPENED',
        outcome: 'succeeded',
      },
      auth.snapshot().token,
    )
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
          <fieldset disabled={submitting}>
            <legend className="block text-[12.5px] font-medium text-fg">反馈类型</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {CATEGORY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={category === option.value}
                  onClick={() => setCategory(option.value)}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                    category === option.value
                      ? 'border-accent/50 bg-accent-soft text-accent'
                      : 'border-border text-muted hover:border-accent/40 hover:text-fg',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>

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
            <span>草稿仅保存在当前账号的本标签页</span>
            <span>
              {description.length.toLocaleString('zh-CN')} /{' '}
              {FEEDBACK_DESCRIPTION_MAX.toLocaleString('zh-CN')}
            </span>
          </div>

          {(context?.sessionId || context?.requestId) && (
            <label className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-elevated px-3 py-2.5 text-[12px] text-muted">
              <input
                type="checkbox"
                checked={includeContext}
                disabled={submitting}
                onChange={(event) => setIncludeContext(event.target.checked)}
                className="mt-0.5 size-4 accent-[var(--color-accent)]"
              />
              <span>
                <span className="block font-medium text-fg">附带当前会话定位信息</span>
                <span className="mt-0.5 block text-faint">
                  仅附带会话 ID 和最近回复的请求 ID，不包含对话正文或工具记录。
                </span>
              </span>
            </label>
          )}

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
          仅发送你填写的内容、反馈类型和基础环境信息；即使附带定位信息，也不会发送对话内容。反馈会由团队查看，但不承诺逐条回复。
        </p>
      </div>
    </div>
  )
}
