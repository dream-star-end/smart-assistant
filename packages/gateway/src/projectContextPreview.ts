/**
 * Dry-run project context preview. Uses the same prompt builder and budgets
 * as a live run, but never returns SOUL/USER/secrets or the full prompt.
 */
import {
  classifySlot,
  isProjectContextEnabled,
  loadProjectContext,
  ProjectMemoryLedger,
  REDACTED_SLOT_NAMES,
} from '@openclaude/storage'
import { buildPromptContext } from './promptSlots.js'
import { getProject, getTaskboardDb } from './taskboard/db/index.js'

const PREVIEW_CHARS = 400

export const PREVIEW_DISCLAIMER =
  '仅审计：slot 元数据与安全截断预览。不可逐字重放，动态事实须 live 核验。'

export interface ProjectContextPreviewSlot {
  name: string
  bytes: number
  sha256: string
  volatile: boolean
  redacted: boolean
  preview: string | null
}

export async function previewProjectContext(opts: {
  boardProjectId: string
  agentId?: string
}): Promise<{
  enabled: boolean
  version: number
  slots: ProjectContextPreviewSlot[]
  disclaimer: string
} | { enabled: false }> {
  if (!isProjectContextEnabled()) return { enabled: false }
  const ctx = await loadProjectContext(opts.boardProjectId)
  const result = await buildPromptContext({
    agentId: opts.agentId ?? 'main',
    projectId: opts.boardProjectId,
  })
  const slots: ProjectContextPreviewSlot[] = result.applied.map((s) => {
    const { volatile, redacted } = classifySlot(s.name)
    const hide = redacted || REDACTED_SLOT_NAMES.has(s.name)
    let preview: string | null = null
    if (!hide) {
      const full = result.content
      // Do not return the concatenated prompt; only a bounded label.
      preview = `${s.name} (${s.bytes} bytes)`
    }
    void PREVIEW_CHARS
    return {
      name: s.name,
      bytes: s.bytes,
      sha256: s.sha256,
      volatile,
      redacted: hide,
      preview: hide ? null : preview,
    }
  })
  return {
    enabled: true,
    version: ctx.version,
    slots,
    disclaimer: PREVIEW_DISCLAIMER,
  }
}

export async function summarizeProjectContext(
  boardProjectId: string,
  db?: import('./taskboard/db/index.js').TaskboardDb,
): Promise<Record<string, unknown>> {
  const snap = await loadProjectContext(boardProjectId)
  let official = 0
  let candidates = 0
  const handle = db ?? (() => {
    try {
      return getTaskboardDb()
    } catch {
      return null
    }
  })()
  if (handle) {
    try {
      const ledger = new ProjectMemoryLedger(handle)
      official = ledger.listOfficial(boardProjectId).length
      candidates = ledger.listCandidates(boardProjectId, ['pending', 'conflict']).length
    } catch {
      /* */
    }
  }
  let project = null
  if (handle) {
    try {
      project = getProject(handle, boardProjectId)
    } catch {
      project = null
    }
  }
  return {
    project: project
      ? { id: project.id, key: project.key, name: project.name, contextVersion: project.contextVersion }
      : { id: boardProjectId },
    workspaceSpec: project?.workspaceSpec ?? null,
    version: snap.version,
    instructions: snap.instructions,
    skillOverlay: snap.skillOverlay,
    promotion: snap.meta.promotion,
    memory: { official, candidates },
    replay: 'audit_only_not_bit_identical',
    disclaimer: PREVIEW_DISCLAIMER,
  }
}
