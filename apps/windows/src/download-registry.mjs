import { randomUUID as defaultRandomUUID } from 'node:crypto'

const MAX_DOWNLOADS = 20
const MAX_FILE_NAME_LENGTH = 260
const MAX_PATH_LENGTH = 32_767
const TERMINAL_STATES = new Set(['completed', 'cancelled', 'interrupted', 'failed'])
const FAILURE_STATES = new Set(['cancelled', 'interrupted', 'failed'])
const ACTIVE_ITEM_STATES = new Set(['progressing', 'interrupted'])
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

function safeCount(value, fallback = 0) {
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
}

function safeFileName(value) {
  if (typeof value !== 'string') return 'download'
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Download metadata must reject ASCII controls.
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return normalized.slice(0, MAX_FILE_NAME_LENGTH) || 'download'
}

function safeCompletedPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_PATH_LENGTH) return null
  if (value.includes('\0')) return null
  return value
}

function publicEntry(entry) {
  return {
    id: entry.id,
    fileName: entry.fileName,
    receivedBytes: entry.receivedBytes,
    totalBytes: entry.totalBytes,
    state: entry.state,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

export function taskbarProgressState(records) {
  const active = [...records].filter((record) => ACTIVE_ITEM_STATES.has(record?.state))
  if (active.length === 0) return { value: -1 }

  let receivedBytes = 0
  let totalBytes = 0
  let hasUnknownTotal = false
  let hasInterrupted = false

  for (const record of active) {
    const total = safeCount(record.totalBytes)
    const received = safeCount(record.receivedBytes)
    hasInterrupted ||= record.state === 'interrupted'
    if (total === 0) {
      hasUnknownTotal = true
      continue
    }
    totalBytes += total
    receivedBytes += Math.min(received, total)
  }

  const knownProgress = totalBytes > 0 ? Math.min(1, receivedBytes / totalBytes) : 1
  if (hasInterrupted) return { value: knownProgress, options: { mode: 'error' } }
  if (hasUnknownTotal) return { value: 2, options: { mode: 'indeterminate' } }
  return { value: knownProgress, options: { mode: 'normal' } }
}

export class DownloadRegistry {
  constructor({ randomUUID = defaultRandomUUID, maxEntries = MAX_DOWNLOADS, now = Date.now } = {}) {
    this.randomUUID = randomUUID
    this.maxEntries = Math.min(MAX_DOWNLOADS, Math.max(1, safeCount(maxEntries, MAX_DOWNLOADS)))
    this.now = now
    this.entries = new Map()
  }

  register({ fileName, totalBytes = 0 } = {}) {
    this.#evictForInsert()
    const id = this.randomUUID()
    if (typeof id !== 'string' || !SAFE_ID.test(id) || this.entries.has(id)) {
      throw new Error('randomUUID returned an invalid or duplicate opaque id')
    }
    const timestamp = safeCount(this.now())
    this.entries.set(id, {
      id,
      fileName: safeFileName(fileName),
      receivedBytes: 0,
      totalBytes: safeCount(totalBytes),
      state: 'progressing',
      completedPath: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    return id
  }

  update(id, { receivedBytes, totalBytes } = {}) {
    const entry = this.entries.get(id)
    if (!entry || TERMINAL_STATES.has(entry.state)) return entry ? publicEntry(entry) : null
    if (receivedBytes !== undefined) {
      entry.receivedBytes = safeCount(receivedBytes, entry.receivedBytes)
    }
    if (totalBytes !== undefined) entry.totalBytes = safeCount(totalBytes, entry.totalBytes)
    entry.updatedAt = safeCount(this.now(), entry.updatedAt)
    return publicEntry(entry)
  }

  complete(id, { filePath, receivedBytes, totalBytes } = {}) {
    const entry = this.entries.get(id)
    if (!entry) return null
    if (receivedBytes !== undefined) {
      entry.receivedBytes = safeCount(receivedBytes, entry.receivedBytes)
    }
    if (totalBytes !== undefined) entry.totalBytes = safeCount(totalBytes, entry.totalBytes)
    entry.state = 'completed'
    entry.completedPath = safeCompletedPath(filePath)
    entry.updatedAt = safeCount(this.now(), entry.updatedAt)
    return publicEntry(entry)
  }

  fail(id, state = 'interrupted') {
    const entry = this.entries.get(id)
    if (!entry || !FAILURE_STATES.has(state)) return null
    entry.state = state
    entry.completedPath = null
    entry.updatedAt = safeCount(this.now(), entry.updatedAt)
    return publicEntry(entry)
  }

  list() {
    return [...this.entries.values()].reverse().map(publicEntry)
  }

  resolveCompletedPath(id) {
    const entry = this.entries.get(id)
    if (!entry || entry.state !== 'completed' || !entry.completedPath) return null
    return entry.completedPath
  }

  clear() {
    this.entries.clear()
  }

  #evictForInsert() {
    if (this.entries.size < this.maxEntries) return
    const oldestTerminal = [...this.entries.values()].find((entry) =>
      TERMINAL_STATES.has(entry.state),
    )
    const id = oldestTerminal?.id ?? this.entries.keys().next().value
    if (id) this.entries.delete(id)
  }
}
