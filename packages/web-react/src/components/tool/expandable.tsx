/**
 * 通用「截断 + 展开全部」文本原语(F4)。
 *
 * 此前工具体各处(OutputBlock 1500 / Read·Grep·Glob 2000 / Write 500 / oc 详情 4000)
 * 全是"只截不展"的硬截断,超出部分用户无法在卡内看到。这里收敛为统一原语:
 *   - 默认显示前 N 字 + 「展开全部(共 X 字)」按钮,展开后可再「收起」;
 *   - 超大内容(> 256KB)展开后分段加载,64KB 步进「继续显示」(参考 AgentGroupCard);
 *   - 详情面板(ToolBodyFullContext)下初始上限放宽为 FULL_TEXT_CAP,同样可继续展开。
 */
import { type ReactNode, useContext, useState } from 'react'
import { cn } from '../../lib/utils'
import { ToolBodyFullContext } from './context'
import { useHighlighter } from './highlight'
import { stripAnsi } from './stripAnsi'

/** 全文模式(详情面板)的初始上限:防单条超大 output 打爆渲染,可继续分段展开。 */
export const FULL_TEXT_CAP = 200_000

/** 展开后的首屏字符数;超过则分段「继续显示」。 */
const EXPAND_INITIAL_CHARS = 256 * 1024
/** 「继续显示」每次追加的字符数(对齐 AgentGroupCard 的 64KB 分段)。 */
const EXPAND_STEP_CHARS = 64 * 1024

export interface ExpandableSlice {
  /** 当前应渲染的文本切片。 */
  shown: string
  /** 是否仍有未显示的尾部(折叠截断或分段未加载完)。 */
  truncated: boolean
  /** 是否处于展开态。 */
  expanded: boolean
  /** 剩余未显示字符数。 */
  remaining: number
  totalChars: number
  expand: () => void
  collapse: () => void
  showMore: () => void
}

/** 截断/展开状态机(hook 形态,渲染样式交给调用方)。 */
export function useExpandableSlice(text: string, collapsedMax: number): ExpandableSlice {
  const full = useContext(ToolBodyFullContext)
  const limit = full ? FULL_TEXT_CAP : collapsedMax
  const [expanded, setExpanded] = useState(false)
  const [visibleChars, setVisibleChars] = useState(EXPAND_INITIAL_CHARS)
  const visible = expanded ? Math.max(visibleChars, limit) : limit
  const shown = text.length > visible ? text.slice(0, visible) : text
  return {
    shown,
    truncated: text.length > shown.length,
    expanded,
    remaining: text.length - shown.length,
    totalChars: text.length,
    expand: () => setExpanded(true),
    collapse: () => {
      setExpanded(false)
      setVisibleChars(EXPAND_INITIAL_CHARS)
    },
    showMore: () => setVisibleChars((v) => v + EXPAND_STEP_CHARS),
  }
}

const CONTROL_BTN_CLS =
  'rounded text-xs text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring'

/** 截断态提示 + 展开/继续/收起按钮行。所有截断点共用,保证文案与交互一致。 */
export function ExpandControls({ slice }: { slice: ExpandableSlice }) {
  if (!slice.truncated && !slice.expanded) return null
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {!slice.expanded && slice.truncated && (
        <>
          <span className="text-faint">已截断</span>
          <button
            type="button"
            className={CONTROL_BTN_CLS}
            onClick={(e) => {
              e.stopPropagation()
              slice.expand()
            }}
          >
            展开全部（共 {slice.totalChars.toLocaleString()} 字）
          </button>
        </>
      )}
      {slice.expanded && slice.truncated && (
        <button
          type="button"
          className={CONTROL_BTN_CLS}
          onClick={(e) => {
            e.stopPropagation()
            slice.showMore()
          }}
        >
          继续显示（还有 {slice.remaining.toLocaleString()} 字）
        </button>
      )}
      {slice.expanded && (
        <button
          type="button"
          className={CONTROL_BTN_CLS}
          onClick={(e) => {
            e.stopPropagation()
            slice.collapse()
          }}
        >
          收起
        </button>
      )}
    </div>
  )
}

/**
 * 等宽预格式化块 + 截断/展开(替代旧 ClampedPre 的"只截不展")。
 * language 提供时对内容做 highlight.js 着色(hljs 输出已转义,innerHTML 安全)。
 */
export function ExpandablePre({
  text,
  max,
  language = null,
  className,
}: {
  text: string
  max: number
  language?: string | null
  className?: string
}) {
  const full = useContext(ToolBodyFullContext)
  const slice = useExpandableSlice(stripAnsi(text), max)
  const highlight = useHighlighter(language)
  const html = highlight(slice.shown)
  let body: ReactNode
  if (html) {
    // biome-ignore lint/security/noDangerouslySetInnerHtml: hljs 输出对源码已做 HTML 转义
    body = <code dangerouslySetInnerHTML={{ __html: html }} />
  } else {
    body = slice.shown
  }
  return (
    <>
      <pre
        className={cn(
          'mt-1.5 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 font-mono text-xs leading-relaxed text-fg',
          !full && 'max-h-80',
          className,
        )}
      >
        {body}
        {slice.truncated ? '\n…' : null}
      </pre>
      <ExpandControls slice={slice} />
    </>
  )
}
