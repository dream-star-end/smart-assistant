import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LOG_PRODUCT_DIR = 'Clarvy'
export const LOG_DIR_NAME = 'logs'
export const LOG_MAX_BYTES = 20 * 1024 * 1024
export const LOG_MAX_FILES = 5

const SECRET_KEY = /verifier|token|secret|password|private[_-]?key|credential|pem|cert/i

export function resolveLogsDirectory({
  platform = process.platform,
  env = process.env,
  userDataPath,
} = {}) {
  if (typeof env.CLARVY_LOG_DIR === 'string' && env.CLARVY_LOG_DIR.length > 0) {
    return env.CLARVY_LOG_DIR
  }
  if (platform === 'win32' && typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.length > 0) {
    return path.win32.join(env.LOCALAPPDATA, LOG_PRODUCT_DIR, LOG_DIR_NAME)
  }
  if (typeof userDataPath === 'string' && userDataPath.length > 0) {
    return path.join(userDataPath, LOG_DIR_NAME)
  }
  return path.join(os.homedir(), '.clarvy', LOG_DIR_NAME)
}

function yyyymmdd(date) {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

function redactString(value) {
  if (value.includes('BEGIN ')) return '[redacted]'
  return value
    .replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g, '[redacted]')
    .replace(/oc-v3\.[A-Za-z0-9._~+/-]+/g, '[redacted]')
    .replace(/oc-dv\.[A-Za-z0-9._~+/-]+/g, '[redacted]')
    .replace(/oc-lah(?:-gw)?(?:\.[A-Za-z0-9._~+/-]+)?/g, '[redacted]')
    .replace(/\b[0-9a-fA-F]{64}\b/g, '[redacted]')
}

export function redactLogValue(value, depth = 0) {
  if (depth > 8) return '[truncated]'
  if (value == null) return value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => redactLogValue(entry, depth + 1))
  if (typeof value !== 'object') return String(value)
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : redactLogValue(entry, depth + 1)
  }
  return out
}

function rotate(filePath, maxFiles, fsImpl) {
  const last = `${filePath}.${maxFiles - 1}`
  try {
    fsImpl.rmSync(last, { force: true })
  } catch {
    /* */
  }
  for (let index = maxFiles - 2; index >= 1; index -= 1) {
    const from = `${filePath}.${index}`
    const to = `${filePath}.${index + 1}`
    try {
      if (fsImpl.existsSync(from)) fsImpl.renameSync(from, to)
    } catch {
      /* */
    }
  }
  try {
    if (fsImpl.existsSync(filePath)) fsImpl.renameSync(filePath, `${filePath}.1`)
  } catch {
    /* */
  }
}

export function createHostLogger({
  directory,
  now = () => new Date(),
  maxBytes = LOG_MAX_BYTES,
  maxFiles = LOG_MAX_FILES,
  fsImpl = fs,
  containerId = null,
  generation = null,
} = {}) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new TypeError('log directory required')
  }

  function currentFile(date) {
    return path.join(directory, `lah-${yyyymmdd(date)}.jsonl`)
  }

  function write(level, event, fields = {}) {
    const tsDate = typeof now === 'function' ? now() : now
    const record = redactLogValue({
      ts: tsDate instanceof Date ? tsDate.toISOString() : new Date(tsDate).toISOString(),
      level,
      event,
      containerId: fields.containerId ?? containerId,
      generation: fields.generation ?? generation,
      muxStreamId: fields.muxStreamId,
      errCode: fields.errCode,
      ...Object.fromEntries(
        Object.entries(fields).filter(
          ([key]) => !['containerId', 'generation', 'muxStreamId', 'errCode'].includes(key),
        ),
      ),
    })
    if (record.muxStreamId === undefined) delete record.muxStreamId
    if (record.errCode === undefined) delete record.errCode
    const line = `${JSON.stringify(record)}\n`
    try {
      fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 })
      const filePath = currentFile(tsDate instanceof Date ? tsDate : new Date(tsDate))
      let size = 0
      try {
        size = fsImpl.statSync(filePath).size
      } catch {
        size = 0
      }
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
        rotate(filePath, maxFiles, fsImpl)
      }
      fsImpl.appendFileSync(filePath, line, { mode: 0o600 })
    } catch {
      /* logging must never throw into Host */
    }
    return record
  }

  return {
    directory,
    redact: redactLogValue,
    info(event, fields) {
      return write('info', event, fields)
    },
    warn(event, fields) {
      return write('warn', event, fields)
    },
    error(event, fields) {
      return write('error', event, fields)
    },
    debug(event, fields) {
      return write('debug', event, fields)
    },
  }
}
