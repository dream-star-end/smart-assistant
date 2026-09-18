/**
 * 工具卡 / 详情面板共用的图标底色表(对齐设计稿 .tic.tn-*)。
 *
 * 此前 ToolCard.tsx 与 InspectorPanel.tsx 各复制一份(tools 审计 T-17):改一处 tone
 * 另一处不跟,卡片与面板的图标底色会悄悄漂移。收成单一权威,两处只 import。
 */
import type { ToolTone } from './meta'

export const TONE_TILE: Record<ToolTone, string> = {
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  info: 'bg-info-soft text-info',
  warning: 'bg-warning-soft text-warning',
  neutral: 'bg-hover text-muted',
}

/** 取 tone 对应的底色类;未知/缺省 tone 回落 accent(与旧两处 `?? "accent"` 语义一致)。 */
export function toneTileClass(tone: ToolTone | undefined): string {
  return TONE_TILE[tone ?? 'accent']
}
