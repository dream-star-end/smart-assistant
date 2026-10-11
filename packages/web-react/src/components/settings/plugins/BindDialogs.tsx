/* 管理中心「插件」分区的组成部分 —— 从 ConnectorsTab.tsx 原样拆出（OCV5-379），行为不变。 */
import { ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../../lib/api'
import {
  type ConnectorFormField,
  type ConnectorProvider,
  type DeclarativeCatalogEntry,
  bindFieldMeta,
  isOauthAuthMode,
} from '../../../lib/connectors'
import type { AuthSession } from '../../../lib/types'
import { Alert, Button, Field, Input, Modal } from '../../ui'
import { errText } from './shared'

/** oauth2_byoa provider 未下发 formFields 时的兜底字段（契约 body 键 clientId/clientSecret）。 */
export const DEFAULT_OAUTH_FIELDS: ConnectorFormField[] = [
  { key: 'clientId', label: 'Client ID', type: 'text', required: true },
  { key: 'clientSecret', label: 'Client Secret', type: 'password', required: true },
]

// ── 绑定弹层（formFields 驱动；token/basic 直落库，BYOA OAuth 整页跳授权） ────

export function BindDialog({
  auth,
  provider,
  onClose,
  onBound,
}: {
  auth: AuthSession
  provider: ConnectorProvider | null
  onClose: () => void
  onBound: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [displayName, setDisplayName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // 换 provider / 重开弹层 → 重置表单瞬态（凭据绝不跨 provider 残留）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: provider?.id 是重置触发键，不是读取的值
  useEffect(() => {
    setValues({})
    setDisplayName('')
    setErr(null)
    setSubmitting(false)
  }, [provider?.id])

  const isOauth = provider?.authKind === 'oauth2_byoa'
  const fields: ConnectorFormField[] =
    provider == null
      ? []
      : provider.formFields.length > 0
        ? provider.formFields
        : isOauth
          ? DEFAULT_OAUTH_FIELDS
          : []

  const missingRequired = fields.some((f) => f.required && !(values[f.key] ?? '').trim())
  /** 顶部引导（helpText/helpUrl，如「如何获取 QQ 邮箱授权码」）。 */
  const helps = fields.filter((f) => f.helpText || f.helpUrl)

  const submit = async () => {
    if (!provider || submitting || missingRequired) return
    setSubmitting(true)
    setErr(null)
    const trimmed: Record<string, string> = {}
    for (const f of fields) {
      const v = (values[f.key] ?? '').trim()
      if (v) trimmed[f.key] = v
    }
    const dn = displayName.trim() || undefined
    try {
      if (isOauth) {
        const r = await api.startConnectorOAuth(auth, provider.id, {
          clientId: trimmed.clientId ?? '',
          clientSecret: trimmed.clientSecret ?? '',
          displayName: dn,
        })
        // 整页跳转授权页；回跳 /?connector_linked=<provider> 由 App 层 toast。
        window.location.href = r.authorizeUrl
        return // 跳转中，不再触发本地状态更新
      }
      await api.bindConnector(auth, provider.id, { fields: trimmed, displayName: dn })
      onBound()
    } catch (e) {
      setErr(errText(e, '绑定失败，请重试'))
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={provider != null}
      onOpenChange={(o) => !o && onClose()}
      title={provider ? `绑定 ${provider.label}` : undefined}
      description={
        isOauth
          ? '填写你的自建应用凭据，前往授权后即可完成绑定。'
          : '凭据仅用于服务端加密存储，不会进入对话。'
      }
      footer={
        provider && (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={submitting}
              disabled={missingRequired}
              onClick={() => void submit()}
            >
              {isOauth ? '前往授权' : '绑定'}
            </Button>
          </>
        )
      }
    >
      {provider && (
        <div className="flex flex-col gap-3">
          {helps.length > 0 && (
            <div className="rounded-lg bg-hover px-3 py-2.5">
              {helps.map((f) => (
                <div key={f.key} className="text-meta leading-relaxed text-muted">
                  {f.helpText}
                  {f.helpUrl && (
                    <a
                      href={f.helpUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="ml-1 inline-flex items-center gap-0.5 text-accent hover:underline"
                    >
                      查看指引
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 提交失败就地渲染在弹层内 —— 面板顶部的 Alert 会被这层遮罩整个盖住。 */}
          {err && (
            <Alert tone="danger" density="compact">
              {err}
            </Alert>
          )}

          {fields.map((f) => (
            <Field key={f.key} label={f.label} required={f.required}>
              <Input
                type={f.type === 'password' ? 'password' : f.type === 'url' ? 'url' : 'text'}
                value={values[f.key] ?? ''}
                placeholder={f.placeholder}
                autoComplete="off"
                onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            </Field>
          ))}

          <Field label="备注名（可选）">
            <Input
              value={displayName}
              maxLength={64}
              placeholder="如：工作邮箱"
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </Field>
        </div>
      )}
    </Modal>
  )
}

// ── 声明式绑定弹层（requiredBindSources 驱动；直填落库 / oauth2 整页跳授权） ───

/**
 * 声明式连接器绑定弹层：表单字段由 entry.requiredBindSources 驱动，每个 source 经
 * bindFieldMeta 取 label/输入类型（未知 source 回退密码框）。全部必填，另有可选备注名。
 * 凭据仅用于服务端加密存储，绝不进入对话或容器。
 *
 * 按 authMode 分两条提交路径（判定收口于 isOauthAuthMode，禁散写字符串比较）：
 *   - **oauth2-auth-code**：字段即用户 BYOA 自建应用的 client_id/client_secret →
 *     api.startDeclarativeOauth → 整页跳转授权页（后端回跳 /?connector_linked=<slug>
 *     由 App 层 toast）。此模式走直填 bind 会被后端硬拒，故必须走这条。
 *   - 其余（static-token / token-exchange…）：api.bindDeclarativeConnector 直填落库
 *     （secrets 键 = source 名）。
 */
export function DeclarativeBindDialog({
  auth,
  entry,
  onClose,
  onBound,
}: {
  auth: AuthSession
  entry: DeclarativeCatalogEntry | null
  onClose: () => void
  onBound: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [displayName, setDisplayName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // 换插件 / 重开弹层 → 重置表单瞬态（凭据绝不跨插件残留）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: entry?.versionId 是重置触发键，不是读取的值
  useEffect(() => {
    setValues({})
    setDisplayName('')
    setErr(null)
    setSubmitting(false)
  }, [entry?.versionId])

  const isOauth = entry != null && isOauthAuthMode(entry.authMode)
  // 平台已注册 OAuth App → 用户零填写，一键授权（读后端显式字段，不从空数组反推）。
  const isPlatformOauth = isOauth && entry.clientProvisioning === 'platform'
  const sources = entry?.requiredBindSources ?? []
  const missingRequired = sources.some((s) => !(values[s] ?? '').trim())

  const submit = async () => {
    if (!entry || submitting || missingRequired) return
    setSubmitting(true)
    setErr(null)
    const secrets: Record<string, string> = {}
    for (const s of sources) {
      const v = (values[s] ?? '').trim()
      if (v) secrets[s] = v
    }
    const dn = displayName.trim() || undefined
    try {
      if (isOauth) {
        // 键 = 后端下发的 source 名（client_id / client_secret），非 camelCase。
        const r = await api.startDeclarativeOauth(auth, {
          versionId: entry.versionId,
          clientId: secrets.client_id ?? '',
          clientSecret: secrets.client_secret ?? '',
          displayName: dn,
        })
        // 整页跳转授权页；回跳 /?connector_linked=<slug> 由 App 层 toast。
        window.location.href = r.authorizeUrl
        return // 跳转中，不再触发本地状态更新
      }
      await api.bindDeclarativeConnector(auth, {
        versionId: entry.versionId,
        secrets,
        displayName: dn,
      })
      onBound()
    } catch (e) {
      setErr(errText(e, isOauth ? '发起授权失败，请重试' : '绑定失败，请重试'))
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={entry != null}
      onOpenChange={(o) => !o && onClose()}
      title={entry ? `绑定 ${entry.label}` : undefined}
      description={
        isPlatformOauth
          ? '无需填写任何凭据，点击前往授权即可完成绑定。'
          : isOauth
            ? '填写你的自建应用凭据，前往授权后即可完成绑定。'
            : '凭据仅用于服务端加密存储，绝不会进入对话或容器。'
      }
      footer={
        entry && (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={submitting}
              disabled={missingRequired}
              onClick={() => void submit()}
            >
              {isOauth ? '前往授权' : '绑定'}
            </Button>
          </>
        )
      }
    >
      {entry && (
        <div className="flex flex-col gap-3">
          {err && (
            <Alert tone="danger" density="compact">
              {err}
            </Alert>
          )}

          {sources.map((s) => {
            const meta = bindFieldMeta(s)
            return (
              <Field key={s} label={meta.label} required>
                <Input
                  type={meta.type === 'password' ? 'password' : 'text'}
                  value={values[s] ?? ''}
                  placeholder={meta.placeholder}
                  autoComplete="off"
                  onChange={(e) => setValues((prev) => ({ ...prev, [s]: e.target.value }))}
                />
              </Field>
            )
          })}

          <Field label="备注名（可选）">
            <Input
              value={displayName}
              maxLength={64}
              placeholder="如：工作账号"
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </Field>
        </div>
      )}
    </Modal>
  )
}
