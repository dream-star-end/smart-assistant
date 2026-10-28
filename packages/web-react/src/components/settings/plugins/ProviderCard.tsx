/* 管理中心「插件」分区的组成部分 —— 从 ConnectorsTab.tsx 原样拆出（OCV5-379），行为不变。 */
import { ArrowUpCircle, Check, Pencil, Store, Trash2, X } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import {
  type ConnectorConnection,
  type DeclarativeManagementConnector,
  connectorErrorText,
  connectorNeedsRelink,
  isPublicAuthMode,
} from '../../../lib/connectors'
import {
  Alert,
  Button,
  DropdownMenuItem,
  IconButton,
  Input,
  ListGroup,
  ListRow,
  MetaLine,
  StatusDot,
  type StatusTone,
  TimeAgo,
} from '../../ui'
import {
  CONNECTOR_SECTION,
  type CardNotice,
  ConnectorHead,
  ConnectorNote,
  OverflowMenu,
  type UnifiedConnection,
} from './shared'

// ── provider 目录卡（含该 provider 的已绑多账号列表） ────────────────────────

export function ProviderCard({
  slug,
  label,
  description,
  capabilityLabel,
  connections,
  notice,
  onDismissNotice,
  onBind,
  onBindToken,
  canBind = true,
  management,
  onOpenMarketplace,
  onUpdate,
  onUninstallMarket,
  onUnbind,
  onRename,
  onRelink,
}: {
  slug: string
  label: string
  description: string
  capabilityLabel: string
  connections: UnifiedConnection[]
  /** 本卡片的就地反馈（见 CardNotice 注释）。 */
  notice: CardNotice | null
  onDismissNotice: () => void
  onBind: () => void
  onBindToken?: () => void
  canBind?: boolean
  management?: DeclarativeManagementConnector
  onOpenMarketplace?: () => void
  onUpdate?: () => Promise<void>
  onUninstallMarket?: () => Promise<void>
  onUnbind: (conn: UnifiedConnection) => Promise<void>
  onRename: (conn: ConnectorConnection, displayName: string) => void
  onRelink: (conn: UnifiedConnection) => void
}) {
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const runAction = async (key: string, action: () => Promise<void>) => {
    if (busyAction) return
    setBusyAction(key)
    try {
      await action()
    } finally {
      setBusyAction(null)
    }
  }
  const broken = connections.filter((c) => c.status === 'error').length
  // 公开接口插件（OCV5-402）：没有账号的概念，一条连接 = 已启用，不能再「添加账号」。
  const isPublic = isPublicAuthMode(management?.contract?.authMode)
  const orphanInstall = management?.installation === 'orphan'
  const unavailable = management != null && !management.available
  const meta: ReactNode[] = [capabilityLabel]
  if (management?.installation === 'default') meta.push('官方预装')
  if (management?.installation === 'marketplace' && management.installedVersion)
    meta.push(`v${management.installedVersion}`)
  if (busyAction === 'update') meta.push('正在更新…')
  else if (busyAction === 'uninstall') meta.push('正在卸载…')
  else if (management?.updateAvailable) meta.push('可更新')
  const status: { tone: StatusTone; text: string } | null = unavailable
    ? { tone: 'warning', text: '已下架' }
    : orphanInstall
      ? { tone: 'warning', text: '未安装' }
      : connections.length > 0
        ? broken > 0
          ? { tone: 'warning', text: `${broken} 个账号需重新绑定` }
          : { tone: 'success', text: isPublic ? '已启用' : `已绑定 ${connections.length} 个账号` }
        : null
  const canUpdate = Boolean(management?.updateAvailable && onUpdate)
  const canUninstall = management?.installation === 'marketplace' && onUninstallMarket != null
  const uninstallBlocked = (management?.connectionCount ?? 0) > 0
  return (
    <section data-connector-card={slug} className={CONNECTOR_SECTION}>
      {onBindToken && <Button variant="ghost" size="sm" onClick={onBindToken}>使用 GitHub 访问令牌</Button>}
      <ConnectorHead
        label={label}
        status={status}
        description={description}
        meta={meta}
        action={
          // 不可绑定的历史安装给真出路（去市场重装）；当前不可绑定则不放灰按钮，下面一句话说明。
          !canBind ? (
            orphanInstall && onOpenMarketplace ? (
              <Button variant="secondary" size="sm" onClick={onOpenMarketplace}>
                <Store size={14} strokeWidth={1.75} aria-hidden="true" /> 去市场安装
              </Button>
            ) : undefined
          ) : isPublic && connections.length > 0 ? undefined : (
            <Button variant="secondary" size="sm" onClick={onBind}>
              {isPublic ? '启用' : connections.length > 0 ? '添加账号' : '绑定'}
            </Button>
          )
        }
        menu={
          (canUpdate || canUninstall) && (
            <OverflowMenu
              label={`${label}的更多操作`}
              disabled={busyAction !== null}
              busy={busyAction !== null}
              note={canUninstall && uninstallBlocked ? '卸载前需先解绑全部账号。' : undefined}
            >
              {canUpdate && onUpdate && (
                <DropdownMenuItem onSelect={() => void runAction('update', onUpdate)}>
                  <ArrowUpCircle size={15} strokeWidth={1.75} aria-hidden="true" />
                  {`更新到 v${management?.latestVersion ?? ''}`.trim()}
                </DropdownMenuItem>
              )}
              {canUninstall && onUninstallMarket && (
                <DropdownMenuItem
                  destructive
                  disabled={uninstallBlocked}
                  onSelect={() => void runAction('uninstall', onUninstallMarket)}
                >
                  <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" /> 卸载
                </DropdownMenuItem>
              )}
            </OverflowMenu>
          )
        }
      />

      {unavailable ? (
        <ConnectorNote tone="warning">已下架或暂不可用，仅保留解绑。</ConnectorNote>
      ) : (
        !canBind &&
        !orphanInstall && (
          <ConnectorNote tone="neutral">暂不可绑定，市场恢复后即可添加账号。</ConnectorNote>
        )
      )}

      {notice && (
        <Alert tone={notice.tone} density="compact" className="mt-3" onDismiss={onDismissNotice}>
          {notice.text}
        </Alert>
      )}

      {connections.length > 0 && (
        <ListGroup aria-label={`${label}账号`} className="mt-3">
          {connections.map((c) => (
            <ConnectionRow
              key={c.id}
              conn={c}
              canRename={c.system === 'v1'}
              onUnbind={onUnbind}
              onRename={onRename}
              onRelink={() => onRelink(c)}
            />
          ))}
        </ListGroup>
      )}
    </section>
  )
}

// ── 已绑连接行（备注名行内编辑 / 状态 / RELINK 引导 / 解绑） ──────────────────

export function ConnectionRow({
  conn,
  canRename = true,
  onUnbind,
  onRename,
  onRelink,
}: {
  conn: UnifiedConnection
  /** 是否支持改名（声明式后端无 rename → 传 false 隐藏铅笔与行内编辑）。 */
  canRename?: boolean
  onUnbind: (conn: UnifiedConnection) => Promise<void>
  onRename: (conn: ConnectorConnection, displayName: string) => void
  onRelink: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(conn.displayName)
  const [unbinding, setUnbinding] = useState(false)
  const needsRelink = connectorNeedsRelink(conn)
  const hasError = conn.status === 'error'
  /** 「取消」按钮在 mousedown 阶段置真：blur 先于 click，否则失焦提交会把取消变成保存。 */
  const cancelingRef = useRef(false)
  /** 从「⋯」进入改名：菜单关闭时不把焦点还给 ⋯（否则刚出现的输入框立刻失焦提交）。 */
  const keepFocusRef = useRef(false)

  const save = () => {
    setEditing(false)
    const next = name.trim()
    if (next !== conn.displayName) onRename(conn, next)
  }

  const cancel = () => {
    cancelingRef.current = false
    setName(conn.displayName)
    setEditing(false)
  }

  return (
    <ListRow className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              aria-label="备注名"
              className="min-w-0 max-w-56"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) save()
                if (e.key === 'Escape') cancel()
              }}
              // 失焦即提交：此前点到别处编辑框还挂着，既不提交也不取消（承接 manage 审计 M-21）。
              // 点「取消」时 cancelingRef 已在 mousedown 置真，这里让路，不把取消变成保存。
              onBlur={() => {
                if (cancelingRef.current) {
                  cancel()
                  return
                }
                save()
              }}
              autoFocus
            />
            <IconButton size="sm" aria-label="保存备注名" onClick={save}>
              <Check size={14} />
            </IconButton>
            <IconButton
              size="sm"
              aria-label="取消编辑"
              onMouseDown={() => {
                cancelingRef.current = true
              }}
              onClick={cancel}
            >
              <X size={14} />
            </IconButton>
          </div>
        ) : (
          <div className="truncate text-[14px] font-medium leading-5 text-fg">
            {conn.displayName || conn.accountHint || '未命名连接'}
          </div>
        )}
        {/* 状态 = 圆点 + 词（与账号提示、绑定时间同一行元信息，· 分隔）。
            标题已在 displayName 为空时回落显示 accountHint；这里不再重复（manage 审计 M-18）。 */}
        <MetaLine className="mt-0.5">
          <span className="inline-flex items-center gap-1.5 text-muted">
            <StatusDot tone={!hasError ? 'success' : needsRelink ? 'warning' : 'danger'} />
            {!hasError ? '正常' : needsRelink ? '需要重新绑定' : '连接异常'}
          </span>
          {conn.displayName && conn.accountHint && (
            <span className="min-w-0 truncate">{conn.accountHint}</span>
          )}
          {conn.createdAt && (
            <span>
              绑定于 <TimeAgo value={conn.createdAt} format="short" tooltip={false} />
            </span>
          )}
        </MetaLine>
        {/* 具体错误是一句话而不是标签：单独成行才能换行。 */}
        {hasError && !needsRelink && (
          <p className="mt-0.5 text-meta text-danger">{connectorErrorText(conn.lastErrorCode)}</p>
        )}
        {/* 修复动作只在需要时出现，安静的文字按钮，与名称左缘对齐。 */}
        {needsRelink && (
          <Button variant="ghost" size="sm" className="-ml-3 mt-1 text-fg" onClick={onRelink}>
            重新绑定
          </Button>
        )}
      </div>
      {!editing && (
        <OverflowMenu
          label={`账号「${conn.displayName || conn.accountHint || '未命名连接'}」的更多操作`}
          disabled={unbinding}
          busy={unbinding}
          preventCloseFocus={keepFocusRef}
        >
          {canRename && (
            <DropdownMenuItem
              onSelect={() => {
                keepFocusRef.current = true
                setName(conn.displayName)
                setEditing(true)
              }}
            >
              <Pencil size={15} strokeWidth={1.75} aria-hidden="true" /> 编辑备注名
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            destructive
            onSelect={() => {
              if (unbinding) return
              setUnbinding(true)
              void onUnbind(conn).finally(() => setUnbinding(false))
            }}
          >
            <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" /> 解绑
          </DropdownMenuItem>
        </OverflowMenu>
      )}
    </ListRow>
  )
}
