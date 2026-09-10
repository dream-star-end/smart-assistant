/**
 * Selfhost uid-volume collaboration config. Atomic CAS file; no prefs/PG.
 * Corrupt reads fail closed and never overwrite the original file.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { acquireKernelFileLock, paths } from '@openclaude/storage'
import {
  type CollaborationMode,
  collabConfigVersionOf,
  isCollaborationMode,
} from '@openclaude/protocol'

export const COLLAB_CONFIG_FORMAT = 1 as const

export type SessionCollabConfig = {
  mode: CollaborationMode
  advisorModel: string | null
  updatedAt: number
}

export type CollaborationConfigDoc = {
  format: typeof COLLAB_CONFIG_FORMAT
  rev: number
  defaultMode: CollaborationMode
  defaultAdvisorModel: string | null
  provenEngines: string[]
  sessions: Record<string, SessionCollabConfig>
}

export class CollaborationConfigError extends Error {
  constructor(
    readonly code: 'CORRUPT' | 'CAS' | 'VALIDATION',
    message: string,
  ) {
    super(message)
    this.name = 'CollaborationConfigError'
  }
}

const EMPTY: CollaborationConfigDoc = {
  format: COLLAB_CONFIG_FORMAT,
  rev: 0,
  defaultMode: 'solo',
  defaultAdvisorModel: null,
  provenEngines: [],
  sessions: {},
}

export function emptyCollaborationConfig(): CollaborationConfigDoc {
  return structuredClone(EMPTY)
}

function isSessionId(value: string): boolean {
  return /^[A-Za-z0-9:_-]{1,128}$/.test(value)
}

export function parseCollaborationConfigDoc(raw: unknown): CollaborationConfigDoc {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CollaborationConfigError('CORRUPT', 'collaboration config is not an object')
  }
  const rec = raw as Record<string, unknown>
  if (rec.format !== COLLAB_CONFIG_FORMAT) {
    throw new CollaborationConfigError('CORRUPT', 'unsupported collaboration config format')
  }
  if (!Number.isInteger(rec.rev) || (rec.rev as number) < 0) {
    throw new CollaborationConfigError('CORRUPT', 'collaboration config rev invalid')
  }
  if (!isCollaborationMode(rec.defaultMode)) {
    throw new CollaborationConfigError('CORRUPT', 'defaultMode invalid')
  }
  const defaultAdvisorModel =
    rec.defaultAdvisorModel === null || rec.defaultAdvisorModel === undefined
      ? null
      : typeof rec.defaultAdvisorModel === 'string' && rec.defaultAdvisorModel.length <= 64
        ? rec.defaultAdvisorModel
        : (() => {
            throw new CollaborationConfigError('CORRUPT', 'defaultAdvisorModel invalid')
          })()
  const sessionsIn = rec.sessions
  if (!sessionsIn || typeof sessionsIn !== 'object' || Array.isArray(sessionsIn)) {
    throw new CollaborationConfigError('CORRUPT', 'sessions map invalid')
  }
  const sessions: Record<string, SessionCollabConfig> = {}
  for (const [id, value] of Object.entries(sessionsIn as Record<string, unknown>)) {
    if (!isSessionId(id)) throw new CollaborationConfigError('CORRUPT', `session id invalid: ${id}`)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new CollaborationConfigError('CORRUPT', `session ${id} invalid`)
    }
    const row = value as Record<string, unknown>
    if (!isCollaborationMode(row.mode)) {
      throw new CollaborationConfigError('CORRUPT', `session ${id} mode invalid`)
    }
    const advisorModel =
      row.advisorModel === null || row.advisorModel === undefined
        ? null
        : typeof row.advisorModel === 'string'
          ? row.advisorModel
          : (() => {
              throw new CollaborationConfigError('CORRUPT', `session ${id} advisorModel invalid`)
            })()
    if (typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt)) {
      throw new CollaborationConfigError('CORRUPT', `session ${id} updatedAt invalid`)
    }
    sessions[id] = { mode: row.mode, advisorModel, updatedAt: row.updatedAt }
  }
  const provenRaw = rec.provenEngines
  const provenEngines: string[] = []
  if (provenRaw !== undefined && provenRaw !== null) {
    if (!Array.isArray(provenRaw)) {
      throw new CollaborationConfigError('CORRUPT', 'provenEngines invalid')
    }
    for (const item of provenRaw) {
      if (typeof item !== 'string' || !item.trim() || item.length > 32) {
        throw new CollaborationConfigError('CORRUPT', 'provenEngines invalid')
      }
      provenEngines.push(item.trim())
    }
  }
  return {
    format: COLLAB_CONFIG_FORMAT,
    rev: rec.rev as number,
    defaultMode: rec.defaultMode,
    defaultAdvisorModel,
    provenEngines,
    sessions,
  }
}

export function resolveSessionCollab(
  doc: CollaborationConfigDoc,
  sessionId: string | undefined,
): { mode: CollaborationMode; advisorModel: string | null; configVersion: string; source: 'session' | 'default' } {
  if (sessionId && doc.sessions[sessionId]) {
    const row = doc.sessions[sessionId]
    return {
      mode: row.mode,
      advisorModel: row.advisorModel,
      configVersion: collabConfigVersionOf({ mode: row.mode, advisorModel: row.advisorModel }),
      source: 'session',
    }
  }
  return {
    mode: doc.defaultMode,
    advisorModel: doc.defaultAdvisorModel,
    configVersion: collabConfigVersionOf({
      mode: doc.defaultMode,
      advisorModel: doc.defaultAdvisorModel,
    }),
    source: 'default',
  }
}

export class AdvisorConfigStore {
  constructor(
    private readonly filePath = paths.collaborationConfig,
    private readonly lockPath = `${filePath}.lock`,
  ) {}

  read(): CollaborationConfigDoc {
    let text: string
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return emptyCollaborationConfig()
      throw new CollaborationConfigError('CORRUPT', `cannot read collaboration config: ${String(err)}`)
    }
    try {
      return parseCollaborationConfigDoc(JSON.parse(text))
    } catch (err) {
      if (err instanceof CollaborationConfigError) throw err
      throw new CollaborationConfigError('CORRUPT', 'collaboration config JSON invalid')
    }
  }

  async mutate(
    expectedRev: number | undefined,
    fn: (doc: CollaborationConfigDoc) => CollaborationConfigDoc,
  ): Promise<CollaborationConfigDoc> {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const lock = await acquireKernelFileLock(this.lockPath, 8_000)
    try {
      const current = this.read()
      if (expectedRev !== undefined && current.rev !== expectedRev) {
        throw new CollaborationConfigError(
          'CAS',
          `collaboration config rev ${current.rev} != expected ${expectedRev}`,
        )
      }
      const next = fn(structuredClone(current))
      next.format = COLLAB_CONFIG_FORMAT
      next.rev = current.rev + 1
      parseCollaborationConfigDoc(next)
      const tmp = `${this.filePath}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, this.filePath)
      return next
    } finally {
      await lock.release()
    }
  }

  async putSession(
    sessionId: string,
    value: { mode: CollaborationMode; advisorModel: string | null },
    expectedRev?: number,
  ): Promise<CollaborationConfigDoc> {
    if (!isSessionId(sessionId)) {
      throw new CollaborationConfigError('VALIDATION', 'session id invalid')
    }
    return this.mutate(expectedRev, (doc) => {
      doc.sessions[sessionId] = {
        mode: value.mode,
        advisorModel: value.mode === 'advisor' ? value.advisorModel : null,
        updatedAt: Date.now(),
      }
      return doc
    })
  }

  async deleteSession(sessionId: string): Promise<CollaborationConfigDoc> {
    return this.mutate(undefined, (doc) => {
      delete doc.sessions[sessionId]
      return doc
    })
  }

  async putDefault(
    value: { mode: CollaborationMode; advisorModel: string | null },
    expectedRev?: number,
  ): Promise<CollaborationConfigDoc> {
    return this.mutate(expectedRev, (doc) => {
      doc.defaultMode = value.mode
      doc.defaultAdvisorModel = value.mode === 'advisor' ? value.advisorModel : null
      return doc
    })
  }

  /**
   * One CAS write. Session save is never replaced by asDefault.
   * asDefault / missing sessionId updates the user default.
   */
  async putIntent(input: {
    sessionId?: string
    asDefault?: boolean
    mode: CollaborationMode
    advisorModel: string | null
    expectedRev?: number
  }): Promise<CollaborationConfigDoc> {
    if (input.sessionId && !isSessionId(input.sessionId)) {
      throw new CollaborationConfigError('VALIDATION', 'session id invalid')
    }
    const writeSession = Boolean(input.sessionId)
    const writeDefault = input.asDefault === true || !input.sessionId
    return this.mutate(input.expectedRev, (doc) => {
      if (writeSession && input.sessionId) {
        doc.sessions[input.sessionId] = {
          mode: input.mode,
          advisorModel: input.mode === 'advisor' ? input.advisorModel : null,
          updatedAt: Date.now(),
        }
      }
      if (writeDefault) {
        doc.defaultMode = input.mode
        doc.defaultAdvisorModel = input.mode === 'advisor' ? input.advisorModel : null
      }
      return doc
    })
  }

  async markEngineProven(engine: string): Promise<CollaborationConfigDoc> {
    const id = engine.trim()
    if (!id) throw new CollaborationConfigError('VALIDATION', 'engine invalid')
    return this.mutate(undefined, (doc) => {
      if (!doc.provenEngines.includes(id)) doc.provenEngines = [...doc.provenEngines, id]
      return doc
    })
  }
}
