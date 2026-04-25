/**
 * M4 / P1-4 — Telegram 告警相关的纯函数单元测试。
 *
 * 覆盖:
 *  - validateTgBotToken:格式校验的 accept / reject
 *  - validateTgChatId:数字 ID、群 ID、@username 的 accept,非法拒绝
 *  - sendTelegramAlert:401/403/404 → TelegramPermanentError,
 *    其他错误 → 普通 Error,网络 abort → Error
 *
 * sendTelegramAlert 用 globalThis.fetch monkey-patch 来替代真实 HTTP。
 */

import { describe, test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { validateTgBotToken, validateTgChatId } from '../alertChannels.js'
import { sendTelegramAlert, TelegramPermanentError } from '../telegramAlertSender.js'

describe('alertChannels.validateTgBotToken', () => {
  test('accepts canonical BotFather format', () => {
    const t = validateTgBotToken('1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw')
    assert.equal(typeof t, 'string')
  })

  test('trims whitespace', () => {
    const t = validateTgBotToken('  123:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw  ')
    assert.equal(t, '123:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw')
  })

  test('rejects non-string', () => {
    assert.throws(() => validateTgBotToken(123 as unknown), RangeError)
    assert.throws(() => validateTgBotToken(null as unknown), RangeError)
    assert.throws(() => validateTgBotToken(undefined as unknown), RangeError)
  })

  test('rejects wrong format (no colon)', () => {
    assert.throws(() => validateTgBotToken('abcdefghij'), RangeError)
  })

  test('rejects too-short secret after colon', () => {
    assert.throws(() => validateTgBotToken('123:short'), RangeError)
  })

  test('rejects non-digit prefix', () => {
    assert.throws(() => validateTgBotToken('abc:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'), RangeError)
  })
})

describe('alertChannels.validateTgChatId', () => {
  test('accepts positive numeric id (private chat)', () => {
    assert.equal(validateTgChatId('123456789'), '123456789')
  })

  test('accepts negative numeric id (group)', () => {
    assert.equal(validateTgChatId('-1001234567890'), '-1001234567890')
  })

  test('accepts @username', () => {
    assert.equal(validateTgChatId('@my_channel'), '@my_channel')
  })

  test('trims whitespace', () => {
    assert.equal(validateTgChatId('  @my_channel  '), '@my_channel')
  })

  test('rejects non-string', () => {
    assert.throws(() => validateTgChatId(42 as unknown), RangeError)
  })

  test('rejects empty string', () => {
    assert.throws(() => validateTgChatId(''), RangeError)
  })

  test('rejects username without @', () => {
    assert.throws(() => validateTgChatId('my_channel'), RangeError)
  })

  test('rejects username too short', () => {
    assert.throws(() => validateTgChatId('@ab'), RangeError)
  })

  test('rejects username with hyphen (Telegram only allows [A-Za-z0-9_])', () => {
    assert.throws(() => validateTgChatId('@my-channel'), RangeError)
  })
})

describe('telegramAlertSender.sendTelegramAlert', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const input = {
    botToken: '123:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
    chatId: '-1001234567890',
    text: 'hello',
  }

  function mockFetch(status: number, body: unknown): void {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
  }

  test('resolves on 200 ok:true', async () => {
    mockFetch(200, { ok: true, result: { message_id: 42 } })
    await sendTelegramAlert(input)
  })

  test('throws TelegramPermanentError on 401 (bad token)', async () => {
    mockFetch(401, { ok: false, error_code: 401, description: 'Unauthorized' })
    await assert.rejects(
      () => sendTelegramAlert(input),
      (err: Error) => {
        assert.ok(err instanceof TelegramPermanentError, 'expected TelegramPermanentError')
        assert.match(err.message, /401/)
        return true
      },
    )
  })

  test('throws TelegramPermanentError on 403 (bot blocked)', async () => {
    mockFetch(403, {
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    })
    await assert.rejects(
      () => sendTelegramAlert(input),
      (err: Error) => {
        assert.ok(err instanceof TelegramPermanentError)
        return true
      },
    )
  })

  test('throws TelegramPermanentError on 404 (chat not found)', async () => {
    mockFetch(404, { ok: false, error_code: 404, description: 'Not Found: chat not found' })
    await assert.rejects(
      () => sendTelegramAlert(input),
      (err: Error) => {
        assert.ok(err instanceof TelegramPermanentError)
        return true
      },
    )
  })

  test("throws TelegramPermanentError on 400 'chat not found'", async () => {
    mockFetch(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' })
    await assert.rejects(
      () => sendTelegramAlert(input),
      (err: Error) => {
        assert.ok(err instanceof TelegramPermanentError, '400 chat not found must be permanent')
        return true
      },
    )
  })

  test("throws TelegramPermanentError on 400 'bot was blocked'", async () => {
    mockFetch(400, {
      ok: false,
      error_code: 400,
      description: 'Forbidden: bot was blocked by the user',
    })
    await assert.rejects(
      () => sendTelegramAlert(input),
      (err: Error) => {
        assert.ok(err instanceof TelegramPermanentError)
        return true
      },
    )
  })

  test('throws transient Error on generic 400 (not permanent desc)', async () => {
    mockFetch(400, {
      ok: false,
      error_code: 400,
      description: 'Bad Request: message text is empty',
    })
    await assert.rejects(
      () => sendTelegramAlert(input),
      (err: Error) => {
        assert.ok(!(err instanceof TelegramPermanentError), 'generic 400 must be transient')
        return true
      },
    )
  })

  test('throws transient Error on 429 rate limit', async () => {
    mockFetch(429, {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests',
      parameters: { retry_after: 30 },
    })
    await assert.rejects(
      () => sendTelegramAlert(input),
      (err: Error) => {
        assert.ok(!(err instanceof TelegramPermanentError), '429 must not be permanent')
        assert.match(err.message, /429/)
        return true
      },
    )
  })

  test('throws transient Error on 500', async () => {
    mockFetch(500, { ok: false, error_code: 500, description: 'internal error' })
    await assert.rejects(
      () => sendTelegramAlert(input),
      (err: Error) => {
        assert.ok(!(err instanceof TelegramPermanentError))
        return true
      },
    )
  })

  test('throws Error on fetch network failure', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    await assert.rejects(
      () => sendTelegramAlert(input),
      (err: Error) => {
        assert.ok(!(err instanceof TelegramPermanentError))
        assert.match(err.message, /telegram fetch failed/)
        return true
      },
    )
  })

  test('truncates text longer than 4000 chars', async () => {
    let capturedBody = ''
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body ?? '')
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    const longText = 'a'.repeat(5000)
    await sendTelegramAlert({ ...input, text: longText })
    const parsed = JSON.parse(capturedBody) as { text: string }
    assert.ok(parsed.text.length < 5000, 'text should be truncated')
    assert.match(parsed.text, /…\(truncated\)$/)
  })
})
