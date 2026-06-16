import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Logger } from './logger.js'

// Authoritative source of CC-terminal session ownership (sessionId -> userId).
//
// The browser CC terminal spawns the real `claude` binary, which writes per-cwd
// transcripts to ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl with no
// notion of which gateway user created them. This registry is the durable
// sessionId -> userId map that the gateway consults for (a) filtering the
// session list per user, (b) authorizing deletes, and (c) per-user concurrency.
//
// Sessions present on disk but absent from this registry are "legacy": they
// predate ownership tracking and are intentionally visible to (and deletable
// by) everyone until they age out — see ownerOf() returning undefined.

export interface OwnerRecord {
  userId: string
  createdAt: number
}

const REGISTRY_VERSION = 1
// Returned by ownerOf() for an unknown session while the registry is degraded.
// A non-undefined, never-a-real-userId value so unknown sessions fail closed
// (hidden from everyone, deletes denied) instead of being treated as legacy.
const UNKNOWN_OWNER = '__cc_terminal_registry_unavailable__'

export function resolveClaudeTerminalOwnersPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.OPENCLAUDE_HOME ?? join(homedir(), '.openclaude')
  return join(home, 'cc-terminal-owners.json')
}

export class ClaudeTerminalOwners {
  private readonly owners = new Map<string, OwnerRecord>()
  // healthy == the on-disk registry was absent (first run) or parsed cleanly.
  // When a *malformed* existing file is found we fail closed instead of
  // silently downgrading every owned session to legacy (visible/deletable by
  // all) — that would be a privilege leak.
  private healthy = true

  constructor(
    private readonly path: string,
    private readonly logger: Logger,
  ) {
    this.load()
  }

  private load(): void {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return // first run: empty + healthy
      this.degrade('read failed', err)
      return
    }
    let parsed: { owners?: Record<string, OwnerRecord>; degraded?: unknown }
    try {
      parsed = JSON.parse(raw) as { owners?: Record<string, OwnerRecord>; degraded?: unknown }
    } catch (err) {
      this.degrade('parse failed', err)
      return
    }
    const entries = parsed?.owners
    if (!entries || typeof entries !== 'object') {
      this.degrade('parse failed', new Error('missing owners map'))
      return
    }
    for (const [sessionId, rec] of Object.entries(entries)) {
      if (rec && typeof rec.userId === 'string' && rec.userId) {
        this.owners.set(sessionId, {
          userId: rec.userId,
          createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : 0,
        })
      }
    }
    // A persisted degraded marker keeps us failing closed across restarts: once
    // the registry was found corrupt we never silently revert to treating
    // unknown sessions as legacy until a human restores a clean file.
    if (parsed.degraded === true) this.healthy = false
  }

  private degrade(reason: string, err: unknown): void {
    this.healthy = false
    this.owners.clear()
    // Back up the corrupt file so ops can recover it.
    try {
      renameSync(this.path, `${this.path}.corrupt-${Date.now()}`)
    } catch {}
    // Persist a valid registry that records the degraded state, so the next
    // process start reads `degraded: true` instead of an ENOENT-looking clean
    // slate (which would fail OPEN and re-expose every owned session).
    try {
      this.persist()
    } catch (persistErr) {
      this.logger.error(
        'cc-terminal owners registry: failed to persist degraded marker',
        { path: this.path },
        persistErr,
      )
    }
    this.logger.error(
      'cc-terminal owners registry degraded; failing closed for unknown sessions',
      { reason, path: this.path },
      err,
    )
  }

  private persist(): void {
    const obj: Record<string, OwnerRecord> = {}
    for (const [sessionId, rec] of this.owners) obj[sessionId] = rec
    const tmp = `${this.path}.tmp`
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(
      tmp,
      JSON.stringify({ version: REGISTRY_VERSION, degraded: !this.healthy, owners: obj }),
    )
    renameSync(tmp, this.path)
  }

  /**
   * Owner of a session, or undefined when the session is legacy (unowned and
   * therefore visible to everyone). While the registry is degraded an unknown
   * session resolves to a sentinel (never a real userId) so it fails closed.
   */
  ownerOf(sessionId: string): string | undefined {
    const rec = this.owners.get(sessionId)
    if (rec) return rec.userId
    return this.healthy ? undefined : UNKNOWN_OWNER
  }

  /** A user may see/delete a session they own, or any legacy (unowned) session. */
  isVisibleTo(sessionId: string, userId: string): boolean {
    const owner = this.ownerOf(sessionId)
    return owner === undefined || owner === userId
  }

  record(sessionId: string, userId: string): void {
    this.owners.set(sessionId, { userId, createdAt: Date.now() })
    this.persist()
  }

  remove(sessionId: string): void {
    if (this.owners.delete(sessionId)) this.persist()
  }
}
