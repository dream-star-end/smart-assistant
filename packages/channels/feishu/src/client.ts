/**
 * Zero-dependency Feishu Open API client backed by native `fetch`.
 */

import type { FeishuInteractiveCard } from './cards.js'

export class FeishuApiError extends Error {
  readonly status: number
  readonly apiCode?: number

  constructor(message: string, opts: { status: number; apiCode?: number }) {
    super(message)
    this.name = 'FeishuApiError'
    this.status = opts.status
    this.apiCode = opts.apiCode
  }
}

export interface FeishuOpenApiClientOptions {
  appId: string
  appSecret: string
  apiBaseUrl?: string
  fetchImpl?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

export type FeishuReceiveIdType = 'chat_id' | 'open_id' | 'user_id' | 'union_id'

export class FeishuOpenApiClient {
  private readonly appId: string
  private readonly appSecret: string
  private readonly apiBaseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly timeoutMs: number
  private cachedToken: { token: string; expiresAtMs: number } | null = null

  constructor(opts: FeishuOpenApiClientOptions) {
    this.appId = opts.appId
    this.appSecret = opts.appSecret
    this.apiBaseUrl = (opts.apiBaseUrl ?? 'https://open.feishu.cn').replace(/\/+$/, '')
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.now = opts.now ?? (() => Date.now())
    this.timeoutMs = opts.timeoutMs ?? 15_000
  }

  private async postJson<T>(
    path: string,
    body: Record<string, unknown>,
    bearerToken?: string,
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref?.()
    try {
      const res = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const raw = await res.text()
      let parsed: Record<string, unknown> = {}
      try {
        parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {
        throw new FeishuApiError(`Feishu ${path} returned non-JSON`, { status: res.status })
      }
      const code = typeof parsed.code === 'number' ? parsed.code : 0
      if (!res.ok || code !== 0) {
        throw new FeishuApiError(
          String(parsed.msg ?? `Feishu ${path} failed (HTTP ${res.status}, code ${code})`),
          { status: res.status, apiCode: code },
        )
      }
      return parsed as T
    } finally {
      clearTimeout(timer)
    }
  }

  async getTenantAccessToken(): Promise<string> {
    const nowMs = this.now()
    if (this.cachedToken && this.cachedToken.expiresAtMs - 60_000 > nowMs) {
      return this.cachedToken.token
    }
    const resp = await this.postJson<{ tenant_access_token?: string; expire?: number }>(
      '/open-apis/auth/v3/tenant_access_token/internal',
      { app_id: this.appId, app_secret: this.appSecret },
    )
    const token = resp.tenant_access_token
    if (!token) {
      throw new FeishuApiError('missing tenant_access_token in Feishu auth response', { status: 502 })
    }
    const expireSec = typeof resp.expire === 'number' && resp.expire > 0 ? resp.expire : 7200
    this.cachedToken = { token, expiresAtMs: nowMs + expireSec * 1000 }
    return token
  }

  async sendMessage(params: {
    receiveId: string
    receiveIdType?: FeishuReceiveIdType
    msgType: 'text' | 'interactive'
    content: Record<string, unknown>
  }): Promise<{ messageId?: string }> {
    const token = await this.getTenantAccessToken()
    const idType = params.receiveIdType ?? 'chat_id'
    const resp = await this.postJson<{ data?: { message_id?: string } }>(
      `/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(idType)}`,
      {
        receive_id: params.receiveId,
        msg_type: params.msgType,
        content: JSON.stringify(params.content),
      },
      token,
    )
    return { messageId: resp.data?.message_id }
  }

  sendTextMessage(
    receiveId: string,
    text: string,
    receiveIdType: FeishuReceiveIdType = 'chat_id',
  ): Promise<{ messageId?: string }> {
    return this.sendMessage({
      receiveId,
      receiveIdType,
      msgType: 'text',
      content: { text },
    })
  }

  sendInteractiveCard(
    receiveId: string,
    card: FeishuInteractiveCard,
    receiveIdType: FeishuReceiveIdType = 'chat_id',
  ): Promise<{ messageId?: string }> {
    return this.sendMessage({
      receiveId,
      receiveIdType,
      msgType: 'interactive',
      content: card as unknown as Record<string, unknown>,
    })
  }
}
