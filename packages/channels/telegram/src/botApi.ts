/**
 * Zero-dependency Telegram Bot API client backed by native `fetch`.
 */

export interface TelegramInlineKeyboardButton {
  text: string
  callback_data?: string
  url?: string
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][]
}

export interface TelegramUser {
  id: number
  is_bot?: boolean
  first_name?: string
  username?: string
}

export interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  date?: number
  text?: string
}

export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  message?: TelegramMessage
  data?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

export class TelegramApiError extends Error {
  readonly status: number
  readonly errorCode?: number
  readonly description?: string

  constructor(message: string, opts: { status: number; errorCode?: number; description?: string }) {
    super(message)
    this.name = 'TelegramApiError'
    this.status = opts.status
    this.errorCode = opts.errorCode
    this.description = opts.description
  }
}

export interface TelegramBotApiOptions {
  botToken: string
  apiBaseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class TelegramBotApi {
  private readonly apiRoot: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: TelegramBotApiOptions) {
    const token = opts.botToken?.trim()
    if (!token) throw new Error('TelegramBotApi requires a non-empty botToken')
    const base = (opts.apiBaseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '')
    this.apiRoot = `${base}/bot${token}`
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.timeoutMs = opts.timeoutMs ?? 15_000
  }

  async call<T = unknown>(method: string, payload?: Record<string, unknown>): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref?.()
    try {
      const res = await this.fetchImpl(`${this.apiRoot}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload ? JSON.stringify(payload) : '{}',
        signal: controller.signal,
      })
      const rawText = await res.text()
      let parsed: { ok?: boolean; result?: T; error_code?: number; description?: string } = {}
      try {
        parsed = rawText ? JSON.parse(rawText) : {}
      } catch {
        throw new TelegramApiError(`Telegram ${method} returned non-JSON response`, {
          status: res.status,
        })
      }
      if (!res.ok || parsed.ok !== true) {
        throw new TelegramApiError(
          parsed.description || `Telegram ${method} failed with HTTP ${res.status}`,
          {
            status: res.status,
            errorCode: parsed.error_code,
            description: parsed.description,
          },
        )
      }
      return parsed.result as T
    } finally {
      clearTimeout(timer)
    }
  }

  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe')
  }

  sendMessage(params: {
    chat_id: string | number
    text: string
    reply_markup?: TelegramInlineKeyboardMarkup
    reply_to_message_id?: number
    disable_notification?: boolean
  }): Promise<TelegramMessage> {
    return this.call<TelegramMessage>('sendMessage', params)
  }

  answerCallbackQuery(params: {
    callback_query_id: string
    text?: string
    show_alert?: boolean
  }): Promise<boolean> {
    return this.call<boolean>('answerCallbackQuery', params)
  }

  editMessageText(params: {
    chat_id: string | number
    message_id: number
    text: string
    reply_markup?: TelegramInlineKeyboardMarkup
  }): Promise<TelegramMessage | boolean> {
    return this.call<TelegramMessage | boolean>('editMessageText', params)
  }

  setWebhook(params: {
    url: string
    secret_token?: string
    drop_pending_updates?: boolean
    allowed_updates?: string[]
  }): Promise<boolean> {
    return this.call<boolean>('setWebhook', params)
  }

  deleteWebhook(params?: { drop_pending_updates?: boolean }): Promise<boolean> {
    return this.call<boolean>('deleteWebhook', params ?? {})
  }

  getUpdates(params?: {
    offset?: number
    limit?: number
    timeout?: number
    allowed_updates?: string[]
  }): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>('getUpdates', params ?? {})
  }
}
