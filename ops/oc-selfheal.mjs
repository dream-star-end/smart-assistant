#!/usr/bin/env node
/**
 * oc-selfheal — the ONLY privileged-operation tool available to the
 * de-privileged repair codex (block C / design §C2).
 *
 * Self-contained: node: builtins only (net), no deps, no long-lived
 * credentials. Every subcommand is one structured JSON line over the ACL'd
 * broker Unix socket; the root-side broker performs the actual operation
 * (capability tokens, git, deploy — none of that lives here).
 *
 * Usage:
 *   oc-selfheal context <repairId>
 *   oc-selfheal verify  <repairId> <sha>
 *   oc-selfheal cutover <repairId> <sha> [verificationRef]
 *   oc-selfheal report  <repairId> <progress|done|failed> <message> [detail]
 *
 * Socket: $OC_SELFHEAL_BROKER_SOCK (default /run/openclaude-selfheal/broker.sock)
 * Exit codes: 0 = ok (a held `pending_release` cutover counts as ok — it is the
 * expected default posture), 1 = broker rejected / transport error, 2 = usage.
 */

import { createConnection } from 'node:net'
import process from 'node:process'

const DEFAULT_SOCK = '/run/openclaude-selfheal/broker.sock'
const DEFAULT_TIMEOUT_MS = 45 * 60_000 // verify runs four test layers — allow long
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

function usage(code) {
  const out = code === 0 ? process.stdout : process.stderr
  out.write(
    [
      'oc-selfheal — self-heal repair broker CLI (no credentials held here)',
      '',
      'Usage:',
      '  oc-selfheal context <repairId>',
      '  oc-selfheal verify  <repairId> <sha>',
      '  oc-selfheal cutover <repairId> <sha> [verificationRef]',
      '  oc-selfheal report  <repairId> <progress|done|failed> <message> [detail]',
      '',
      `Socket: $OC_SELFHEAL_BROKER_SOCK (default ${DEFAULT_SOCK})`,
      '',
    ].join('\n'),
  )
  process.exit(code)
}

function fail(msg) {
  process.stderr.write(`oc-selfheal: ${msg}\n`)
  process.exit(1)
}

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const SHA_RE = /^[0-9a-f]{40}$/

function requireId(value, name) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    process.stderr.write(`oc-selfheal: ${name} is required and must match ${ID_RE}\n`)
    process.exit(2)
  }
  return value
}

function buildRequest(argv) {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'context': {
      const repairId = requireId(rest[0], '<repairId>')
      return { repairId, actionKind: 'context', params: {} }
    }
    case 'verify': {
      const repairId = requireId(rest[0], '<repairId>')
      const sha = rest[1]
      if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
        process.stderr.write('oc-selfheal: <sha> must be a full 40-char lowercase hex commit\n')
        process.exit(2)
      }
      return { repairId, actionKind: 'verify', params: { sha } }
    }
    case 'cutover': {
      const repairId = requireId(rest[0], '<repairId>')
      const sha = rest[1]
      if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
        process.stderr.write('oc-selfheal: <sha> must be a full 40-char lowercase hex commit\n')
        process.exit(2)
      }
      // The verifier persists the signed result under the repairId by default.
      const verificationRef =
        rest[2] !== undefined ? requireId(rest[2], '[verificationRef]') : repairId
      return { repairId, actionKind: 'cutover', params: { sha, verificationRef } }
    }
    case 'report': {
      const repairId = requireId(rest[0], '<repairId>')
      const outcome = rest[1]
      if (!['progress', 'done', 'failed'].includes(outcome)) {
        process.stderr.write('oc-selfheal: report outcome must be progress|done|failed\n')
        process.exit(2)
      }
      const message = rest[2]
      if (typeof message !== 'string' || message.length === 0) {
        process.stderr.write('oc-selfheal: report <message> is required\n')
        process.exit(2)
      }
      const detail = rest[3]
      return {
        repairId,
        actionKind: 'report',
        params: { outcome, message, ...(detail !== undefined ? { detail } : {}) },
      }
    }
    case '-h':
    case '--help':
    case 'help':
      usage(0)
      break
    default:
      usage(2)
  }
  // unreachable
  return null
}

function sendRequest(request) {
  const sock = process.env.OC_SELFHEAL_BROKER_SOCK?.trim() || DEFAULT_SOCK
  const timeoutMs = Number(process.env.OC_SELFHEAL_CLI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
  const conn = createConnection(sock)
  let buf = ''
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    conn.destroy()
    fail(`timed out after ${timeoutMs}ms waiting for the broker`)
  }, timeoutMs)
  timer.unref?.()

  conn.on('connect', () => {
    conn.write(`${JSON.stringify(request)}\n`)
  })
  conn.setEncoding('utf8')
  conn.on('data', (chunk) => {
    if (settled) return
    buf += chunk
    if (buf.length > MAX_RESPONSE_BYTES) {
      settled = true
      conn.destroy()
      fail('broker response too large')
    }
    const nl = buf.indexOf('\n')
    if (nl < 0) return
    settled = true
    clearTimeout(timer)
    conn.end()
    let resp
    try {
      resp = JSON.parse(buf.slice(0, nl))
    } catch {
      fail(`broker sent invalid JSON: ${buf.slice(0, 200)}`)
      return
    }
    process.stdout.write(`${JSON.stringify(resp, null, 2)}\n`)
    // pending_release is the EXPECTED cutover outcome under the default
    // human-release posture — not an error for the calling agent.
    const ok = resp.ok === true || resp.status === 'pending_release'
    process.exit(ok ? 0 : 1)
  })
  conn.on('error', (err) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    fail(`cannot reach broker socket ${sock}: ${err.message}`)
  })
  conn.on('close', () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    fail('broker closed the connection without a response')
  })
}

const argv = process.argv.slice(2)
if (argv.length === 0) usage(2)
sendRequest(buildRequest(argv))
