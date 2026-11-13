import { join } from 'node:path'
import { SkillStore, type SkillStoreOptions } from './skillStore.js'
/** Pure read APIs only. They do not activate filesystem isolation or replace approved writers. */
import { readFile } from 'node:fs/promises'
import type { AuthorityPaths } from './authorityPaths.js'
import { MemoryDir, type MemoryFileMeta } from './memoryDir.js'
import { profileSnapshot, type UserProfileSnapshot } from './userProfile.js'
export class UserProfileView {
  constructor(private readonly authority: AuthorityPaths) {}
  async read(): Promise<UserProfileSnapshot> {
    try { return profileSnapshot(await readFile(this.authority.sharedUserMd, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return profileSnapshot('')
      throw error
    }
  }
}
/** No locks, migration, repair or writer methods. Not a cross-file transaction/approval preview. */
export class CoreMemoryView {
  readonly #reader: MemoryDir
  constructor(agentId: string, authority: AuthorityPaths) { this.#reader = new MemoryDir(agentId, authority) }
  list(): Promise<MemoryFileMeta[]> { return this.#reader.listReadonly() }
  read(file: string): Promise<{ content: string; version: string } | null> { return this.#reader.readReadonly(file) }
  renderForInjection(maxChars: number, maxLines = 200, opts?: { today?: string }): Promise<string | null> {
    return this.#reader.renderForInjectionReadonly(maxChars, maxLines, opts)
  }
}

export type SkillReadView = Pick<SkillStore, 'list' | 'view'>
/** No writable store reference or fallback builder escapes this facade. History requires an explicit resource layer in the future approval API. */
export function asSkillReadView(store: SkillStore): SkillReadView {
  return Object.freeze({
    list: async (...args: Parameters<SkillStore['list']>) => (await store.list(...args)).map(entry => ({ ...entry, writable: false })),
    view: async (...args: Parameters<SkillStore['view']>) => {
      const entry = await store.view(...args)
      return entry && typeof entry === 'object' ? { ...entry, writable: false } : entry
    },
  })
}
export function createAuthoritySkillReadView(agentId: string, authority: AuthorityPaths,
  options: Pick<SkillStoreOptions, 'baselineDir' | 'scopeMode' | 'aggregateLegacy' | 'compat'> = {}): SkillReadView {
  return asSkillReadView(new SkillStore(agentId, { ...options, authorityPaths: authority,
    agentSeedDir: authority.agentSeedSkillsDir(agentId), sharedDir: authority.sharedSkillsDir,
    hubDir: join(authority.hubDir, 'skills'), sharedWritable: false }))
}
