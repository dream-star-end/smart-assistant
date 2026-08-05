#!/usr/bin/env node

import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 19080
const DEFAULT_UPSTREAM = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/responses'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const SAFE_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'openai-beta',
  'user-agent',
  'x-codex-turn-state',
  'x-openai-internal-codex-responses-lite',
])

function appendHeader(headers, key, value) {
  if (value === undefined) return
  if (Array.isArray(value)) {
    for (const item of value) headers.append(key, item)
    return
  }
  headers.set(key, value)
}

function buildUpstreamHeaders(req, apiKey) {
  const headers = new Headers()
  for (const [rawKey, value] of Object.entries(req.headers)) {
    const key = rawKey.toLowerCase()
    if (HOP_BY_HOP.has(key) || key === 'host' || key === 'content-length' || key === 'authorization') continue
    if (!SAFE_REQUEST_HEADERS.has(key)) continue
    appendHeader(headers, rawKey, value)
  }
  headers.set('authorization', `Bearer ${apiKey.toString('utf8')}`)
  headers.set('accept-encoding', 'identity')
  return headers
}

function copyResponseHeaders(from, res) {
  from.forEach((value, rawKey) => {
    const key = rawKey.toLowerCase()
    if (HOP_BY_HOP.has(key) || key === 'content-length') return
    res.setHeader(rawKey, value)
  })
}

function bearerMatches(value, apiKey) {
  if (typeof value !== 'string') return false
  const actual = Buffer.from(value, 'utf8')
  const expected = Buffer.concat([Buffer.from('Bearer ', 'utf8'), apiKey])
  try {
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } finally {
    actual.fill(0)
    expected.fill(0)
  }
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

export function createQwenChinaRelayServer({
  apiKey,
  upstreamUrl = DEFAULT_UPSTREAM,
  fetchImpl = fetch,
  log = (event) => console.log(JSON.stringify(event)),
}) {
  if (!Buffer.isBuffer(apiKey) || apiKey.length === 0) throw new Error('apiKey must be a non-empty Buffer')
  const key = Buffer.from(apiKey)
  const upstream = new URL(upstreamUrl)
  if (upstream.protocol !== 'https:' && upstream.hostname !== '127.0.0.1') {
    key.fill(0)
    throw new Error('upstream must use HTTPS')
  }

  const server = createServer(async (req, res) => {
    let parsed
    try {
      parsed = new URL(req.url ?? '/', 'http://relay')
    } catch {
      sendJson(res, 400, { error: { code: 'BAD_URL', message: 'malformed request URL' } })
      return
    }

    if (req.method === 'GET' && parsed.pathname === '/healthz') {
      sendJson(res, 200, { ok: true, role: 'qwen-china-relay' })
      return
    }
    if (req.method !== 'POST' || parsed.pathname !== '/compatible-mode/v1/responses') {
      req.resume()
      sendJson(res, 404, { error: { code: 'PATH_NOT_ALLOWED', message: 'relay path not allowed' } })
      return
    }
    if (!bearerMatches(req.headers.authorization, key)) {
      req.resume()
      sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'relay authorization failed' } })
      return
    }

    const controller = new AbortController()
    const abort = () => controller.abort()
    const abortOnDownstreamClose = () => {
      if (!res.writableEnded) controller.abort()
    }
    req.once('aborted', abort)
    res.once('close', abortOnDownstreamClose)

    try {
      const upstreamResponse = await fetchImpl(upstream, {
        method: 'POST',
        headers: buildUpstreamHeaders(req, key),
        body: req,
        duplex: 'half',
        signal: controller.signal,
      })
      res.statusCode = upstreamResponse.status
      copyResponseHeaders(upstreamResponse.headers, res)
      log({ event: 'qwen_relay_upstream_response', status: upstreamResponse.status })
      if (!upstreamResponse.body) {
        res.end()
      } else {
        await pipeline(Readable.fromWeb(upstreamResponse.body), res)
      }
    } catch (error) {
      if (controller.signal.aborted) return
      log({
        event: 'qwen_relay_upstream_failed',
        errorClass: error instanceof Error ? error.name : typeof error,
        causeCode: error?.cause?.code ?? null,
      })
      if (res.headersSent) res.destroy(error instanceof Error ? error : undefined)
      else sendJson(res, 502, { error: { code: 'UPSTREAM_FAILED', message: 'Qwen upstream request failed' } })
    } finally {
      req.off('aborted', abort)
      res.off('close', abortOnDownstreamClose)
    }
  })

  server.once('close', () => key.fill(0))
  return server
}

async function main() {
  const credentialPath = process.env.QWEN_RELAY_API_KEY_FILE
    ?? (process.env.CREDENTIALS_DIRECTORY ? `${process.env.CREDENTIALS_DIRECTORY}/bailian.key` : '')
  if (!credentialPath) throw new Error('QWEN_RELAY_API_KEY_FILE or CREDENTIALS_DIRECTORY is required')
  const apiKey = Buffer.from((await readFile(credentialPath, 'utf8')).trim(), 'utf8')
  if (apiKey.length === 0) throw new Error('relay credential is empty')
  const host = process.env.QWEN_RELAY_HOST?.trim() || DEFAULT_HOST
  const port = Number(process.env.QWEN_RELAY_PORT ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('QWEN_RELAY_PORT is invalid')
  const server = createQwenChinaRelayServer({ apiKey })
  apiKey.fill(0)
  server.listen(port, host, () => {
    console.log(JSON.stringify({ event: 'qwen_relay_listening', host, port }))
  })
  const stop = () => server.close()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: 'qwen_relay_start_failed',
      errorClass: error instanceof Error ? error.name : typeof error,
    }))
    process.exitCode = 1
  })
}
