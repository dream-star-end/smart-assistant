/**
 * 应用连接器稳定错误码 —— 上游错误一律不透传(body/headers/URL 全吞),
 * 只映射到本表的稳定码。设计终稿 §6:详细诊断进服务端脱敏日志,响应/日志禁凭据/params/正文。
 *
 * 码是对外契约(容器 RPC 的 {kind:'error', code} 与用户 API 的 {error:{code}} 都用它),
 * 一旦发布不得随意改名;新增走追加。
 */

export type ConnectorErrorCode =
  // 入参 / 目录
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'PROVIDER_UNKNOWN'
  | 'ACTION_UNKNOWN'
  // 连接状态
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_REVOKED'
  | 'CONNECTION_ERROR'
  | 'RELINK_REQUIRED'
  | 'ACCOUNT_ALREADY_LINKED'
  // 上游(稳定映射,绝不透传原始 body)
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_AUTH_FAILED'
  | 'UPSTREAM_RATE_LIMITED'
  | 'UPSTREAM_NOT_FOUND'
  // 出站安全
  | 'OUTBOUND_BLOCKED'
  // 限额
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'SEND_DAILY_CAP'
  | 'FILE_TOO_LARGE'
  | 'RESULT_TOO_LARGE'
  // 写确认门
  | 'CONFIRMATION_NOT_FOUND'
  | 'CONFIRMATION_EXPIRED'
  | 'CONFIRMATION_NOT_APPROVED'
  | 'CONFIRMATION_IN_PROGRESS'
  | 'CONFIRMATION_ALREADY_FINALIZED'
  | 'REVISION_MISMATCH'
  // OAuth
  | 'OAUTH_STATE_MISMATCH'
  | 'OAUTH_EXCHANGE_FAILED'
  | 'OAUTH_NOT_CONFIGURED'
  // 兜底
  | 'INTERNAL'

/**
 * 连接器统一错误。`code` 是稳定对外码;`message` 只用于服务端日志/开发,
 * **绝不**把上游原文/凭据放进来。用户/容器看到的永远只有 code。
 */
export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode
  /** 对应的用户 HTTP 状态(容器 RPC 侧只用 code,不用它)。 */
  readonly httpStatus: number
  constructor(code: ConnectorErrorCode, message?: string, httpStatus?: number) {
    super(message ?? code)
    this.name = 'ConnectorError'
    this.code = code
    this.httpStatus = httpStatus ?? defaultHttpStatus(code)
  }
}

function defaultHttpStatus(code: ConnectorErrorCode): number {
  switch (code) {
    case 'BAD_REQUEST':
    case 'VALIDATION_FAILED':
    case 'OAUTH_STATE_MISMATCH':
      return 400
    case 'PROVIDER_UNKNOWN':
    case 'ACTION_UNKNOWN':
    case 'CONNECTION_NOT_FOUND':
    case 'CONFIRMATION_NOT_FOUND':
      return 404
    case 'UPSTREAM_AUTH_FAILED':
    case 'RELINK_REQUIRED':
      return 401
    case 'CONNECTION_REVOKED':
    case 'CONNECTION_ERROR':
    case 'CONFIRMATION_EXPIRED':
    case 'CONFIRMATION_NOT_APPROVED':
    case 'CONFIRMATION_ALREADY_FINALIZED':
    case 'REVISION_MISMATCH':
    case 'ACCOUNT_ALREADY_LINKED':
      return 409
    case 'CONFIRMATION_IN_PROGRESS':
      return 409
    case 'FILE_TOO_LARGE':
    case 'RESULT_TOO_LARGE':
      return 413
    case 'RATE_LIMITED':
    case 'QUOTA_EXCEEDED':
    case 'SEND_DAILY_CAP':
      return 429
    case 'OAUTH_NOT_CONFIGURED':
    case 'OUTBOUND_BLOCKED':
      return 400
    case 'UPSTREAM_RATE_LIMITED':
      return 429
    case 'UPSTREAM_NOT_FOUND':
      return 404
    case 'UPSTREAM_ERROR':
    case 'UPSTREAM_TIMEOUT':
      return 502
    default:
      return 500
  }
}

/** 把任意 throw 归一化到 ConnectorError(未知一律 INTERNAL,不泄露 message 给对端)。 */
export function toConnectorError(err: unknown): ConnectorError {
  if (err instanceof ConnectorError) return err
  const msg = err instanceof Error ? err.message : String(err)
  return new ConnectorError('INTERNAL', msg)
}
