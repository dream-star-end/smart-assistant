/** Explicit formal-data paths. Composition supplies the trusted per-user root; never a request field. */
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { paths } from './paths.js'
export interface AuthorityPaths extends Readonly<Pick<typeof paths,
  'home' | 'agentsDir' | 'agentDir' | 'sharedUserMd' | 'sharedUserLock' | 'sharedSkillsDir' | 'hubDir'
  | 'agentMemoryMd' | 'agentMemoryDir' | 'agentMemoryFile' | 'agentMemoryLock' | 'agentMemoryBatchJournal' | 'agentMemoryBarrier'
  | 'agentSkillsDir' | 'agentSkillDir' | 'agentSkillMd' | 'agentSeedSkillsDir'>> {
  readonly root: string
}
function segment(value: string): string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || basename(value) !== value || value.includes('\\') || value.includes('/') || value.includes('\0')) throw new Error('Invalid authority path segment')
  return value
}
function agent(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid authority agent ID')
  return value
}
/** No environment fallback, directory creation, migration, lock or runtime-data location. */
export function createAuthorityPaths(authorityRoot: string): AuthorityPaths {
  if (typeof authorityRoot !== 'string' || !isAbsolute(authorityRoot) || authorityRoot.includes('\0')) throw new Error('An explicit absolute authority root is required')
  const root = resolve(authorityRoot)
  if (root === '/') throw new Error('Filesystem root cannot be a formal-data root')
  const agentDir = (id: string) => join(root, 'agents', agent(id))
  return Object.freeze({
    root, home: root, agentsDir: join(root, 'agents'), agentDir,
    sharedUserMd: join(root, 'user.md'), sharedUserLock: join(root, 'user.md.lock'),
    sharedSkillsDir: join(root, 'skills'), hubDir: join(root, 'hub'),
    agentMemoryMd: (id: string) => join(agentDir(id), 'MEMORY.md'),
    agentMemoryDir: (id: string) => join(agentDir(id), 'memory'),
    agentMemoryFile: (id: string, file: string) => join(agentDir(id), 'memory', segment(file)),
    agentMemoryLock: (id: string) => join(agentDir(id), 'MEMORY.md.lock'),
    agentMemoryBatchJournal: (id: string) => join(agentDir(id), '.memory-batch-journal.json'),
    agentMemoryBarrier: (id: string) => join(agentDir(id), 'memory-barrier.lock'),
    agentSkillsDir: (id: string) => join(agentDir(id), 'skills'),
    agentSkillDir: (id: string, name: string) => join(agentDir(id), 'skills', segment(name)),
    agentSkillMd: (id: string, name: string) => join(agentDir(id), 'skills', segment(name), 'SKILL.md'),
    agentSeedSkillsDir: (id: string) => join(agentDir(id), 'seed-skills'),
  })
}
