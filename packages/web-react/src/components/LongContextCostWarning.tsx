export const LONG_CONTEXT_CONFIRM_TITLE = '切换到 1M 上下文？'
export const LONG_CONTEXT_CONFIRM_TEXT = '仍要切换'
export const LONG_CONTEXT_CANCEL_TEXT = '保留标准'

export function LongContextCostWarning() {
  return (
    <div className="space-y-2 text-sm text-muted">
      <p>1M 上下文的基础单位价是标准上下文的 1.5 倍。</p>
      <p>
        实际总费用不一定只增加 50%：长会话中的每次推理和工具调用都会反复读取更大的上下文， 缓存读取
        Token 会持续累计，步骤越多、上下文越长，费用可能明显更高。
      </p>
      <p>建议仅在标准上下文不足，或确实需要保留超长会话时开启。</p>
    </div>
  )
}
