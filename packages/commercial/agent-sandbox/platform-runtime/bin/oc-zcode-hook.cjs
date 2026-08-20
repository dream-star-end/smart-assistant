#!/usr/local/bin/node
'use strict'

// ZCode 0.16.3 tool hook collector. This process is observability-only:
// every failure is swallowed and stdout always returns a valid empty hook
// response so collection can never block or alter the tool being observed.

const fs = require('node:fs')
const path = require('node:path')

const MAX_STDIN_BYTES = 2 * 1024 * 1024
const MAX_INPUT_CHARS = 64 * 1024
const MAX_OUTPUT_CHARS = 256 * 1024
const MAX_PREVIEW_CHARS = 2 * 1024
const ALLOWED_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])
const SAFE_ID = /^[A-Za-z0-9_.:@/-]{1,240}$/

function finish() {
  try { process.stdout.write('{}\n') } catch {}
}

function boundedJson(value, maxChars) {
  let raw
  try { raw = JSON.stringify(value) } catch { raw = JSON.stringify(String(value)) }
  if (raw === undefined) raw = 'null'
  if (raw.length <= maxChars) return { value, truncated: false }
  return {
    value: { __openclaude_truncated: true, preview: raw.slice(0, maxChars) },
    truncated: true,
  }
}

function safeString(value, maxChars) {
  const text = typeof value === 'string' ? value : ''
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

function trustedJournal(file) {
  if (!path.isAbsolute(file)) return false
  const parent = path.dirname(file)
  if (!parent.startsWith('/tmp/oc-zcode-context-')) return false
  const parentStat = fs.lstatSync(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return false
  if (parentStat.uid !== process.getuid() || (parentStat.mode & 0o077) !== 0) return false
  if (fs.existsSync(file)) {
    const st = fs.lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid()) return false
  }
  return true
}

function appendRecord(file, raw) {
  if (!trustedJournal(file)) return
  const event = JSON.parse(raw)
  if (!event || typeof event !== 'object' || Array.isArray(event)) return
  const hookEventName = event.hookEventName
  const toolCallId = event.toolCallId
  const toolName = event.toolName
  if (!ALLOWED_EVENTS.has(hookEventName)) return
  if (typeof toolCallId !== 'string' || !SAFE_ID.test(toolCallId)) return
  if (typeof toolName !== 'string' || !SAFE_ID.test(toolName)) return
  const input = boundedJson(event.toolInput, MAX_INPUT_CHARS)
  const response = boundedJson(event.toolResponse, MAX_OUTPUT_CHARS)
  const error = boundedJson(event.error, MAX_PREVIEW_CHARS)
  const record = {
    hookEventName,
    sessionId: typeof event.sessionId === 'string' && event.sessionId.startsWith('sess_')
      ? event.sessionId
      : undefined,
    toolCallId,
    toolName,
    toolInput: input.value,
    inputTruncated: input.truncated,
    toolResponse: response.value,
    outputTruncated: response.truncated,
    toolResultPreview: safeString(event.toolResultPreview, MAX_PREVIEW_CHARS),
    error: error.value,
    isInterrupt: event.isInterrupt === true,
    timestamp: typeof event.timestamp === 'string' ? event.timestamp : new Date().toISOString(),
  }
  const line = `${JSON.stringify(record)}\n`
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND
    | (fs.constants.O_NOFOLLOW || 0)
  const fd = fs.openSync(file, flags, 0o600)
  try {
    fs.fchmodSync(fd, 0o600)
    fs.writeSync(fd, line, null, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

let input = ''
let tooLarge = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (tooLarge) return
  input += chunk
  if (Buffer.byteLength(input, 'utf8') > MAX_STDIN_BYTES) {
    input = ''
    tooLarge = true
  }
})
process.stdin.on('error', finish)
process.stdin.on('end', () => {
  try {
    const journal = process.argv[2]
    if (!tooLarge && typeof journal === 'string') appendRecord(journal, input.trim())
  } catch {}
  finish()
})
