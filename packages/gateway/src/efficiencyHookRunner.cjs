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
const http = require('node:http')
const path = require('node:path')
const { spawn } = require('node:child_process')

const DEFAULT_TIMEOUT_MS = 2500
const MIN_TIMEOUT_MS = 200
const MAX_TIMEOUT_MS = 5000
const BROKER_DEFAULT_TIMEOUT_MS = 62000
const BROKER_MAX_TIMEOUT_MS = 65000
const PRECOMPILED_NODE_FLAGS = ['--conditions=openclaude-precompiled']
const RUN_STARTED_MS = Date.now()
const TOOL_BROKER_HOOK_EVAL_PATH = '/internal/v3/tool-broker/hook-evaluate'
const SCRUBBED_BROKER_PREFIXES = ['OPENCLAUDE_TOOL_BROKER_', 'OC_TOOL_BROKER_']

function parseArg(prefix, argv) {
  const flag = argv.find((a) => a.startsWith(prefix))
  return flag ? flag.slice(prefix.length) : ''
}

function parseProtocol(argv) {
  return parseArg('--protocol=', argv) === 'cursor' ? 'cursor' : 'ccb'
}

function scrubBrokerEnv(env) {
  const clean = {}
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v !== 'string') continue
    if (SCRUBBED_BROKER_PREFIXES.some((prefix) => k.startsWith(prefix))) continue
    clean[k] = v
  }
  return clean
}

function isLoopbackUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:') return false
    const host = parsed.hostname.toLowerCase()
    return host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'localhost'
  } catch {
    return false
  }
}

function resolveBrokerHookConfig(argv = [], env = process.env) {
  const argUrl = parseArg('--broker-url=', argv).trim()
  const argTokenFile = parseArg('--broker-token-file=', argv).trim()
  const envUrl = String(env.OPENCLAUDE_TOOL_BROKER_URL || '').trim()
  const envTokenFile = String(env.OPENCLAUDE_TOOL_BROKER_HOOK_TOKEN_FILE || '').trim()
  const envToken = String(env.OPENCLAUDE_TOOL_BROKER_HOOK_TOKEN || '').trim()

  const anyConfigured = Boolean(argUrl || argTokenFile || envUrl || envTokenFile || envToken)
  if (!anyConfigured) return { state: 'unconfigured' }

  const brokerUrl = argUrl || envUrl
  if (!brokerUrl || !isLoopbackUrl(brokerUrl)) {
    return { state: 'misconfigured', reason: 'broker_url_invalid' }
  }

  let token = ''
  const tokenFile = argTokenFile || envTokenFile
  if (tokenFile) {
    try {
      token = fs.readFileSync(tokenFile, 'utf8').trim()
    } catch {
      return { state: 'misconfigured', reason: 'broker_token_file_unreadable' }
    }
  }
  if (!token) token = envToken
  if (!token.startsWith('octh1.')) {
    return { state: 'misconfigured', reason: 'broker_token_invalid' }
  }
  return { state: 'configured', config: { brokerUrl: brokerUrl.replace(/\/+$/, ''), hookToken: token } }
}

function parseTimeoutMs(brokerActive) {
  const raw = Number(process.env.OPENCLAUDE_EFFICIENCY_HOOK_TIMEOUT_MS)
  const cap = brokerActive ? BROKER_MAX_TIMEOUT_MS : MAX_TIMEOUT_MS
  const fallback = brokerActive ? BROKER_DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(raw)) return fallback
  return Math.min(cap, Math.max(MIN_TIMEOUT_MS, Math.trunc(raw)))
}

function isActionPolicyEnabled(env = process.env) {
  const raw = String(env.OPENCLAUDE_ACTION_POLICY ?? 'on').trim().toLowerCase()
  return !(raw === 'off' || raw === '0' || raw === 'false')
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

function failClosedPayload(protocol, reason) {
  if (protocol === 'cursor') {
    const msg = `[action-policy] 策略评估异常或超时，已 fail-closed 拦截（${reason}）`
    return {
      permission: 'deny',
      requiresHumanApproval: true,
      agent_message: msg,
      user_message: msg,
    }
  }
  const msg = `[action-policy] 策略评估异常或超时，需人工确认后执行（${reason}）`
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: msg,
    },
    reason: msg,
  }
}

function normalizeDecisionObject(protocol, obj) {
  if (!obj || typeof obj !== 'object') return null
  if (protocol === 'cursor') {
    if (obj.permission === 'allow' || obj.permission === 'deny') return obj
    // Cursor cannot express interactive `ask`. Fail closed as `deny` with a clear
    // human-approval-required message rather than treating `ask` as invalid_json -> allow.
    if (obj.permission === 'ask') {
      const base =
        obj.user_message ||
        obj.agent_message ||
        '需要人工审批后执行（Cursor 不支持 ask，已 fail-closed 拦截）'
      return {
        ...obj,
        permission: 'deny',
        requiresHumanApproval: true,
        agent_message: base,
        user_message: base,
      }
    }
    return null
  }
  const decision = obj.hookSpecificOutput?.permissionDecision
  if (decision === 'allow' || decision === 'deny' || decision === 'ask') return obj
  return null
}

function parseAndValidateDecision(protocol, text) {
  try {
    const obj = JSON.parse(String(text).replace(/^\uFEFF/, '').trim())
    return normalizeDecisionObject(protocol, obj)
  } catch {
    return null
  }
}

function elapsedMs() {
  return Math.max(0, Date.now() - RUN_STARTED_MS)
}

function recordFailSignal(event, reason, protocol) {
  const label = event === 'fail_closed' ? 'fail-closed' : 'fail-open'
  const rec = {
    ts: new Date().toISOString(),
    event,
    reason,
    protocol,
    elapsedMs: elapsedMs(),
  }
  try {
    fs.writeSync(2, `[oc-efficiency-guard] ${label} ${JSON.stringify(rec)}\n`)
  } catch {
    /* stderr is best-effort */
  }
  const home = process.env.OPENCLAUDE_HOME
  if (!home) return
  try {
    const dir = path.join(home, '.efficiency-guard')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.appendFileSync(path.join(dir, 'audit.jsonl'), `${JSON.stringify(rec)}\n`, { mode: 0o600 })
    const countPath = path.join(dir, `${label}.count`)
    let n = 0
    try {
      n = Number.parseInt(fs.readFileSync(countPath, 'utf8'), 10) || 0
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

function handleRunnerFault(protocol, reason) {
  if (isActionPolicyEnabled()) {
    recordFailSignal('fail_closed', reason, protocol)
    writeJsonAndExit(failClosedPayload(protocol, reason))
    return
  }
  recordFailSignal('fail_open', reason, protocol)
  writeJsonAndExit(allowPayload(protocol))
}

function resolveTsxArgs(script, extra) {
  let tsx
  try {
    tsx = require.resolve('tsx/cli')
  } catch {
    return { error: 'tsx_missing' }
  }
  return { args: [tsx, script, ...extra] }
}

function resolveInnerArgs(argv) {
  const protocol = parseProtocol(argv)
  const mode = parseArg('--mode=', argv) || 'warn'
  const override = parseArg('--script=', argv)
  const extra = [`--protocol=${protocol}`, `--mode=${mode}`]
  if (override) {
    if (override.endsWith('.ts')) {
      return resolveTsxArgs(override, extra)
    }
    return { args: [override, ...extra] }
  }
  // Runtime-release ships this runner next to the compiled inner. Prefer
  // that path: tsx + .ts is missing in dist/ and cold-starts past the
  // previous 1500ms budget even when the source file exists.
  const innerJs = path.join(__dirname, 'efficiencyPreToolHook.js')
  if (fs.existsSync(innerJs)) {
    return { args: [innerJs, ...extra], nodeFlags: PRECOMPILED_NODE_FLAGS }
  }
  const innerTs = path.join(__dirname, 'efficiencyPreToolHook.ts')
  return resolveTsxArgs(innerTs, extra)
}

function extractBrokerCommand(input) {
  if (typeof input.command === 'string' && input.command.trim()) return input.command
  const ti = input.tool_input
  if (ti && typeof ti === 'object' && !Array.isArray(ti)) {
    for (const key of ['command', 'CommandLine', 'cmd', 'script']) {
      if (typeof ti[key] === 'string' && ti[key].trim()) return ti[key]
    }
  }
  return undefined
}

function extractBrokerTarget(input) {
  if (typeof input.target === 'string' && input.target.trim()) return input.target.trim()
  const ti = input.tool_input
  if (ti && typeof ti === 'object' && !Array.isArray(ti)) {
    for (const key of ['target', 'provider', 'site', 'slug', 'url']) {
      if (typeof ti[key] === 'string' && ti[key].trim()) return ti[key].trim()
    }
  }
  return undefined
}

function translateBrokerDecision(protocol, resp) {
  if (!resp || typeof resp !== 'object') return null
  if (resp.decision === 'allow') {
    if (protocol === 'cursor') {
      return resp.message ? { permission: 'allow', agent_message: resp.message } : allowPayload('cursor')
    }
    if (resp.message) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: resp.message,
        },
      }
    }
    return allowPayload('ccb')
  }
  if (resp.decision === 'deny') {
    const reason = resp.reason || resp.code || 'Blocked by ToolBroker policy'
    if (protocol === 'cursor') {
      return {
        permission: 'deny',
        ...(resp.approvalStatus === 'detached_pending' || resp.code === 'APPROVAL_DEFERRED_DETACHED'
          ? { requiresHumanApproval: true }
          : {}),
        agent_message: reason,
        user_message: reason,
      }
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
      reason,
    }
  }
  return null
}

function handleBrokerFault(protocol, reason) {
  recordFailSignal('fail_closed', reason, protocol)
  writeJsonAndExit(
    translateBrokerDecision(protocol, {
      decision: 'deny',
      reason: `[tool-broker] 策略评估失败或令牌已失效，已 fail-closed 拦截（${reason}）`,
    }),
  )
}

function runBrokerEvaluation(protocol, mode, brokerCfg, timeoutMs) {
  let settled = false
  const finishErr = (reason) => {
    if (settled) return
    settled = true
    handleBrokerFault(protocol, reason)
  }
  const chunks = []
  let req = null
  const timer = setTimeout(() => {
    if (req) {
      try { req.destroy() } catch { /* ignore */ }
    }
    finishErr('timeout')
  }, timeoutMs)

  process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
  process.stdin.on('error', () => {
    clearTimeout(timer)
    finishErr('stdin_error')
  })
  process.stdin.on('end', () => {
    if (settled) return
    const raw = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').trim()
    let parsed
    try {
      parsed = raw ? JSON.parse(raw) : null
    } catch {
      clearTimeout(timer)
      finishErr('invalid_stdin_json')
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      clearTimeout(timer)
      finishErr('invalid_stdin_payload')
      return
    }
    const toolName =
      typeof parsed.tool_name === 'string' && parsed.tool_name.trim()
        ? parsed.tool_name.trim()
        : typeof parsed.tool === 'string' && parsed.tool.trim()
          ? parsed.tool.trim()
          : 'Bash'
    const command = extractBrokerCommand(parsed)
    const target = extractBrokerTarget(parsed)
    const args =
      parsed.tool_input && typeof parsed.tool_input === 'object' && !Array.isArray(parsed.tool_input)
        ? parsed.tool_input
        : command
          ? { command }
          : {}
    const payload = JSON.stringify({
      toolName,
      arguments: args,
      ...(command ? { command } : {}),
      ...(target ? { target } : {}),
      ...(typeof parsed.model === 'string' ? { mainModel: parsed.model } : {}),
      guardMode: mode === 'off' || mode === 'warn' || mode === 'deny' ? mode : 'deny',
    })
    const url = `${brokerCfg.brokerUrl}${TOOL_BROKER_HOOK_EVAL_PATH}`
    req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-openclaude-broker-hook-token': brokerCfg.hookToken,
        },
      },
      (res) => {
        const out = []
        res.on('data', (c) => out.push(Buffer.from(c)))
        res.on('end', () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if ((res.statusCode || 0) !== 200) {
            handleBrokerFault(protocol, `broker_http_${res.statusCode || 0}`)
            return
          }
          let body
          try {
            body = JSON.parse(Buffer.concat(out).toString('utf8'))
          } catch {
            handleBrokerFault(protocol, 'broker_invalid_json')
            return
          }
          const translated = translateBrokerDecision(protocol, body)
          if (!translated) {
            handleBrokerFault(protocol, 'broker_invalid_decision')
            return
          }
          writeJsonAndExit(translated)
        })
      },
    )
    req.on('error', (err) => {
      clearTimeout(timer)
      finishErr(`broker_error:${err?.code ? err.code : 'unknown'}`)
    })
    req.end(payload)
  })
}

function main() {
  const argv = process.argv.slice(2)
  const protocol = parseProtocol(argv)
  const mode = parseArg('--mode=', argv) || 'warn'
  const override = parseArg('--script=', argv)
  const brokerResolution = !override ? resolveBrokerHookConfig(argv, process.env) : { state: 'unconfigured' }
  if (brokerResolution.state === 'misconfigured') {
    handleBrokerFault(protocol, brokerResolution.reason)
    return
  }
  const brokerCfg = brokerResolution.state === 'configured' ? brokerResolution.config : null
  const timeoutMs = parseTimeoutMs(Boolean(brokerCfg))

  if (brokerCfg) {
    runBrokerEvaluation(protocol, mode, brokerCfg, timeoutMs)
    return
  }

  let settled = false
  let child

  // Kill the whole inner process group, not just the direct child. The
  // tsx fallback is `tsx -> node`; the precompiled path is a single node.
  // Spawn detached so the child owns its own pgid.
  const killInner = () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }

  const finishFail = (reason) => {
    if (settled) return
    settled = true
    killInner()
    handleRunnerFault(protocol, reason)
  }

  const timer = setTimeout(() => finishFail('timeout'), timeoutMs)

  const resolved = resolveInnerArgs(argv)
  if (resolved.error) {
    clearTimeout(timer)
    handleRunnerFault(protocol, resolved.error)
    return
  }

  try {
    const spawnArgs = [...(resolved.nodeFlags || []), ...resolved.args]
    child = spawn(process.execPath, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: scrubBrokerEnv(process.env),
    })
  } catch (err) {
    clearTimeout(timer)
    handleRunnerFault(protocol, `spawn_error:${err?.code ? err.code : 'unknown'}`)
    return
  }

  child.on('error', (err) => {
    clearTimeout(timer)
    finishFail(`spawn_error:${err?.code ? err.code : 'unknown'}`)
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
      handleRunnerFault(protocol, `killed:${signal}`)
      return
    }
    if (code !== 0) {
      handleRunnerFault(protocol, `nonzero_exit:${code == null ? 'null' : code}`)
      return
    }
    if (!String(stdout).trim()) {
      handleRunnerFault(protocol, 'empty_output')
      return
    }
    const validated = parseAndValidateDecision(protocol, stdout)
    if (!validated) {
      handleRunnerFault(protocol, 'invalid_json')
      return
    }
    writeJsonAndExit(validated)
  })
}

try {
  main()
} catch (err) {
  const protocol = parseProtocol(process.argv.slice(2))
  handleRunnerFault(protocol, `runner_throw:${err?.name ? err.name : 'Error'}`)
}
