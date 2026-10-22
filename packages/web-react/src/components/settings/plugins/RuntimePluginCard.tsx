/* 管理中心「插件」分区的组成部分 —— 从 ConnectorsTab.tsx 原样拆出（OCV5-379），行为不变。 */
import { ArrowUpCircle, ChevronRight, KeyRound, QrCode, RotateCw, Trash2, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { api } from '../../../lib/api'
import type { RuntimePluginAccount, RuntimePluginCatalogEntry } from '../../../lib/connectors'
import { managedPluginProvider } from '../../../lib/managedPluginProviders'
import { pluginAccountState } from '../../../lib/pluginDirectory'
import type { AuthSession } from '../../../lib/types'
import {
  Alert,
  Button,
  DropdownMenuItem,
  IconButton,
  ListGroup,
  ListRow,
  MetaLine,
  Modal,
  Sheet,
  StatusDot,
  type StatusTone,
  Switch,
} from '../../ui'
import { KnowledgePlanetAutomationPanel } from '../KnowledgePlanetAutomationPanel'
import {
  AccountRows,
  CONNECTOR_SECTION,
  type CardNotice,
  ConnectorHead,
  ConnectorNote,
  OverflowMenu,
  errText,
} from './shared'

export function RuntimePluginCard({
  auth,
  plugin,
  accounts,
  notice,
  onDismissNotice,
  onAuthorize,
  onUpdate,
  onUninstall,
  onRevoke,
  onReauthorize,
  onWriteAccessChanged,
  onWriteAccessError,
  onWritePreapprovalChanged,
  onWritePreapprovalError,
}: {
  auth: AuthSession
  plugin: RuntimePluginCatalogEntry
  accounts: RuntimePluginAccount[]
  /** 本卡片的就地反馈（成功/失败都渲染在这里，不再飞到面板顶部）。 */
  notice: CardNotice | null
  onDismissNotice: () => void
  onAuthorize: () => void
  onUpdate: () => Promise<void>
  onUninstall: () => Promise<void>
  onRevoke: (account: RuntimePluginAccount) => Promise<void>
  onReauthorize: (account: RuntimePluginAccount) => Promise<void>
  onWriteAccessChanged: (enabled: boolean) => void
  onWriteAccessError: (error: unknown) => void
  onWritePreapprovalChanged: (enabled: boolean) => void
  onWritePreapprovalError: (error: unknown) => void
}) {
  const literature = plugin.slug === 'literature-db'
  const qrProvider = managedPluginProvider(plugin.slug)
  const canSelfAuthorize =
    ['knowledge-planet', 'weibo', 'zhihu', 'bili-account', 'literature-db'].includes(plugin.slug) &&
    plugin.installedCurrent
  const authorizeLabel = literature ? '连接文献数据库' : qrProvider.authorizeLabel
  const writeCount = plugin.actions.filter((action) => !action.readOnly).length
  const [consentAccount, setConsentAccount] = useState<RuntimePluginAccount | null>(null)
  const [consentChecked, setConsentChecked] = useState(false)
  const [consentError, setConsentError] = useState<string | null>(null)
  const [preapprovalAccount, setPreapprovalAccount] = useState<RuntimePluginAccount | null>(null)
  const [preapprovalChecked, setPreapprovalChecked] = useState(false)
  const [preapprovalError, setPreapprovalError] = useState<string | null>(null)
  const [writeBusyId, setWriteBusyId] = useState<string | null>(null)
  /** 卡片级异步动作的忙态键（`update` / `uninstall` / `revoke:<id>` / `reauth:<id>`）。 */
  const [busyAction, setBusyAction] = useState<string | null>(null)
  /** 自动回复配置面板（从账号行里外提，见下方 Sheet）。 */
  const [automationAccount, setAutomationAccount] = useState<RuntimePluginAccount | null>(null)

  const runAction = async (key: string, action: () => Promise<void>) => {
    if (busyAction) return
    setBusyAction(key)
    try {
      await action()
    } finally {
      setBusyAction(null)
    }
  }

  const accountStates = accounts.map((account) => pluginAccountState(account, plugin))
  const brokenCount = accountStates.filter((state) => state.tone !== 'success').length
  /** 账号存在时更新/卸载会被后端拒（登录状态与新版本不匹配），把原因写成可见文字而非 title。 */
  const blockedByAccounts = accounts.length > 0

  const disableWrite = async (account: RuntimePluginAccount) => {
    if (writeBusyId) return
    setWriteBusyId(account.id)
    try {
      await api.setPluginWriteAccess(auth, account.id, { enabled: false })
      onWriteAccessChanged(false)
    } catch (error) {
      onWriteAccessError(error)
    } finally {
      setWriteBusyId(null)
    }
  }

  const enableWrite = async () => {
    const account = consentAccount
    const control = account?.writeControl
    if (!account || !control || !consentChecked || writeBusyId) return
    setConsentError(null)
    setWriteBusyId(account.id)
    try {
      await api.setPluginWriteAccess(auth, account.id, {
        enabled: true,
        accepted: true,
        disclaimerVersion: control.disclaimerVersion,
      })
      setConsentAccount(null)
      setConsentChecked(false)
      setConsentError(null)
      onWriteAccessChanged(true)
    } catch (error) {
      setConsentError(errText(error, '开启插件写入能力失败'))
      onWriteAccessError(error)
    } finally {
      setWriteBusyId(null)
    }
  }

  const disablePreapproval = async (account: RuntimePluginAccount) => {
    if (writeBusyId) return
    setWriteBusyId(account.id)
    try {
      await api.setPluginWritePreapproval(auth, account.id, { enabled: false })
      onWritePreapprovalChanged(false)
    } catch (error) {
      onWritePreapprovalError(error)
    } finally {
      setWriteBusyId(null)
    }
  }

  const enablePreapproval = async () => {
    const account = preapprovalAccount
    const preapproval = account?.writeControl?.preapproval
    if (
      !account ||
      !preapproval ||
      preapproval.disclaimerVersion === null ||
      !preapprovalChecked ||
      writeBusyId
    )
      return
    setPreapprovalError(null)
    setWriteBusyId(account.id)
    try {
      await api.setPluginWritePreapproval(auth, account.id, {
        enabled: true,
        accepted: true,
        disclaimerVersion: preapproval.disclaimerVersion,
      })
      setPreapprovalAccount(null)
      setPreapprovalChecked(false)
      onWritePreapprovalChanged(true)
    } catch (error) {
      setPreapprovalError(errText(error, '开启插件免逐次确认失败'))
      onWritePreapprovalError(error)
    } finally {
      setWriteBusyId(null)
    }
  }
  const reloginLabel = literature
    ? '重新登录'
    : qrProvider.qrRelink
      ? '重新扫码登录'
      : '重新扫码授权'
  const meta: ReactNode[] = [writeCount > 0 ? '可读写' : '只读']
  if (plugin.installed && plugin.installedVersion) meta.push(`v${plugin.installedVersion}`)
  if (plugin.pluginType === 'managed-browser') meta.push('隔离运行')
  if (plugin.accountMode === 'none') meta.push('无需账号')
  if (busyAction === 'update') meta.push(plugin.installed ? '正在更新…' : '正在重新安装…')
  else if (busyAction === 'uninstall') meta.push('正在卸载…')
  else if (plugin.updateAvailable) meta.push(plugin.installed ? '可更新' : '可重新安装')
  const status: { tone: StatusTone; text: string } | null = !plugin.available
    ? { tone: 'warning', text: '已下架' }
    : !plugin.installed
      ? { tone: 'warning', text: '未安装' }
      : accounts.length > 0
        ? brokenCount > 0
          ? { tone: 'warning', text: `${brokenCount} 个账号待处理` }
          : { tone: 'success', text: '已授权' }
        : null
  const needsAuthorize =
    plugin.accountMode === 'required' && accounts.length === 0 && plugin.installedCurrent
  const hasPluginMenu = plugin.updateAvailable || plugin.installed
  return (
    <section data-connector-card={plugin.slug} className={CONNECTOR_SECTION}>
      <ConnectorHead
        label={plugin.label}
        status={status}
        description={plugin.description}
        meta={meta}
        action={
          needsAuthorize &&
          canSelfAuthorize && (
            <Button variant="secondary" size="sm" onClick={onAuthorize}>
              {literature ? (
                <KeyRound size={14} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <QrCode size={14} strokeWidth={1.75} aria-hidden="true" />
              )}{' '}
              {authorizeLabel}
            </Button>
          )
        }
        menu={
          hasPluginMenu && (
            <OverflowMenu
              label={`${plugin.label}的更多操作`}
              disabled={busyAction !== null}
              busy={busyAction === 'update' || busyAction === 'uninstall'}
              note={
                // 拦截原因出现在用户尝试更新 / 卸载的地方（菜单内），不再是常驻的橙色段落。
                blockedByAccounts
                  ? '更新或卸载前需先解绑全部账号：已保存的登录状态与新版本不通用。'
                  : undefined
              }
            >
              {plugin.updateAvailable && (
                <DropdownMenuItem
                  disabled={blockedByAccounts}
                  onSelect={() => void runAction('update', onUpdate)}
                >
                  <ArrowUpCircle size={15} strokeWidth={1.75} aria-hidden="true" />
                  {plugin.installed ? `更新到 v${plugin.latestVersion ?? ''}`.trim() : '重新安装'}
                </DropdownMenuItem>
              )}
              {plugin.installed && (
                <DropdownMenuItem
                  destructive
                  disabled={blockedByAccounts}
                  onSelect={() => void runAction('uninstall', onUninstall)}
                >
                  <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" /> 卸载
                </DropdownMenuItem>
              )}
            </OverflowMenu>
          )
        }
      />
      {!plugin.available && (
        <ConnectorNote tone="warning">已下架或暂不可用，仅保留解绑与卸载。</ConnectorNote>
      )}
      {needsAuthorize && !canSelfAuthorize && (
        <ConnectorNote tone="neutral">暂不支持在这里授权，可在对话中让助手引导绑定。</ConnectorNote>
      )}
      {notice && (
        <Alert tone={notice.tone} density="compact" className="mt-3" onDismiss={onDismissNotice}>
          {notice.text}
        </Alert>
      )}
      {accounts.length > 0 && (
        <ListGroup aria-label={`${plugin.label}账号`} className="mt-3">
          {accounts.map((account, index) => {
            const accountState = accountStates[index] ?? pluginAccountState(account, plugin)
            const accountName = account.displayName || plugin.label
            const writePolicyStale =
              account.writeControl !== null &&
              account.writeControl.acceptedVersion !== null &&
              account.writeControl.acceptedVersion !== account.writeControl.disclaimerVersion
            const preapprovalPolicyStale =
              account.writeControl?.preapproval?.acceptedVersion !== null &&
              account.writeControl?.preapproval?.acceptedVersion !== undefined &&
              account.writeControl.preapproval.disclaimerVersion !== null &&
              account.writeControl.preapproval.acceptedVersion !==
                account.writeControl.preapproval.disclaimerVersion
            // 修复动作只在需要时出现在行面上；健康账号的「重新登录」收进「⋯」。
            const fixInline = canSelfAuthorize && accountState.needsReauth
            const reloginInMenu =
              canSelfAuthorize && !accountState.needsReauth && (literature || qrProvider.qrRelink)
            const accountBusy =
              busyAction === `reauth:${account.id}` || busyAction === `revoke:${account.id}`
            return (
              <AccountRows key={account.id}>
                <ListRow data-plugin-account={account.id} className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium leading-5 text-fg">
                      {accountName}
                    </div>
                    {/* 颜色与文案同源（pluginAccountState），不再出现"绿色的需重新授权"。 */}
                    <MetaLine className="mt-0.5">
                      <span className="inline-flex items-center gap-1.5 text-muted">
                        <StatusDot tone={accountState.tone} />
                        {accountState.label}
                      </span>
                      {account.accountHint && (
                        <span className="min-w-0 truncate">{account.accountHint}</span>
                      )}
                    </MetaLine>
                    {writePolicyStale && (
                      <p className="mt-0.5 text-meta text-warning">写入条款已更新，需重新同意</p>
                    )}
                    {fixInline && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-ml-3 mt-1 text-fg"
                        onClick={() =>
                          void runAction(`reauth:${account.id}`, () => onReauthorize(account))
                        }
                        loading={busyAction === `reauth:${account.id}`}
                        disabled={busyAction !== null}
                      >
                        {literature ? (
                          <KeyRound size={14} strokeWidth={1.75} aria-hidden="true" />
                        ) : (
                          <QrCode size={14} strokeWidth={1.75} aria-hidden="true" />
                        )}
                        {reloginLabel}
                      </Button>
                    )}
                  </div>
                  {account.writeControl && (
                    <div className="flex shrink-0 items-center gap-2">
                      <span aria-hidden="true" className="text-meta text-muted">
                        写入
                      </span>
                      <Switch
                        aria-label={`${accountName}写入能力`}
                        checked={account.writeControl.enabled}
                        disabled={!account.executable || writeBusyId === account.id}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setConsentChecked(false)
                            setConsentError(null)
                            setConsentAccount(account)
                          } else {
                            void disableWrite(account)
                          }
                        }}
                      />
                    </div>
                  )}
                  <OverflowMenu
                    label={`账号「${accountName}」的更多操作`}
                    disabled={busyAction !== null}
                    busy={accountBusy && !fixInline}
                  >
                    {reloginInMenu && (
                      <DropdownMenuItem
                        onSelect={() =>
                          void runAction(`reauth:${account.id}`, () => onReauthorize(account))
                        }
                      >
                        <RotateCw size={15} strokeWidth={1.75} aria-hidden="true" /> {reloginLabel}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      destructive
                      onSelect={() =>
                        void runAction(`revoke:${account.id}`, () => onRevoke(account))
                      }
                    >
                      <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" /> 解绑
                    </DropdownMenuItem>
                  </OverflowMenu>
                </ListRow>
                {account.writeControl?.preapproval?.available && (
                  <ListRow className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] leading-5 text-fg">免逐次确认</div>
                      <div
                        className={`mt-0.5 text-meta ${
                          preapprovalPolicyStale ? 'text-warning' : 'text-faint'
                        }`}
                      >
                        {preapprovalPolicyStale
                          ? '免确认条款已更新，需重新同意后才会生效。'
                          : account.writeControl.preapproval.enabled
                            ? '已生效：Agent 直接执行写入，不展示确认卡。'
                            : '开启后，Agent 直接执行写入，不展示确认卡；默认关闭。'}
                      </div>
                    </div>
                    <Switch
                      aria-label={`${accountName}免逐次确认`}
                      checked={account.writeControl.preapproval.enabled}
                      disabled={
                        !account.executable ||
                        !account.writeControl.enabled ||
                        writeBusyId === account.id
                      }
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setPreapprovalChecked(false)
                          setPreapprovalError(null)
                          setPreapprovalAccount(account)
                        } else {
                          void disablePreapproval(account)
                        }
                      }}
                    />
                  </ListRow>
                )}
                {/* 自动回复外提：账号下只留一行入口，规则子系统去 Sheet 里展开。 */}
                {plugin.slug === 'knowledge-planet' && account.status === 'active' && (
                  <ListRow className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] leading-5 text-fg">无人值守自动回复</div>
                      <div className="mt-0.5 line-clamp-2 text-meta text-faint">
                        按规则自动回复新主题与提问；默认关闭，需单独同意。
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="-mr-2 shrink-0 text-muted"
                      onClick={() => setAutomationAccount(account)}
                    >
                      配置
                      <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
                    </Button>
                  </ListRow>
                )}
              </AccountRows>
            )
          })}
        </ListGroup>
      )}
      <Modal
        open={consentAccount != null}
        onOpenChange={(open) => {
          if (!open && !writeBusyId) {
            setConsentAccount(null)
            setConsentChecked(false)
            setConsentError(null)
          }
        }}
        title={`开启${plugin.label}写入能力`}
        description={`写入动作默认仍需你在对话中逐次确认；免逐次确认${plugin.slug === 'knowledge-planet' ? '和无人值守回复' : ''}需另行授权。`}
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={writeBusyId != null}
              onClick={() => {
                setConsentAccount(null)
                setConsentChecked(false)
                setConsentError(null)
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={writeBusyId != null}
              disabled={!consentChecked}
              onClick={() => void enableWrite()}
            >
              同意并开启
            </Button>
          </>
        }
      >
        {consentAccount?.writeControl && (
          <div className="flex flex-col gap-3">
            {/* 失败提示留在弹层内 —— 渲染到面板顶部会被这层遮罩整个盖住。 */}
            {consentError && (
              <Alert tone="danger" density="compact">
                {consentError}
              </Alert>
            )}
            <Alert tone="warning" density="compact" className="leading-relaxed">
              {consentAccount.writeControl.disclaimerText}
            </Alert>
            <label className="flex min-h-11 cursor-pointer items-start gap-2.5 py-1 text-body leading-relaxed text-fg">
              <input
                type="checkbox"
                className="mt-[3px] size-4 shrink-0 accent-accent"
                checked={consentChecked}
                onChange={(event) => setConsentChecked(event.target.checked)}
              />
              <span>我已阅读并理解上述风险与责任，并同意开启写入能力。</span>
            </label>
          </div>
        )}
      </Modal>
      <Modal
        open={preapprovalAccount != null}
        onOpenChange={(open) => {
          if (!open && !writeBusyId) {
            setPreapprovalAccount(null)
            setPreapprovalChecked(false)
            setPreapprovalError(null)
          }
        }}
        title="开启免逐次确认"
        description={`这是独立的账号级高风险授权。开启后，所有可使用此账号的 Agent 都可直接执行${plugin.label}写入，不再展示逐次确认卡。`}
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={writeBusyId != null}
              onClick={() => {
                setPreapprovalAccount(null)
                setPreapprovalChecked(false)
                setPreapprovalError(null)
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={writeBusyId != null}
              disabled={!preapprovalChecked}
              onClick={() => void enablePreapproval()}
            >
              同意并开启
            </Button>
          </>
        }
      >
        {preapprovalAccount?.writeControl?.preapproval && (
          <div className="flex flex-col gap-3">
            {preapprovalError && (
              <Alert tone="danger" density="compact">
                {preapprovalError}
              </Alert>
            )}
            <Alert tone="warning" density="compact" className="leading-relaxed">
              {preapprovalAccount.writeControl.preapproval.disclaimerText}
            </Alert>
            <label className="flex min-h-11 cursor-pointer items-start gap-2.5 py-1 text-body leading-relaxed text-fg">
              <input
                type="checkbox"
                className="mt-[3px] size-4 shrink-0 accent-accent"
                checked={preapprovalChecked}
                onChange={(event) => setPreapprovalChecked(event.target.checked)}
              />
              <span>我已阅读并理解上述风险与责任，并明确同意当前账号免逐次确认。</span>
            </label>
          </div>
        )}
      </Modal>
      {/*
        自动回复配置面板：从账号 <li> 里外提到贴底抽屉。
        原来的层级是 管理中心 → 插件账号 Tab → 插件卡片 → 账号行 → 自动回复子系统，
        四层缩进里还塞着规则列表、免责声明、运行记录与多个弹层；现在它有了自己的标题与呼吸空间。
      */}
      <Sheet
        open={automationAccount != null}
        onOpenChange={(open) => {
          if (!open) setAutomationAccount(null)
        }}
        side="bottom"
        srTitle={`${plugin.label}自动回复设置`}
      >
        <div className="flex items-start justify-between gap-3 px-4 pb-2 pt-3">
          <div className="min-w-0">
            <h3 className="text-title font-semibold text-fg">{plugin.label}自动回复设置</h3>
            <p className="mt-0.5 truncate text-caption text-muted">
              账号：
              {automationAccount?.displayName || automationAccount?.accountHint || plugin.label}
            </p>
          </div>
          <IconButton
            aria-label="关闭自动回复设置"
            size="sm"
            onClick={() => setAutomationAccount(null)}
          >
            <X size={16} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {automationAccount && (
            <KnowledgePlanetAutomationPanel auth={auth} account={automationAccount} />
          )}
        </div>
      </Sheet>
    </section>
  )
}
