/**
 * Single snapshot of bound project context. Callers must load this once per
 * turn and feed the same immutable object to PROJECT / SKILLS overlay /
 * PROJECT_MEMORY slots and the persist writer. Do not re-read meta/ledger.
 */
import { join } from 'node:path'
import { loadProjectContext, type ProjectWorkspace } from './projectContext.js'
import { ProjectMemoryDir } from './projectMemoryDir.js'
import {
  officialManifestSha256,
  ProjectMemoryLedger,
  type SqlDb,
} from './projectMemoryLedger.js'
import {
  loadProjectSkillFileMap,
  ProjectSkillLedger,
  skillManifestSha256FromFiles,
  type SkillTreeFile,
  verifySkillTree,
} from './projectSkillLedger.js'
import { paths } from './paths.js'
import type { ProjectAsset } from './sessionsDb.js'

export interface FrozenProjectSkill {
  name: string
  description: string
  files: SkillTreeFile[]
  treeSha256: string
  skillMd: string
}

export interface FrozenOfficialMemory {
  slug: string
  contentSha256: string
  name: string
  description: string
  content: string | null
}

export interface FrozenProjectContext {
  boardProjectId: string
  bound: true
  contextVersion: number
  assetsRevision: number
  assets: ProjectAsset[]
  workspaceSpec: ProjectWorkspace | null
  workspaceCwd: string | null
  cwdSource: string | null
  instructions: string | null
  projectMdSha256: string | null
  skills: FrozenProjectSkill[]
  skillManifestSha256: string
  officialMemory: FrozenOfficialMemory[]
  officialMemoryIndex: string | null
  officialMemoryManifestSha256: string | null
}

export interface FrozenProjectContextDigests {
  contextVersion: number
  assetsRevision: number
  projectMdSha256: string | null
  skillManifestSha256: string | null
  officialMemoryManifestSha256: string | null
}

export function frozenProjectDigests(frozen: FrozenProjectContext): FrozenProjectContextDigests {
  return {
    contextVersion: frozen.contextVersion,
    assetsRevision: frozen.assetsRevision,
    projectMdSha256: frozen.projectMdSha256,
    skillManifestSha256: frozen.skillManifestSha256,
    officialMemoryManifestSha256: frozen.officialMemoryManifestSha256,
  }
}

function skillDescription(raw: string): string {
  const m = raw.match(/^description:\s*(.+)$/m)
  return m ? m[1].trim().replace(/^"|"$/g, '') : ''
}

export async function loadFrozenProjectContext(opts: {
  boardProjectId: string
  assets?: ProjectAsset[]
  assetsRevision?: number
  workspaceSpec?: ProjectWorkspace | null
  workspaceCwd?: string | null
  cwdSource?: string | null
  db?: SqlDb | null
}): Promise<FrozenProjectContext> {
  const snap = await loadProjectContext(opts.boardProjectId)
  const db = opts.db ?? null
  const { readFile } = await import('node:fs/promises')
  const ledgerSkills = db ? new ProjectSkillLedger(db).listActive(opts.boardProjectId) : []
  const fileMap = loadProjectSkillFileMap(opts.boardProjectId, db)
  const names = ledgerSkills.length > 0 ? ledgerSkills.map((r) => r.name) : [...fileMap.keys()]
  const skills: FrozenProjectSkill[] = []
  const overlayRoot = paths.projectSkillsDir(opts.boardProjectId)
  for (const name of names) {
    const row = ledgerSkills.find((r) => r.name === name)
    const files =
      row?.files ??
      [...(fileMap.get(name)?.entries() ?? [])].map(([relativePath, sha256]) => ({
        relativePath,
        sha256,
      }))
    const dir = join(overlayRoot, name)
    if (!verifySkillTree(dir, files)) continue
    let skillMd = ''
    try {
      skillMd = await readFile(join(dir, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }
    skills.push({
      name,
      description: skillDescription(skillMd),
      files,
      treeSha256: row?.treeSha256 ?? '',
      skillMd,
    })
  }

  let officialMemory: FrozenOfficialMemory[] = []
  let officialMemoryIndex: string | null = null
  let officialMemoryManifestSha256: string | null = null
  if (db) {
    try {
      const ledger = new ProjectMemoryLedger(db)
      const official = ledger.listOfficial(opts.boardProjectId)
      officialMemoryManifestSha256 = officialManifestSha256(official)
      const mem = new ProjectMemoryDir(opts.boardProjectId)
      for (const row of official) {
        if (row.deprecated) continue
        const got = await mem.readOfficial(row.slug, row.contentSha256)
        officialMemory.push({
          slug: row.slug,
          contentSha256: row.contentSha256,
          name: got?.name ?? row.slug,
          description: got?.description ?? '',
          content: got?.content ?? null,
        })
      }
      officialMemoryIndex = await mem.renderOfficialIndex(
        official.map((row) => ({
          slug: row.slug,
          contentSha256: row.contentSha256,
          expires: row.expires,
          deprecated: row.deprecated,
        })),
        8 * 1024,
        80,
      )
    } catch {
      officialMemory = []
    }
  }

  return {
    boardProjectId: opts.boardProjectId,
    bound: true,
    contextVersion: snap.version,
    assetsRevision: Number(opts.assetsRevision) || 0,
    assets: opts.assets ?? [],
    workspaceSpec: opts.workspaceSpec ?? null,
    workspaceCwd: opts.workspaceCwd ?? null,
    cwdSource: opts.cwdSource ?? null,
    instructions: snap.instructions,
    projectMdSha256: snap.meta.contentManifest?.projectMdSha256 ?? snap.meta.instructionsSha256 ?? null,
    skills,
    skillManifestSha256: skillManifestSha256FromFiles(skills),
    officialMemory,
    officialMemoryIndex,
    officialMemoryManifestSha256,
  }
}
