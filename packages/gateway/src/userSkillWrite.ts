/**
 * Writes to one user skill name are serialised within this gateway process
 * (the container runs one gateway). `createOnly` turns a save into "create if
 * absent": the existence check and the write happen under the same lock, so
 * two tabs creating the same name cannot both pass the check and the second
 * one cannot overwrite the first.
 */
type SkillStoreLike = {
  view(name: string, file?: string, opts?: { includePlatform?: boolean }): Promise<unknown>
  save(
    meta: { name: string; description: string; tags?: string[] },
    body: string,
    options?: { agentIds?: string[] },
  ): Promise<{ ok: boolean; error?: string }>
}

const locks = new Map<string, Promise<unknown>>()

export function withSkillWriteLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(name) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => undefined)
  locks.set(name, tail)
  void tail.then(() => {
    if (locks.get(name) === tail) locks.delete(name)
  })
  return run
}

export type UserSkillWriteResult =
  | { status: 'exists' }
  | { status: 'saved'; ok: boolean; error?: string }

export function saveUserSkill(
  store: SkillStoreLike,
  input: { name: string; description: string; tags?: string[]; body: string; agentIds?: string[] },
  opts: { createOnly: boolean },
): Promise<UserSkillWriteResult> {
  return withSkillWriteLock(input.name, async () => {
    if (opts.createOnly) {
      const existing = await store.view(input.name, undefined, { includePlatform: false })
      if (existing && typeof existing !== 'string') return { status: 'exists' as const }
    }
    const r = await store.save(
      { name: input.name, description: input.description, tags: input.tags },
      input.body,
      input.agentIds ? { agentIds: input.agentIds } : undefined,
    )
    return { status: 'saved' as const, ok: r.ok, ...(r.error ? { error: r.error } : {}) }
  })
}
