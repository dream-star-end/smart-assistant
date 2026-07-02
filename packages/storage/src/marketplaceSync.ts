/**
 * Container-side marketplace reconciliation (pull model) for BOTH kinds:
 *   - skills → ~/.openclaude/hub/skills/<slug>/SKILL.md (read-only hub overlay)
 *   - agents → ~/.openclaude/agents.yaml entries (source:'marketplace') + each
 *     agent's inline persona written to ~/.openclaude/agents/<slug>/CLAUDE.md
 *
 * Asks master which artifacts this user has installed (active, non-revoked) and
 * reconciles local state to match: write/refresh desired, remove anything no
 * longer installed (uninstall OR revoke = kill-switch). Same UID as the agent, no
 * master-writes-volume. Fail-soft. No-op outside a v3/v5 commercial container
 * (no OPENCLAUDE_V3_MASTER_BASE_URL / container token).
 *
 * Lives in @openclaude/storage so the gateway runner (pre-prompt + agent
 * resolution) AND the mcp-memory startup hook can both call it. Both processes
 * may run concurrently → all writes are atomic (temp+rename); writeAgentsConfig
 * is atomic too.
 */
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { type AgentDef, type AgentsConfig, readAgentsConfig, writeAgentsConfig } from './config.js'
import { paths } from './paths.js'
import { marketplaceArtifactHash } from './skillEmbedding.js'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/

/** Per-write temp suffix so concurrent writes in the SAME process don't share a
 *  tmp path (process.pid alone isn't unique within a process). */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10)
}

const BUNDLE_PATH_RE = /^(references|assets|evals|scripts)\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/

/** 稳定序列化(键排序)—— 与 master 侧 canonicalBundleJson 完全一致的 hash 输入。 */
function canonicalBundleJson(bundle: Record<string, string>): string {
  const keys = Object.keys(bundle).sort()
  const out: Record<string, string> = {}
  for (const k of keys) out[k] = bundle[k]
  return JSON.stringify(out)
}

interface SyncSkill {
  slug: string
  version: string
  rawSkillMd: string
  artifactHash: string
  /** 附属文本文件(references/assets/evals);独立 bundleHash 验证后才落盘。 */
  bundle?: Record<string, string>
  bundleHash?: string
}

interface SyncAgent {
  slug: string
  version: string
  rawManifest: string
  artifactHash: string
}

interface SyncResponse {
  skills: SyncSkill[]
  agents: SyncAgent[]
}

async function fetchInstalled(
  base: string,
  token: string,
  timeoutMs: number,
): Promise<SyncResponse | null> {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetch(`${base.replace(/\/+$/, '')}/internal/v3/marketplace/sync`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: ctl.signal,
      })
      if (!res.ok) return null
      const data = (await res.json()) as { skills?: unknown; agents?: unknown }
      const skills: SyncSkill[] = []
      if (Array.isArray(data.skills)) {
        for (const s of data.skills) {
          if (!s || typeof s !== 'object') continue
          const o = s as Record<string, unknown>
          if (
            typeof o.slug === 'string' &&
            SLUG_RE.test(o.slug) &&
            typeof o.rawSkillMd === 'string' &&
            typeof o.artifactHash === 'string' &&
            typeof o.version === 'string'
          ) {
            let bundle: Record<string, string> | undefined
            if (o.bundle && typeof o.bundle === 'object' && !Array.isArray(o.bundle)) {
              const b: Record<string, string> = {}
              let ok = true
              for (const [k, v] of Object.entries(o.bundle as Record<string, unknown>)) {
                if (typeof v !== 'string' || !BUNDLE_PATH_RE.test(k)) {
                  ok = false
                  break
                }
                b[k] = v
              }
              if (ok && Object.keys(b).length > 0) bundle = b
            }
            skills.push({
              slug: o.slug,
              version: o.version,
              rawSkillMd: o.rawSkillMd,
              artifactHash: o.artifactHash,
              ...(bundle && typeof o.bundleHash === 'string'
                ? { bundle, bundleHash: o.bundleHash }
                : {}),
            })
          }
        }
      }
      const agents: SyncAgent[] = []
      if (Array.isArray(data.agents)) {
        for (const a of data.agents) {
          if (!a || typeof a !== 'object') continue
          const o = a as Record<string, unknown>
          if (
            typeof o.slug === 'string' &&
            SLUG_RE.test(o.slug) &&
            typeof o.rawManifest === 'string' &&
            typeof o.artifactHash === 'string' &&
            typeof o.version === 'string'
          ) {
            agents.push({
              slug: o.slug,
              version: o.version,
              rawManifest: o.rawManifest,
              artifactHash: o.artifactHash,
            })
          }
        }
      }
      return { skills, agents }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null // fail-soft
  }
}

/** Reconcile hub/skills against the user's installed marketplace skills. */
async function reconcileSkills(installed: SyncSkill[]): Promise<void> {
  const skillsRoot = join(paths.hubDir, 'skills')
  try {
    await mkdir(skillsRoot, { recursive: true })
  } catch {
    return
  }

  // Independently re-verify the artifact hash — do NOT trust master's content.
  const desired = new Map<string, SyncSkill>()
  for (const s of installed) {
    if (marketplaceArtifactHash(s.rawSkillMd) !== s.artifactHash) continue
    desired.set(s.slug, s)
  }

  // 1) write/refresh desired skills (atomic temp+rename)
  for (const s of desired.values()) {
    try {
      const skillDir = paths.hubSkillDir(s.slug)
      const st = await lstat(skillDir).catch(() => null)
      if (st?.isSymbolicLink()) continue
      const mdPath = paths.hubSkillMd(s.slug)
      const cur = await readFile(mdPath, 'utf8').catch(() => null)
      if (cur !== s.rawSkillMd) {
        await mkdir(skillDir, { recursive: true })
        const tmp = `${mdPath}.tmp-${process.pid}-${randomSuffix()}`
        await writeFile(tmp, s.rawSkillMd, 'utf8')
        await rename(tmp, mdPath)
      }
      // 附属文件:独立验 bundleHash(不信 master 内容),验过才逐文件落盘;
      // 三个附属目录内不再被 bundle 引用的文件删除(uninstall/改版收敛)。
      const bundle =
        s.bundle && s.bundleHash && marketplaceArtifactHash(canonicalBundleJson(s.bundle)) === s.bundleHash
          ? s.bundle
          : null
      for (const sub of ['references', 'assets', 'evals', 'scripts']) {
        const subDir = join(skillDir, sub)
        const wanted = new Map<string, string>()
        if (bundle) {
          for (const [rel, content] of Object.entries(bundle)) {
            if (rel.startsWith(`${sub}/`)) wanted.set(rel, content)
          }
        }
        // prune
        const existing = await readdir(subDir, { recursive: true }).catch(() => [] as string[])
        for (const e of existing as string[]) {
          const rel = `${sub}/${e}`.replace(/\\/g, '/')
          if (!wanted.has(rel)) {
            const full = join(subDir, e)
            const est = await lstat(full).catch(() => null)
            if (est?.isFile() || est?.isSymbolicLink())
              await rm(full, { force: true }).catch(() => {})
          }
        }
        // write
        for (const [rel, content] of wanted) {
          if (!BUNDLE_PATH_RE.test(rel)) continue
          const full = join(skillDir, rel)
          const curF = await readFile(full, 'utf8').catch(() => null)
          if (curF === content) continue
          await mkdir(join(full, '..'), { recursive: true })
          const tmpF = `${full}.tmp-${process.pid}-${randomSuffix()}`
          await writeFile(tmpF, content, 'utf8')
          await rename(tmpF, full)
        }
      }
    } catch {
      /* skip this one; fail-soft */
    }
  }

  // 2) remove hub skills no longer installed (uninstalled / revoked)
  try {
    const existing = await readdir(skillsRoot, { withFileTypes: true })
    for (const e of existing) {
      if (!e.isDirectory()) continue
      if (!SLUG_RE.test(e.name)) continue
      if (!desired.has(e.name)) {
        await rm(join(skillsRoot, e.name), { recursive: true, force: true }).catch(() => {})
      }
    }
  } catch {
    /* leave as-is */
  }
}

/** Build a deterministic (stable-key) AgentDef for a marketplace agent. */
function marketAgentDef(slug: string, m: Record<string, unknown>, personaPath: string): AgentDef {
  const def: AgentDef = { id: slug, source: 'marketplace', persona: personaPath }
  if (typeof m.version === 'string') def.version = m.version
  if (typeof m.model === 'string') def.model = m.model
  if (Array.isArray(m.toolsets)) def.toolsets = m.toolsets.filter((t) => typeof t === 'string')
  if (typeof m.displayName === 'string') def.displayName = m.displayName
  if (typeof m.avatarEmoji === 'string') def.avatarEmoji = m.avatarEmoji
  if (typeof m.greeting === 'string') def.greeting = m.greeting
  return def
}

/** Reconcile agents.yaml (source:'marketplace' entries) + persona files. */
async function reconcileAgents(installed: SyncAgent[]): Promise<void> {
  // hash-verify + parse manifests
  const desired = new Map<string, Record<string, unknown>>()
  for (const a of installed) {
    if (!SLUG_RE.test(a.slug)) continue
    if (marketplaceArtifactHash(a.rawManifest) !== a.artifactHash) continue
    try {
      const m = JSON.parse(a.rawManifest)
      if (m && typeof m === 'object' && !Array.isArray(m)) {
        ;(m as Record<string, unknown>).version = a.version
        desired.set(a.slug, m as Record<string, unknown>)
      }
    } catch {
      /* skip malformed */
    }
  }

  let cfg: AgentsConfig
  try {
    cfg = await readAgentsConfig()
  } catch {
    return // can't read → leave as-is
  }

  // keep platform/user agents (no source marker); their ids are RESERVED — a market
  // agent that collides with one is skipped (never overwrite a platform/user agent's
  // persona or shadow it in agents.yaml). 'main' is always reserved.
  const nonMarket = (cfg.agents ?? []).filter((a) => a.source !== 'marketplace')
  const reservedIds = new Set<string>(['main', ...nonMarket.map((a) => a.id)])

  // write persona files (conditional) + build market defs
  const marketDefs: AgentDef[] = []
  for (const [slug, m] of desired) {
    if (reservedIds.has(slug)) continue // collision with a platform/user agent → skip
    try {
      const personaPath = paths.agentClaudeMd(slug)
      const personaText = typeof m.persona === 'string' ? m.persona : ''
      const cur = await readFile(personaPath, 'utf8').catch(() => null)
      if (cur !== personaText) {
        await mkdir(dirname(personaPath), { recursive: true })
        const tmp = `${personaPath}.tmp-${process.pid}-${randomSuffix()}`
        await writeFile(tmp, personaText, 'utf8')
        await rename(tmp, personaPath)
      }
      marketDefs.push(marketAgentDef(slug, m, personaPath))
    } catch {
      /* skip this agent; fail-soft */
    }
  }

  const nextAgents = [...nonMarket, ...marketDefs.sort((a, b) => a.id.localeCompare(b.id))]

  // only rewrite when the agent set actually changed (avoid mtime churn / write races)
  if (JSON.stringify(nextAgents) !== JSON.stringify(cfg.agents ?? [])) {
    try {
      await writeAgentsConfig({ ...cfg, agents: nextAgents })
    } catch {
      /* fail-soft */
    }
  }
  // (A removed market agent's persona dir is left on disk — harmless: it is no
  //  longer referenced by agents.yaml, so it is never loaded. We do NOT reap dirs
  //  to avoid any risk of deleting a platform/user agent's files.)
}

/**
 * Reconcile the container's marketplace state (skills + agents).
 *
 * `timeoutMs` bounds the master fetch — latency-sensitive callers (runner
 * pre-prompt / agent resolution) pass a small value; the background mcp-memory
 * startup hook uses the default.
 */
export async function syncMarketplaceHub(opts?: { timeoutMs?: number }): Promise<void> {
  const base = process.env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  const token = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (!base || !token) return // not a commercial container → nothing to sync

  const installed = await fetchInstalled(base, token, opts?.timeoutMs ?? 8000)
  if (installed === null) return // fetch failed → leave everything as-is

  await reconcileSkills(installed.skills)
  await reconcileAgents(installed.agents)
}
