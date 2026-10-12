import { createContext, useContext, useEffect, useState } from 'react'
import { type StepTiming, combineStepTimings, formatStepDuration } from '../../lib/chat/stepTiming'
import { groupDigits } from '../../lib/utils'
import { type DisplayTokenUsage, TokenUsageBadge, tokenUsageSnapshot } from './tokenUsage'

/**
 * OCV5-367: per-step timings of the process timeline this card sits in.
 * null = not inside a timeline (the card keeps its token badge there).
 */
export const StepTimingContext = createContext<ReadonlyMap<string, StepTiming> | null>(null)

function useTicker(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [enabled])
  return now
}

/**
 * Right-hand meta of a step row. Inside the process timeline it shows how
 * long the step took (live steps count up); the model call's token total
 * moves to the tooltip. A step without a recorded time shows nothing.
 * Outside the timeline it is the plain token badge.
 */
export function StepMetaBadge({
  ids,
  tokenUsage,
}: {
  ids: readonly (string | undefined)[]
  tokenUsage?: DisplayTokenUsage
}) {
  const timings = useContext(StepTimingContext)
  const known = ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
  const timing = combineStepTimings(timings, known)
  const running = timing?.runningSince !== undefined
  const now = useTicker(running)
  if (!timings) return <TokenUsageBadge usage={tokenUsage} />
  if (!timing) return null
  const ms = timing.runningSince !== undefined ? now - timing.runningSince : timing.ms
  if (!Number.isFinite(ms) || ms < 0) return null
  const text = formatStepDuration(ms)
  const usage = tokenUsageSnapshot(tokenUsage)
  const tokens = usage
    ? `；所在模型调用${tokenUsage?.shared ? '共' : usage.estimated ? '约' : ''} ${groupDigits(String(usage.totalTokens))} token`
    : ''
  const title = running
    ? `本步已用时 ${text}（自上一步结束起算）${tokens}`
    : `本步耗时 ${text}（自上一步结束起算，含模型生成与执行）${tokens}`
  return (
    <span
      data-testid="step-duration"
      data-step-running={running ? 'true' : 'false'}
      className="whitespace-nowrap text-caption font-medium tabular-nums text-faint"
      title={title}
      aria-label={title}
    >
      {text}
    </span>
  )
}
