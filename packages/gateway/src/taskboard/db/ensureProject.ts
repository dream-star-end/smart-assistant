/**
 * Create-or-read a work project by a pre-reserved id.
 *
 * With the project layer on, a chat project reserves its work-project id in
 * the master database when it is created; the board itself lives in this
 * container's taskboard.db and is created here on first use (turn start,
 * board/memory/skills panels). Idempotent: an existing row is returned
 * unchanged, a concurrent create of the same id resolves to that row, and a
 * key collision takes the next free key derived from the name. The id is
 * never replaced, so memory, cron and billing history stay attached.
 */
import { createHash } from 'node:crypto'
import type { ProjectWorkspace } from '@openclaude/storage'
import type { Project } from '../domain.js'
import { createProject, getProject, getProjectByKey } from './projects.js'
import { PROJECT_KEY_RE, type TaskboardDb } from './schema.js'
import { seedDefaultPipelines } from './seed.js'

const KEY_MAX = 12

/** A board key from a project name: ASCII letters/digits if they make a valid key, else P + a short hash. */
export function deriveProjectKey(name: string): string {
  const ascii = name.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (/^[A-Z]/.test(ascii) && ascii.length >= 2) return ascii.slice(0, 6)
  const hash = Number.parseInt(createHash('sha256').update(name).digest('hex').slice(0, 8), 16)
    .toString(36)
    .toUpperCase()
  return `P${hash.slice(0, 4).padEnd(2, '0')}`
}

function keyCandidate(base: string, attempt: number): string {
  if (attempt === 0) return base
  const suffix = String(attempt + 1)
  return `${base.slice(0, KEY_MAX - suffix.length)}${suffix}`
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
}

export function ensureProjectById(
  db: TaskboardDb,
  input: { id: string; name: string; workspaceSpec?: ProjectWorkspace | null },
): { project: Project; created: boolean } {
  const existing = getProject(db, input.id)
  if (existing) return { project: existing, created: false }
  const name = input.name.trim() || '项目'
  const base = deriveProjectKey(name)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const key = keyCandidate(base, attempt)
    if (!PROJECT_KEY_RE.test(key) || getProjectByKey(db, key)) continue
    try {
      const project = db.transaction(() => {
        const created = createProject(db, {
          id: input.id,
          key,
          name,
          ...(input.workspaceSpec ? { workspaceSpec: input.workspaceSpec } : {}),
        })
        seedDefaultPipelines(db, created.id)
        return created
      })()
      return { project, created: true }
    } catch (err) {
      const raced = getProject(db, input.id)
      if (raced) return { project: raced, created: false }
      if (isUniqueViolation(err)) continue
      throw err
    }
  }
  throw new Error(`no free project key for ${input.id}`)
}
