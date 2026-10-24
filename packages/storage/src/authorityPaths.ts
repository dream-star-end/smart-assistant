/** Explicit formal-data paths. Composition supplies the trusted per-user root; never a request field. */
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { paths } from './paths.js'
export type ProjectFileLocations = Readonly<Pick<typeof paths,
  'projectDir' | 'projectMeta' | 'projectInstructionsFile' | 'projectSkillsDir' | 'projectLock'
  | 'projectMemoryDir' | 'projectMemoryFile' | 'projectMemoryIndex' | 'projectCandidateDir'
  | 'projectCandidateFile' | 'projectCandidatesIndex' | 'projectMemoryLock'>>
export interface AuthorityPaths extends ProjectFileLocations, Readonly<Pick<typeof paths,
  'home' | 'agentsDir' | 'agentDir' | 'sharedUserMd' | 'sharedUserLock' | 'sharedSkillsDir' | 'hubDir'
  | 'agentMemoryMd' | 'agentMemoryDir' | 'agentMemoryFile' | 'agentMemoryLock' | 'agentMemoryBatchJournal' | 'agentMemoryBarrier'
  | 'agentSkillsDir' | 'agentSkillDir' | 'agentSkillMd' | 'agentSeedSkillsDir'>> {
  readonly projectLedgerDb: string
  readonly root: string
}
function segment(value: string): string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || basename(value) !== value || value.includes('\\') || value.includes('/') || value.includes('\0')) throw new Error('Invalid authority path segment')
  return value
}
function project(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid authority project ID')
  return value.toLowerCase()
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
  const projectDir = (id: string) => join(root, 'projects', project(id))
  return Object.freeze({
    projectLedgerDb: join(root, 'formal-project.sqlite'), projectDir,
    projectMeta: (id: string) => join(projectDir(id), 'meta.json'),
    projectInstructionsFile: (id: string) => join(projectDir(id), 'PROJECT.md'),
    projectSkillsDir: (id: string) => join(projectDir(id), 'skills'),
    projectLock: (id: string) => join(projectDir(id), '.lock'),
    projectMemoryDir: (id: string) => join(projectDir(id), 'memory'),
    projectMemoryFile: (id: string, file: string) => join(projectDir(id), 'memory', segment(file)),
    projectMemoryIndex: (id: string) => join(projectDir(id), 'MEMORY.md'),
    projectCandidateDir: (id: string) => join(projectDir(id), 'memory-candidates'),
    projectCandidateFile: (id: string, file: string) => join(projectDir(id), 'memory-candidates', segment(file)),
    projectCandidatesIndex: (id: string) => join(projectDir(id), 'CANDIDATES.md'),
    projectMemoryLock: (id: string) => join(projectDir(id), '.memory.lock'),
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
