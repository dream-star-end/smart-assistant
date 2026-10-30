/* 管理中心「插件」分区的组成部分 —— 从 ConnectorsTab.tsx 原样拆出（OCV5-379），行为不变。 */
import { MoreHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'
import { ApiError, apiErrorMessage } from '../../../lib/api'
import { type ConnectorConnection, connectorErrorText } from '../../../lib/connectors'
import {
  Alert,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  IconButton,
  MetaLine,
  Spinner,
  StatusDot,
  type StatusTone,
} from '../../ui'

/** 把 ApiError 的机器码映射为中文（无码/未知码走 apiErrorMessage 收口：后端中文直显、
 *  英文/技术串回退 fallback + 追踪号，绝不裸露码或英文原文）。 */
export function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.code) return connectorErrorText(e.code)
  return apiErrorMessage(e, fallback)
}

/**
 * 卡片内提示：**反馈必须渲染在发起它的那个容器里**。
 *
 * 改造前所有成功/失败都收敛到面板最顶部两个 Alert，而这是一个能滚很长的列表 ——
 * 在第 6 张卡片上切写入开关，提示渲染在滚动容器顶部，视口里什么都不会变，
 * 观感就是"点了没反应"。现在按 slug 定位到卡片内渲染；顶部 Alert 只留整表加载失败。
 * 会让当前容器消失的操作（解绑 / 卸载 / 更新后重排）走 toast，不留在原地。
 */
export type CardNotice = { slug: string; tone: 'success' | 'warning' | 'danger'; text: string }

export type UnifiedConnection = ConnectorConnection & { system: 'v1' | 'declarative' }

/**
 * 插件段的头部（第 4 轮，手机优先）：
 *   第 1 行 名称（14/600，单行截断）+ 状态（圆点 + 词）…… 右侧至多一个主动作 + 一个「⋯」；
 *   第 2 行 说明，13 muted，**最多两行**（line-clamp-2；切勿再叠 `block`，它会取消截断）；
 *   第 3 行 一行 12px 元信息（· 分隔）。
 * 更新 / 卸载这类插件级次要动作不再是一排按钮，统一收进「⋯」菜单。
 */
export function ConnectorHead({
  label,
  status,
  description,
  meta,
  action,
  menu,
}: {
  label: string
  status?: { tone: StatusTone; text: string } | null
  description: ReactNode
  meta: ReactNode[]
  /** 唯一的行内主动作（授权 / 绑定 / 添加账号）。 */
  action?: ReactNode
  /** 「⋯」菜单（OverflowMenu）。 */
  menu?: ReactNode
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex min-h-7 min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-section font-semibold leading-5 text-fg">
            {label}
          </span>
          {status && (
            <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-meta text-muted">
              <StatusDot tone={status.tone} />
              {status.text}
            </span>
          )}
        </div>
        <p data-connector-description="" className="mt-0.5 line-clamp-2 text-body text-muted">
          {description}
        </p>
        {meta.length > 0 && (
          <MetaLine className="mt-1">
            {meta.map((m, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 元信息顺序固定，无稳定 id
              <span key={i}>{m}</span>
            ))}
          </MetaLine>
        )}
      </div>
      {(action || menu) && (
        <div className="flex shrink-0 items-center gap-0.5">
          {action}
          {menu}
        </div>
      )}
    </div>
  )
}

/** 段内的一句补充（下架 / 不可授权等）：圆点 + 一句话，不画色块、不缩进。 */
export function ConnectorNote({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <p className="mt-2 flex items-start gap-2 text-meta text-muted">
      <StatusDot tone={tone} className="mt-[5px]" />
      <span>{children}</span>
    </p>
  )
}

/**
 * 安静的「⋯」菜单：插件级（更新 / 卸载）与账号级（重新登录 / 改名 / 解绑）次要动作的唯一入口。
 * `note` 渲染在菜单底部 —— 动作被拦住的原因（如「先解绑账号」）出现在用户尝试它的地方，
 * 而不是常驻在列表里的一段橙色说明。modal={false}：选中后紧接着弹出的确认框不和菜单抢指针锁。
 */
export function OverflowMenu({
  label,
  disabled,
  busy,
  note,
  preventCloseFocus,
  children,
}: {
  label: string
  disabled?: boolean
  busy?: boolean
  note?: ReactNode
  /** 选中项会把焦点交给新出现的输入框时置真（否则菜单关闭把焦点还给 ⋯，输入框立刻失焦）。 */
  preventCloseFocus?: { current: boolean }
  children: ReactNode
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <IconButton size="sm" variant="muted" aria-label={label} title={label}>
          {busy ? <Spinner size={14} /> : <MoreHorizontal size={16} strokeWidth={1.75} />}
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-w-[min(18rem,calc(100vw-2rem))]"
        onCloseAutoFocus={(event) => {
          if (preventCloseFocus?.current) {
            preventCloseFocus.current = false
            event.preventDefault()
          }
        }}
      >
        {children}
        {note && <p className="px-2.5 pb-1.5 pt-1 text-meta leading-relaxed text-muted">{note}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 一个账号的若干行（账号行 + 免逐次确认 + 自动回复入口），共享同一组发丝线。 */
export function AccountRows({ children }: { children: ReactNode }) {
  return <>{children}</>
}

/** 段落容器：段与段之间一条发丝线（首段不画）。data-connector-card 是测试定位钩子。 */
export const CONNECTOR_SECTION = 'border-t border-border py-4 first:border-t-0 first:pt-2'
