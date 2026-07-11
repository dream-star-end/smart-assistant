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

import { BUNDLE_ALLOWED_PREFIXES, validateBundlePath } from '@openclaude/protocol'

import { type AgentDef, type AgentsConfig, readAgentsConfig, writeAgentsConfig } from './config.js'
import { paths } from './paths.js'
import { marketplaceArtifactHash } from './skillEmbedding.js'
import { SKILL_AGENT_SCOPE_FILE, normalizeSkillAgentScope } from './skillStore.js'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/

/** Per-write temp suffix so concurrent writes in the SAME process don't share a
 *  tmp path (process.pid alone isn't unique within a process). */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10)
}

// ── 限频告警 ──
// 整链路 fail-soft(fetch 失败 / 逐项 skip 全部静默吞掉)导致"装了技能不显示"
// 运维完全不可见。这里给每类失败留一条 ≤1 条/60s 的 console.warn 出口:能在
// 日志里看到失败原因摘要,又不会在 turn 级高频调用下刷屏。
const WARN_INTERVAL_MS = 60_000
const _lastWarnAt = new Map<string, number>()

function warnRateLimited(key: string, message: string): void {
  const now = Date.now()
  if (now - (_lastWarnAt.get(key) ?? 0) < WARN_INTERVAL_MS) return
  _lastWarnAt.set(key, now)
  console.warn(`[marketplaceSync] ${message}`)
}

// 路径词法规则同源自 @openclaude/protocol(与 master 校验、CLI 预检一致);内容
// 本身仍不信任 master —— bundleHash 在本侧独立复算比对后才落盘。

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
  agentIds: string[]
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
      if (!res.ok) {
        warnRateLimited('fetch', `sync fetch failed: HTTP ${res.status}`)
        return null
      }
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
                if (typeof v !== 'string' || validateBundlePath(k) !== null) {
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
              agentIds: normalizeSkillAgentScope(o.agentIds),
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
  } catch (e) {
    // AbortError = 超时;其余多为网络/DNS。摘要进限频日志,行为保持 fail-soft。
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    warnRateLimited('fetch', `sync fetch failed: ${msg}`)
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
    if (marketplaceArtifactHash(s.rawSkillMd) !== s.artifactHash) {
      warnRateLimited('skill-skip', `skill "${s.slug}" skipped: artifactHash mismatch`)
      continue
    }
    desired.set(s.slug, s)
  }

  // 1) write/refresh desired skills (atomic temp+rename)
  for (const s of desired.values()) {
    try {
      const skillDir = paths.hubSkillDir(s.slug)
      const st = await lstat(skillDir).catch(() => null)
      if (st?.isSymbolicLink()) continue
      await mkdir(skillDir, { recursive: true })
      const mdPath = paths.hubSkillMd(s.slug)
      const cur = await readFile(mdPath, 'utf8').catch(() => null)
      if (cur !== s.rawSkillMd) {
        const tmp = `${mdPath}.tmp-${process.pid}-${randomSuffix()}`
        await writeFile(tmp, s.rawSkillMd, 'utf8')
        await rename(tmp, mdPath)
      }
      const scopePath = join(skillDir, SKILL_AGENT_SCOPE_FILE)
      const scopeContent = `${JSON.stringify({ agentIds: normalizeSkillAgentScope(s.agentIds) }, null, 2)}\n`
      const curScope = await readFile(scopePath, 'utf8').catch(() => null)
      if (curScope !== scopeContent) {
        const tmpScope = `${scopePath}.tmp-${process.pid}-${randomSuffix()}`
        await writeFile(tmpScope, scopeContent, 'utf8')
        await rename(tmpScope, scopePath)
      }
      // 附属文件:独立验 bundleHash(不信 master 内容),验过才逐文件落盘;
      // 各附属目录内不再被 bundle 引用的文件删除(uninstall/改版收敛)。
      const bundle =
        s.bundle && s.bundleHash && marketplaceArtifactHash(canonicalBundleJson(s.bundle)) === s.bundleHash
          ? s.bundle
          : null
      for (const sub of BUNDLE_ALLOWED_PREFIXES.map((p) => p.replace(/\/$/, ''))) {
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
          if (validateBundlePath(rel) !== null) continue
          const full = join(skillDir, rel)
          const curF = await readFile(full, 'utf8').catch(() => null)
          if (curF === content) continue
          await mkdir(join(full, '..'), { recursive: true })
          const tmpF = `${full}.tmp-${process.pid}-${randomSuffix()}`
          await writeFile(tmpF, content, 'utf8')
          await rename(tmpF, full)
        }
      }
    } catch (e) {
      // skip this one; fail-soft(原因进限频日志,否则"装了技能不显示"不可查)
      const msg = e instanceof Error ? e.message : String(e)
      warnRateLimited('skill-skip', `skill "${s.slug}" reconcile failed: ${msg}`)
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
    if (marketplaceArtifactHash(a.rawManifest) !== a.artifactHash) {
      warnRateLimited('agent-skip', `agent "${a.slug}" skipped: artifactHash mismatch`)
      continue
    }
    try {
      const m = JSON.parse(a.rawManifest)
      if (m && typeof m === 'object' && !Array.isArray(m)) {
        ;(m as Record<string, unknown>).version = a.version
        desired.set(a.slug, m as Record<string, unknown>)
      }
    } catch {
      // skip malformed(manifest 不是合法 JSON —— 装了 agent 却不出现的一类根因)
      warnRateLimited('agent-skip', `agent "${a.slug}" skipped: malformed manifest JSON`)
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
    } catch (e) {
      // skip this agent; fail-soft(原因进限频日志)
      const msg = e instanceof Error ? e.message : String(e)
      warnRateLimited('agent-skip', `agent "${slug}" reconcile failed: ${msg}`)
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

// ── 单飞 + 短 TTL 收口 ──
// gateway turn 级 + 两个管理读接口都会裸调本函数;不去重的话,每次管理页打开
// 都对 master 全量拉一遍,并发打开还会重复 reconcile。收口全部内聚在这里,
// 调用点不动:
//   1. 单飞:并发调用共享同一个 in-flight promise;
//   2. 短 TTL:距上次【成功】sync < SYNC_TTL_MS 直接返回(跳过网络)。失败
//      不进 TTL —— 下次调用仍会重试,不会把故障"缓存"住;
//   3. opts.force 逃生口:绕过 TTL(仍参与单飞),留给未来"装完立刻刷新"
//      这类必须见最新的调用方。
const SYNC_TTL_MS = 5_000
let _inflight: Promise<void> | null = null
let _lastSuccessAt = 0

/** Tests only — clear singleflight/TTL/warn-rate-limit state between cases. */
export function _resetMarketplaceSyncStateForTest(): void {
  _inflight = null
  _lastSuccessAt = 0
  _lastWarnAt.clear()
}

/**
 * Reconcile the container's marketplace state (skills + agents).
 *
 * `timeoutMs` bounds the master fetch — latency-sensitive callers (runner
 * pre-prompt / agent resolution) pass a small value; the background mcp-memory
 * startup hook uses the default. `force` bypasses the success-TTL (still
 * coalesces with an in-flight sync).
 */
export async function syncMarketplaceHub(opts?: { timeoutMs?: number; force?: boolean }): Promise<void> {
  const base = process.env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  const token = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (!base || !token) return // not a commercial container → nothing to sync

  // 单飞:已有同步在跑 → 共享它(即使本次带 force,in-flight 本身就是在拉最新)。
  if (_inflight) return _inflight
  // 短 TTL:刚成功同步过 → 直接返回,省掉 turn 级/管理页高频重复拉取。
  if (!opts?.force && _lastSuccessAt > 0 && Date.now() - _lastSuccessAt < SYNC_TTL_MS) return

  const flight = (async () => {
    const installed = await fetchInstalled(base, token, opts?.timeoutMs ?? 8000)
    if (installed === null) return // fetch failed → leave everything as-is(不进 TTL)

    await reconcileSkills(installed.skills)
    await reconcileAgents(installed.agents)
    _lastSuccessAt = Date.now()
  })()
  _inflight = flight
  try {
    await flight
  } finally {
    _inflight = null
  }
}
