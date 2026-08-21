#!/usr/bin/env node
/**
 * Fail-open wrapper for the efficiency PreToolUse / beforeShellExecution hook.
 *
 * This file is the command the engines actually spawn. It depends only on
 * Node builtins so a missing tsx, a broken workspace import, a hung inner
 * script, or garbage JSON cannot take down every shell call.
 *
 * Contract: always write one protocol-valid allow/deny JSON line to stdout
 * and exit 0. Never exit 2 (both CCB and Cursor treat 2 as deny).
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const DEFAULT_TIMEOUT_MS = 1500
const MIN_TIMEOUT_MS = 200
const MAX_TIMEOUT_MS = 5000

function parseArg(prefix, argv) {
  const flag = argv.find((a) => a.startsWith(prefix))
  return flag ? flag.slice(prefix.length) : ''
}

function parseProtocol(argv) {
  return parseArg('--protocol=', argv) === 'cursor' ? 'cursor' : 'ccb'
}

function parseTimeoutMs() {
  const raw = Number(process.env.OPENCLAUDE_EFFICIENCY_HOOK_TIMEOUT_MS)
  if (!Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(raw)))
}

function allowPayload(protocol) {
  if (protocol === 'cursor') return { permission: 'allow' }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  }
}

function isValidDecisionJson(protocol, text) {
  try {
    const obj = JSON.parse(String(text).replace(/^\uFEFF/, '').trim())
    if (!obj || typeof obj !== 'object') return false
    if (protocol === 'cursor') {
      return obj.permission === 'allow' || obj.permission === 'deny'
    }
    const decision = obj.hookSpecificOutput && obj.hookSpecificOutput.permissionDecision
    return decision === 'allow' || decision === 'deny' || decision === 'ask'
  } catch {
    return false
  }
}

function recordFailOpen(reason, protocol) {
  const rec = {
    ts: new Date().toISOString(),
    event: 'fail_open',
    reason,
    protocol,
  }
  try {
    fs.writeSync(2, `[oc-efficiency-guard] fail-open ${JSON.stringify(rec)}\n`)
  } catch {
    /* stderr is best-effort */
  }
  const home = process.env.OPENCLAUDE_HOME
  if (!home) return
  try {
    const dir = path.join(home, '.efficiency-guard')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.appendFileSync(path.join(dir, 'audit.jsonl'), `${JSON.stringify(rec)}\n`, { mode: 0o600 })
    const countPath = path.join(dir, 'fail-open.count')
    let n = 0
    try {
      n = parseInt(fs.readFileSync(countPath, 'utf8'), 10) || 0
    } catch {
      n = 0
    }
    fs.writeFileSync(countPath, `${n + 1}\n`, { mode: 0o600 })
  } catch {
    /* disk is best-effort; stderr already has the record */
  }
}

function writeJsonAndExit(obj) {
  fs.writeSync(1, `${JSON.stringify(obj)}\n`)
  process.exit(0)
}

function failOpen(protocol, reason) {
  recordFailOpen(reason, protocol)
  writeJsonAndExit(allowPayload(protocol))
}

function resolveInnerArgs(argv) {
  const protocol = parseProtocol(argv)
  const mode = parseArg('--mode=', argv) || 'warn'
  const override = parseArg('--script=', argv)
  const extra = [`--protocol=${protocol}`, `--mode=${mode}`]
  if (override) {
    if (override.endsWith('.ts')) {
      let tsx
      try {
        tsx = require.resolve('tsx/cli')
      } catch {
        return { error: 'tsx_missing' }
      }
      return { args: [tsx, override, ...extra] }
    }
    return { args: [override, ...extra] }
  }
  const innerTs = path.join(__dirname, 'efficiencyPreToolHook.ts')
  let tsx
  try {
    tsx = require.resolve('tsx/cli')
  } catch {
    return { error: 'tsx_missing' }
  }
  return { args: [tsx, innerTs, ...extra] }
}

function main() {
  const argv = process.argv.slice(2)
  const protocol = parseProtocol(argv)
  const timeoutMs = parseTimeoutMs()
  let settled = false

  const finishFail = (reason, child) => {
    if (settled) return
    settled = true
    if (child && !child.killed) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
    failOpen(protocol, reason)
  }

  const timer = setTimeout(() => finishFail('timeout'), timeoutMs)

  const resolved = resolveInnerArgs(argv)
  if (resolved.error) {
    clearTimeout(timer)
    failOpen(protocol, resolved.error)
    return
  }

  let child
  try {
    child = spawn(process.execPath, resolved.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
    clearTimeout(timer)
    failOpen(protocol, `spawn_error:${err && err.code ? err.code : 'unknown'}`)
    return
  }

  child.on('error', (err) => {
    clearTimeout(timer)
    finishFail(`spawn_error:${err && err.code ? err.code : 'unknown'}`, child)
  })

  process.stdin.pipe(child.stdin)
  process.stdin.on('error', () => {
    /* ignore broken stdin; child will just see EOF */
  })
  child.stdin.on('error', () => {
    /* ignore EPIPE if child already exited */
  })

  let stdout = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    try {
      fs.writeSync(2, chunk)
    } catch {
      /* ignore */
    }
  })

  child.on('close', (code, signal) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (signal === 'SIGKILL' || signal === 'SIGTERM') {
      failOpen(protocol, `killed:${signal}`)
      return
    }
    if (code !== 0) {
      failOpen(protocol, `nonzero_exit:${code == null ? 'null' : code}`)
      return
    }
    if (!String(stdout).trim()) {
      failOpen(protocol, 'empty_output')
      return
    }
    if (!isValidDecisionJson(protocol, stdout)) {
      failOpen(protocol, 'invalid_json')
      return
    }
    writeJsonAndExit(JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim()))
  })
}

try {
  main()
} catch (err) {
  const protocol = parseProtocol(process.argv.slice(2))
  failOpen(protocol, `runner_throw:${err && err.name ? err.name : 'Error'}`)
}
