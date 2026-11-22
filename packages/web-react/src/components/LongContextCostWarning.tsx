import { Gauge } from 'lucide-react'

export const LONG_CONTEXT_CONFIRM_TITLE = '切换到 1M 上下文？'
export const LONG_CONTEXT_CONFIRM_TEXT = '仍要切换'
export const LONG_CONTEXT_CANCEL_TEXT = '保留标准'

export function LongContextCostWarning() {
  return (
    <div className="space-y-3 text-body text-muted">
      <div className="oc-callout oc-callout-warning flex items-start gap-2.5 rounded-xl px-3.5 py-2.5">
        <span className="oc-icon-badge oc-icon-badge-warning mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md">
          <Gauge size={13} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <p className="font-medium text-fg">1M 上下文的基础单位价是标准上下文的 1.5 倍。</p>
      </div>
      {/* 单一字符串,避免 JSX 换行在「上下文，」与「缓存读取」之间塞进一个空格(C-35)。 */}
      <p className="leading-relaxed">
        {
          '实际总费用不一定只增加 50%：长会话中的每次推理和工具调用都会反复读取更大的上下文，缓存读取 Token 会持续累计，步骤越多、上下文越长，费用可能明显更高。'
        }
      </p>
      <p className="text-meta text-faint">建议仅在标准上下文不足，或确实需要保留超长会话时开启。</p>
    </div>
  )
}
