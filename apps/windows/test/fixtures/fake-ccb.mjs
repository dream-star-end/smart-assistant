#!/usr/bin/env node
/**
 * Minimal CCB CLI stand-in for Linux shadow E2E.
 * Speaks stream-json on stdio and posts /v1/messages to ANTHROPIC_BASE_URL
 * using ANTHROPIC_AUTH_TOKEN (oc-lah.*). Does not talk to Anthropic.
 */
import http from 'node:http'
import readline from 'node:readline'

const base = String(process.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '')
const token = String(process.env.ANTHROPIC_AUTH_TOKEN || '')

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

function userTextOf(msg) {
  const content = msg?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('')
  }
  return ''
}

function textFromBody(raw) {
  if (raw.includes('data:')) {
    let text = ''
    for (const line of raw.split(/\n/)) {
      const trimmed = line.replace(/^data:\s?/, '').trim()
      if (!trimmed || trimmed === '[DONE]') continue
      try {
        const json = JSON.parse(trimmed)
        const piece = json.delta?.text || json.content?.[0]?.text || json.text
        if (piece) text += piece
      } catch {
        text += trimmed
      }
    }
    return text || raw
  }
  try {
    const json = JSON.parse(raw)
    return json.content?.[0]?.text || json.result || raw
  } catch {
    return raw
  }
}

function postMessages(userText) {
  if (!base) return Promise.reject(new Error('ANTHROPIC_BASE_URL missing'))
  const url = new URL('/v1/messages', `${base}/`)
  const body = JSON.stringify({
    model: 'fake-ccb',
    max_tokens: 32,
    stream: true,
    messages: [{ role: 'user', content: userText || 'hi' }],
  })
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'content-length': String(Buffer.byteLength(body)),
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

send({ type: 'system', subtype: 'init', session_id: 'fake-ccb', cwd: process.cwd(), tools: [] })

const rl = readline.createInterface({ input: process.stdin })
for await (const line of rl) {
  if (!line.trim()) continue
  let msg
  try { msg = JSON.parse(line) } catch { continue }
  if (msg.type !== 'user') continue
  try {
    const res = await postMessages(userTextOf(msg))
    const text = textFromBody(res.body)
    send({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    })
    send({
      type: 'result',
      subtype: res.status && res.status >= 400 ? 'error' : 'success',
      is_error: Boolean(res.status && res.status >= 400),
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: text,
      session_id: 'fake-ccb',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  } catch (err) {
    send({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: err.message,
      session_id: 'fake-ccb',
    })
  }
}
