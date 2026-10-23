/**
 * Gateway agent / persona / memory / auto-dream handlers
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-471. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. AgentHandlersHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import { fetchIdentityCompatProjection } from '@openclaude/storage'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, resolve } from 'node:path'
import type { DurableCodexBilling } from '@openclaude/protocol'
import {
  type AgentDef,
  MemoryDir,
  MEMORY_FILE_RE,
  readUserProfile,
  writeUserProfile,
  buildAgentSkillStore,
  parseFrontmatter,
  paths,
  readAgentsConfig,
  loadSessionTurns,
  loadSessionEvents,
  loadSessionUsage,
  listAutoDreamAuditSessions,
  listAutoDreamSuccessfulSessionsBetween,
  getMemoryUsageDashboard,
  recordMemoryUsageEvent,
  updateAgentsConfig,
  isMarketplacePersonaTarget,
} from '@openclaude/storage'
import { isHiddenSystemAgentId } from './agentVisibility.js'
import type { CronJob } from './cron.js'
import { USER_PROFILE_INJECT_MAX_CHARS } from './promptSlots.js'
import type { SessionManager } from './sessionManager.js'
import {
  AUTO_DREAM_PROPOSAL_JSON_SCHEMA,
  AutoDreamStructuredOutputCollector,
  type AutoDreamModelRun,
} from './autoDream.js'
import {
  AUTO_DREAM_OPTIMIZER_JSON_SCHEMA,
  type AutoDreamAuditDataset,
  type AutoDreamOptimizerModelRun,
  type AutoDreamOptimizerProposal,
} from './autoDreamOptimizer.js'
import type { AutoDreamOptimizerClient } from './autoDreamOptimizerClient.js'
import { AutoDreamPolicyClient, type AutoDreamOptimizerPolicy } from './autoDreamPolicy.js'
import { resolveLocalExecutionIfEnforced, localExecutionOverride } from './server.js'
import { normalizeAutoDreamSchedule } from './autoDreamSchedule.js'
import type { Gateway } from './server.js'

export interface AgentHandlersHost {
  _getAgentsConfig: Gateway['_getAgentsConfig']
  _getAgentsConfigUserView: Gateway['_getAgentsConfigUserView']
  autoDream: Gateway['autoDream']
  autoDreamOptimizer: Gateway['autoDreamOptimizer']
  cron: Gateway['cron']
  deps: Gateway['deps']
  getUserId: Gateway['getUserId']
  readJsonBody: Gateway['readJsonBody']
  router: Gateway['router']
  sendError: Gateway['sendError']
  sendJson: Gateway['sendJson']
  sessions: Gateway['sessions']
}

/** Transport paging only: every source character is retained in one chunk. */
function splitAuditEvidence(label: string, content: string, chunkChars = 96_000): string[] {
  if (content.length === 0) {
    return [
      JSON.stringify({ evidenceLabel: label, fragmentIndex: 1, fragmentCount: 1, content: '' }),
    ]
  }
  const fragments: string[] = []
  for (let offset = 0; offset < content.length; ) {
    let end = Math.min(content.length, offset + chunkChars)
    if (
      end < content.length &&
      end > offset &&
      content.charCodeAt(end - 1) >= 0xd800 &&
      content.charCodeAt(end - 1) <= 0xdbff
    ) {
      end--
    }
    fragments.push(content.slice(offset, end))
    offset = end
  }
  return fragments.map((fragment, index) =>
    JSON.stringify({
      evidenceLabel: label,
      fragmentIndex: index + 1,
      fragmentCount: fragments.length,
      content: fragment,
    }),
  )
}

// GET /api/agents         → { agents, default }
// POST /api/agents        → create { id, model?, persona? }
export async function handleAgentsCollection(
  this: AgentHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === 'GET') {
    // 枚举面:走用户可见投影(隐藏系统 agent 已剔除、default 已收敛)。
    const view = await this._getAgentsConfigUserView()
    this.sendJson(res, 200, {
      agents: view.agents,
      default: view.default,
      routes: view.routes,
      identityCompat: await fetchIdentityCompatProjection(),
    })
    return
  }
  if (req.method === 'POST') {
    // 建 agent 是 mutation 面:必须读/写全量 config(不能用投影视图,否则写回
    // agents.yaml 会把隐藏系统 agent 一并删掉)。保留 id 拒绝仍用 predicate 看全量。
    const body = await this.readJsonBody<Partial<AgentDef>>(req)
    if (!body.id || !/^[a-zA-Z0-9_-]+$/.test(body.id)) {
      this.sendError(res, 400, 'invalid agent id (use only a-z 0-9 _ -)')
      return
    }
    if (isHiddenSystemAgentId(body.id)) {
      this.sendError(res, 403, 'agent id is reserved')
      return
    }
    const id = body.id
    const identityProjection = await fetchIdentityCompatProjection()
    if (
      identityProjection?.profiles.some(
        ({ profile }) => profile.legacyAgentId === id || profile.canonicalAgentId === id,
      )
    ) {
      return this.sendJson(res, 409, {
        error: '此身份由已登记的兼容关系管理，不能新建为独立 Agent。',
        code: 'IDENTITY_COMPAT_MANAGED',
      })
    }
    const { config: cfg, result: agent } = await updateAgentsConfig((cfg) => {
      if (cfg.agents.find((a) => a.id === id)) {
        return null
      }
      // Inherit provider/permissionMode/cwd from request or sensible defaults
      const defaultAgent = cfg.agents.find((a) => a.id === cfg.default)
      const agent: AgentDef = {
        id: id,
        model: body.model ?? this.deps.config.defaults.model,
        persona: paths.agentClaudeMd(id),
        permissionMode:
          body.permissionMode ??
          defaultAgent?.permissionMode ??
          this.deps.config.defaults.permissionMode,
        provider: body.provider ?? defaultAgent?.provider,
        cwd: body.cwd ?? defaultAgent?.cwd,
        toolsets: body.toolsets,
      }
      cfg.agents.push(agent)
      return agent
    })
    if (!agent) return this.sendError(res, 409, 'agent already exists')
    this.deps.agentsConfig = cfg
    await mkdir(paths.agentSessionsDir(body.id), { recursive: true })
    // Seed an empty persona file if missing
    try {
      await writeFile(paths.agentClaudeMd(body.id), `# Agent: ${body.id}\n\n`, { flag: 'wx' })
    } catch {}
    // 热更新路由
    this.router.reload(cfg)
    this.sendJson(res, 201, { agent })
    return
  }
  this.sendError(res, 405, 'method not allowed')
}

// GET /api/agents/:id    → { agent }
// PUT /api/agents/:id    → update model | persona
// DELETE /api/agents/:id → remove (cannot remove default)
export async function handleAgentItem(
  this: AgentHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  if (isHiddenSystemAgentId(id)) return this.sendError(res, 404, 'agent not found')
  if (req.method === 'GET') {
    const cfg = await readAgentsConfig()
    const agent = cfg.agents.find((a) => a.id === id)
    if (!agent) return this.sendError(res, 404, 'agent not found')
    this.sendJson(res, 200, { agent })
    return
  }
  if (req.method === 'PUT' || req.method === 'DELETE') {
    const identityProjection = await fetchIdentityCompatProjection()
    if (identityProjection?.profiles.some(({ profile }) => profile.legacyAgentId === id)) {
      return this.sendJson(res, 409, {
        error: '此条目仅保留本实例运行手册；执行配置由关联市场 Agent 管理。',
        code: 'IDENTITY_COMPAT_MANAGED',
      })
    }
    const body = req.method === 'PUT' ? await this.readJsonBody<Partial<AgentDef>>(req) : {}
    const { config: cfg, result } = await updateAgentsConfig(async (cfg) => {
      const idx = cfg.agents.findIndex((a) => a.id === id)
      if (idx < 0) return { status: 404, body: { error: 'agent not found' } }
      const agent = cfg.agents[idx]
      // Provenance comes from the locked server state, never from the request.
      if (agent.source === 'marketplace')
        return {
          status: 409,
          body: {
            error: '此 Agent 由 AI 市场管理，请在市场源端修改或卸载。',
            code: 'MARKETPLACE_AGENT_MANAGED',
            authority: 'marketplace',
          },
        }
      if (req.method === 'DELETE') {
        if (cfg.default === id)
          return { status: 400, body: { error: 'cannot delete default agent' } }
        cfg.agents.splice(idx, 1)
        return { status: 200, body: { ok: true } }
      }
      if (body.persona !== undefined && (await isMarketplacePersonaTarget(cfg, body.persona))) {
        return {
          status: 409,
          body: {
            error: '人格文件由 AI 市场管理，不能作为本地编辑目标。',
            code: 'MARKETPLACE_AGENT_MANAGED',
            authority: 'marketplace',
          },
        }
      }
      if (body.model !== undefined) agent.model = body.model
      if (body.persona !== undefined) agent.persona = body.persona
      if (body.cwd !== undefined) agent.cwd = body.cwd
      if (body.permissionMode !== undefined) agent.permissionMode = body.permissionMode
      if (body.displayName !== undefined) agent.displayName = body.displayName
      if (body.avatarEmoji !== undefined) agent.avatarEmoji = body.avatarEmoji
      if (body.greeting !== undefined) agent.greeting = body.greeting
      if (body.provider !== undefined) agent.provider = body.provider
      if (body.toolsets !== undefined) agent.toolsets = body.toolsets
      if (body.mcpServers !== undefined) agent.mcpServers = body.mcpServers
      return { status: 200, body: { agent } }
    })
    if (result.status === 200) {
      this.deps.agentsConfig = cfg
      this.router.reload(cfg)
    }
    this.sendJson(res, result.status, result.body)
    return
  }
  this.sendError(res, 405, 'method not allowed')
}

// GET /api/agents/:id/persona  → { text }
// PUT /api/agents/:id/persona  → { text }
export async function handlePersona(
  this: AgentHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  if (isHiddenSystemAgentId(id)) return this.sendError(res, 404, 'agent not found')
  const cfg = await readAgentsConfig()
  const agent = cfg.agents.find((a) => a.id === id)
  if (!agent) return this.sendError(res, 404, 'agent not found')
  const personaPath = agent.persona ?? paths.agentClaudeMd(id)
  if (req.method === 'GET') {
    let text = ''
    try {
      text = await readFile(personaPath, 'utf-8')
    } catch {}
    this.sendJson(res, 200, { text, path: personaPath })
    return
  }
  if (req.method === 'PUT') {
    const body = await this.readJsonBody<{ text?: string }>(req)
    const text = typeof body.text === 'string' ? body.text : ''
    const { result } = await updateAgentsConfig(async (current) => {
      const currentAgent = current.agents.find((a) => a.id === id)
      if (!currentAgent) return { status: 404, body: { error: 'agent not found' } }
      if (currentAgent.source === 'marketplace')
        return {
          status: 409,
          body: {
            error: '此 Agent 的人格由 AI 市场管理，请在市场源端修改。',
            code: 'MARKETPLACE_AGENT_MANAGED',
            authority: 'marketplace',
          },
        }
      const currentPath = currentAgent.persona ?? paths.agentClaudeMd(id)
      if (await isMarketplacePersonaTarget(current, currentPath)) {
        return {
          status: 409,
          body: {
            error: '人格文件由 AI 市场管理，请在市场源端修改。',
            code: 'MARKETPLACE_AGENT_MANAGED',
            authority: 'marketplace',
          },
        }
      }
      await mkdir(dirname(currentPath), { recursive: true })
      await writeFile(currentPath, text, { mode: 0o600 })
      return { status: 200, body: { ok: true, path: currentPath } }
    })
    this.sendJson(res, result.status, result.body)
    return
  }
  this.sendError(res, 405, 'method not allowed')
}

// memdir 范式下的记忆读写面(单一权威在 storage 的 MemoryDir / userProfile):
//   - target='user'  : GET/PUT 共享用户画像 user.md(单文本编辑,语义与结构不变)。
//   - target='memory': GET 返回 MEMORY.md 索引 + 逐文件元信息(供 UI 渲染文件列表);
//                       PUT → 410 gone(索引不再手写,由 reconcileIndex 自愈;
//                       单条记忆改走 /memory/files/:file)。
//
// 单条记忆文件的 CRUD 在 handleMemoryFile(files/:file 子路由)。
export async function handleMemory(
  this: AgentHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  target: 'memory' | 'user',
): Promise<void> {
  if (isHiddenSystemAgentId(agentId)) return this.sendError(res, 404, 'agent not found')

  // ── 用户画像 user.md(共享单文本;底层换 userProfile,响应结构不变)──
  if (target === 'user') {
    if (req.method === 'GET') {
      const { text, version } = await readUserProfile()
      this.sendJson(res, 200, {
        text,
        charCount: text.length,
        // Legacy profile is now on-demand only. Zero disables the obsolete editor budget.
        limit: USER_PROFILE_INJECT_MAX_CHARS,
        // 乐观并发指纹:UI 拿到后随 PUT 回传,后端锁内重读比对防覆盖并发写入。
        version,
        target,
      })
      return
    }
    if (req.method === 'PUT') {
      const body = await this.readJsonBody<{ text?: string; version?: string }>(req)
      const r = await writeUserProfile(body.text ?? '', body.version)
      if (r.ok) {
        await recordMemoryUsageEvent({
          agentId,
          operation: 'profile_write',
          memoryType: 'profile',
          outcome: 'success',
          metadata: { source: 'ui' },
        }).catch(() => {})
        const { text, version } = await readUserProfile()
        this.sendJson(res, 200, {
          ok: true,
          charCount: text.length,
          limit: USER_PROFILE_INJECT_MAX_CHARS,
          version,
        })
        return
      }
      // 版本冲突(面板打开期间被别的进程写过)→ 409 + 当前盘上内容/版本,交由前端三方合并。
      // conflict 结构对齐历史:{ text, version, charCount, limit }。三态 union 用 'conflict' in r 判别。
      if ('conflict' in r) {
        return this.sendJson(res, 409, {
          error: 'memory conflict',
          conflict: {
            text: r.conflict.current,
            version: r.conflict.version,
            charCount: r.conflict.current.length,
            limit: USER_PROFILE_INJECT_MAX_CHARS,
          },
        })
      }
      return this.sendError(res, 400, r.error ?? 'save failed')
    }
    return this.sendError(res, 405, 'method not allowed')
  }

  // ── 记忆索引 MEMORY.md(target='memory')──
  const md = new MemoryDir(agentId)
  if (req.method === 'GET') {
    // GET 前懒迁移:把旧 blob 版 MEMORY.md 拆成 memdir(幂等,锁内)。
    await md.ensureMigrated()
    // reconcileIndex 锁内双向对账后返回索引文本;list 逐文件解析 frontmatter。
    const [text, files] = await Promise.all([md.reconcileIndex(), md.list()])
    this.sendJson(res, 200, {
      kind: 'index',
      // text 保留兼容:UI 可直接展示索引原文(只读折叠预览)。
      text,
      files,
      // 索引不再手写,version 仅为响应结构完整性(索引文本内容指纹)。
      version: createHash('sha256').update(text).digest('hex').slice(0, 16),
    })
    return
  }
  if (req.method === 'PUT') {
    // memdir:索引由 reconcileIndex 自愈,不接受整段手写覆盖。单条改走 files/:file。
    return this.sendError(res, 410, 'memory index is auto-managed; edit memory/<file> instead')
  }
  this.sendError(res, 405, 'method not allowed')
}

export async function handleMemoryUsage(
  this: AgentHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  url: URL,
): Promise<void> {
  if (isHiddenSystemAgentId(agentId)) return this.sendError(res, 404, 'agent not found')
  if (req.method !== 'GET') return this.sendError(res, 405, 'method not allowed')
  const rawDays = Number(url.searchParams.get('days') ?? '30')
  const days = Number.isInteger(rawDays) ? Math.max(1, Math.min(90, rawDays)) : 30
  this.sendJson(res, 200, await getMemoryUsageDashboard({ agentId, days }))
}

// GET /api/agents/:id/auto-dream-report → sanitized latest result/progress.
export async function handleAutoDreamReport(
  this: AgentHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
): Promise<void> {
  if (isHiddenSystemAgentId(agentId)) return this.sendError(res, 404, 'agent not found')
  if (req.method !== 'GET') return this.sendError(res, 405, 'method not allowed')
  this.sendJson(res, 200, await this.autoDream.getPublicStatus(agentId))
}

export async function handleAutoDreamOptimizer(
  this: AgentHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
): Promise<void> {
  if (isHiddenSystemAgentId(agentId)) return this.sendError(res, 404, 'agent not found')
  if (req.method === 'GET') {
    this.sendJson(res, 200, await this.autoDreamOptimizer.getPublicState(agentId))
    return
  }
  if (req.method === 'POST') {
    this.sendJson(res, 202, await this.autoDreamOptimizer.startManual(agentId, this.getUserId(req)))
    return
  }
  this.sendError(res, 405, 'method not allowed')
}

export async function handleAutoDreamOptimizerCancel(
  this: AgentHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
): Promise<void> {
  if (isHiddenSystemAgentId(agentId)) return this.sendError(res, 404, 'agent not found')
  if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
  this.sendJson(res, 202, await this.autoDreamOptimizer.cancel(agentId))
}

export async function handleAutoDreamOptimizerProposal(
  this: AgentHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  proposalId: string,
  action: 'apply' | 'dismiss',
): Promise<void> {
  if (isHiddenSystemAgentId(agentId)) return this.sendError(res, 404, 'agent not found')
  if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
  this.sendJson(
    res,
    200,
    action === 'apply'
      ? await this.autoDreamOptimizer.apply(agentId, proposalId)
      : await this.autoDreamOptimizer.dismiss(agentId, proposalId),
  )
}

// GET    /api/agents/:id/memory/files/:file → { file, content, version } | 404
// PUT    /api/agents/:id/memory/files/:file  body { content, version? } → { ok, version } | 409 | 400
// DELETE /api/agents/:id/memory/files/:file → { ok } | 404
//
// 单条记忆文件的 CRUD。文件名双保险:路由已限 [^/],这里再过 MEMORY_FILE_RE(防 `..`
// 及非法字符穿越)——「API 层拒绝非法名」是读侧安全权威之一(见设计契约§安全)。
export async function handleMemoryFile(
  this: AgentHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  file: string,
): Promise<void> {
  if (isHiddenSystemAgentId(agentId)) return this.sendError(res, 404, 'agent not found')
  const safe = basename(file)
  if (safe !== file || !MEMORY_FILE_RE.test(safe)) {
    return this.sendError(res, 400, 'invalid memory file name')
  }
  const md = new MemoryDir(agentId)
  if (req.method === 'GET') {
    await md.ensureMigrated()
    const hit = await md.read(safe)
    if (!hit) return this.sendError(res, 404, 'memory file not found')
    this.sendJson(res, 200, { file: safe, content: hit.content, version: hit.version })
    return
  }
  if (req.method === 'PUT') {
    const body = await this.readJsonBody<{ content?: string; version?: string }>(req)
    const existed = Boolean(await md.read(safe))
    const r = await md.write(safe, body.content ?? '', body.version)
    if (r.ok) {
      await recordMemoryUsageEvent({
        agentId,
        operation: existed ? 'core_update' : 'core_write',
        memoryType: 'core',
        outcome: 'success',
        topMatchKey: safe,
        metadata: { source: 'ui' },
      }).catch(() => {})
      this.sendJson(res, 200, { ok: true, file: safe, version: r.version })
      return
    }
    // 版本冲突结构对齐 user 路由:{ error, conflict:{ text, version } }。三态 union 用 'conflict' in r 判别。
    if ('conflict' in r) {
      return this.sendJson(res, 409, {
        error: 'memory conflict',
        conflict: { text: r.conflict.current, version: r.conflict.version },
      })
    }
    return this.sendError(res, 400, r.error ?? 'save failed')
  }
  if (req.method === 'DELETE') {
    const removed = await md.remove(safe)
    if (!removed) return this.sendError(res, 404, 'memory file not found')
    await recordMemoryUsageEvent({
      agentId,
      operation: 'core_delete',
      memoryType: 'core',
      outcome: 'success',
      topMatchKey: safe,
      metadata: { source: 'ui' },
    }).catch(() => {})
    this.sendJson(res, 200, { ok: true, file: safe })
    return
  }
  this.sendError(res, 405, 'method not allowed')
}

export type LoadAutoDreamAuditDatasetInput = {
    agentId: string
    afterSeq: number | null
    policy: AutoDreamOptimizerPolicy
  }

export async function _loadAutoDreamAuditDataset(
  this: AgentHandlersHost,
  input: LoadAutoDreamAuditDatasetInput,
): Promise<AutoDreamAuditDataset> {
  const successWindow = await listAutoDreamSuccessfulSessionsBetween({
    agentId: input.agentId,
    channels: ['webchat', 'wechat', 'telegram'],
    afterSeq: input.afterSeq ?? 0,
  })
  const sessions =
    input.afterSeq === null
      ? await listAutoDreamAuditSessions(input.agentId)
      : successWindow.sessions.map((row) => ({
          id: row.id,
          agentId: row.agentId,
          channel: row.channel,
          peerId: '',
          title: '',
          startedAt: row.completedAt,
          lastAt: row.completedAt,
          turnCount: 0,
          totalCostUSD: 0,
        }))
  const byId = new Map(sessions.map((row) => [row.id, row]))
  const pages: string[] = []
  const memory = new MemoryDir(input.agentId)
  await memory.ensureMigrated()
  const memoryRows = await memory.list()
  const memoryContent = await Promise.all(
    memoryRows.map(async (row) => ({
      file: row.file,
      type: row.type,
      content: (await memory.read(row.file))?.content ?? '',
    })),
  )
  const skills = await buildAgentSkillStore(input.agentId).list({ includePlatform: true })
  const skillContent = await Promise.all(
    skills.map(async (skill) => {
      const content = await buildAgentSkillStore(input.agentId).view(skill.name)
      return {
        name: skill.name,
        layer: skill.layer,
        description: skill.description,
        content: content && typeof content !== 'string' ? content.rawContent : '',
      }
    }),
  )
  const profile = await readUserProfile()
  const persona = await readFile(paths.agentClaudeMd(input.agentId), 'utf8').catch(() => '')
  const cronJobs = this.cron
    ? (await this.cron.listJobs()).filter((job) => job.agent === input.agentId)
    : []
  const platformContext = {
    auditContract: {
      consent: 'optimizer_v2',
      applyRequiresUserConfirmation: true,
      platformFindingsAutoReportedAnonymously: true,
    },
    capabilities: [
      'multi-channel chat and durable sessions',
      'memory and shared user profile',
      'custom and marketplace skills',
      'agent persona and rules',
      'plugins/connectors and marketplace',
      'scheduled tasks and reminders',
      'model/default effort/preferences',
      'goals, files, browser, research and office tools',
    ],
    preferences: input.policy.auditContext?.preferences ?? {},
    installedPlugins: input.policy.auditContext?.installedPlugins ?? [],
    memories: memoryContent,
    userProfile: profile.text,
    agentPersonaAndRules: persona,
    skills: skillContent,
    schedules: cronJobs,
    proposalTargetRules: {
      memory: 'targetId=memory/<file>.md; before/after must be exact complete file text',
      profile: 'targetId=profile; before/after must be exact complete user profile text',
      skill: 'targetId=skill/<name>; before/after must be exact complete SKILL.md',
      ruleOrPersona: 'targetId=agent-persona; before/after must be exact complete agent CLAUDE.md',
      preference:
        'targetId must be an existing safe preference key shown in this page; before/after must be JSON.stringify(current/desired value)',
      schedule:
        'targetId=schedule/<existing-id or new>; before/after must be complete CronJob JSON',
      platformSkills:
        'platform/baseline skills are read-only; do not propose skill.upsert/delete for those names',
    },
  }
  pages.push(...splitAuditEvidence('platform-context', JSON.stringify(platformContext)))

  for (const meta of byId.values()) {
    const [turns, events, usage] = await Promise.all([
      loadSessionTurns(meta.id, null),
      loadSessionEvents(meta.id),
      loadSessionUsage(meta.id),
    ])
    pages.push(
      ...splitAuditEvidence(
        `session:${createHash('sha256').update(meta.id).digest('hex').slice(0, 16)}`,
        JSON.stringify({
          session: {
            channel: meta.channel,
            title: meta.title,
            startedAt: meta.startedAt,
            lastAt: meta.lastAt,
            turnCount: meta.turnCount,
          },
          turns,
          events: events.map(({ peerId: _peerId, ...event }) => event),
          usage,
        }),
      ),
    )
  }
  return {
    pages,
    sessionsReviewed: byId.size,
    throughSeq: successWindow.throughSeq,
  }
}

export async function _runAutoDreamOptimizerModel(
  this: AgentHandlersHost,
  input: AutoDreamOptimizerModelRun,
  client: AutoDreamOptimizerClient,
): Promise<string> {
  const cfg = await this._getAgentsConfig()
  const sourceAgent =
    cfg.agents.find((row) => row.id === input.agentId) ??
    cfg.agents.find((row) => row.id === cfg.default)
  if (!sourceAgent) throw new Error('AUTO_DREAM_AGENT_NOT_FOUND')
  const agent: AgentDef = {
    ...sourceAgent,
    model: input.model,
    provider: undefined,
    runnerKind: undefined,
    persona: undefined,
    cwd: undefined,
    mcpServers: [],
    toolsets: [],
  }
  const execution = await resolveLocalExecutionIfEnforced({
    agent,
    kind: 'auto_dream',
    model: input.model,
    defaultModel: this.deps.config.defaults.model,
  })
  const model = execution?.canonicalModel ?? input.model
  const expectedEngine =
    model === 'gpt-5.6-terra'
      ? 'codex'
      : model === 'deepseek-v4-flash' || model === 'MiniMax-M3'
        ? 'ccb'
        : null
  const engine = execution?.engine ?? expectedEngine
  if (!expectedEngine || engine !== expectedEngine) {
    throw new Error('AUTO_DREAM_MODEL_ENGINE_MISMATCH')
  }
  const admission =
    engine === 'codex'
      ? await client.admit(input)
      : await client.retryPending(input.agentId).then(() => null)
  const sessionKey =
    input.phase === 'map'
      ? `auto-dream-optimizer:${input.callId}`
      : `auto-dream-optimizer:${input.runId}:reduce`
  let session: Awaited<ReturnType<SessionManager['getOrCreate']>>
  try {
    session = await this.sessions.getOrCreate({
      sessionKey,
      agent,
      ...localExecutionOverride(execution),
      channel: 'auto-dream',
      peerId: sessionKey,
      ...(engine === 'ccb' ? { userId: input.userId } : {}),
      effortLevel: 'max',
      workload: 'auto-dream',
      hermeticNoTools: true,
      structuredOutputSchema: AUTO_DREAM_OPTIMIZER_JSON_SCHEMA,
    })
  } catch (err) {
    if (admission) await client.abandon(admission.requestId).catch(() => {})
    throw err
  }
  const structuredOutput = new AutoDreamStructuredOutputCollector()
  let invalidEvent: string | null = null
  let billing: import('@openclaude/protocol').DurableCodexBilling | null = null
  let stagedBilling = false
  let completed = false
  try {
    await this.sessions.submit(
      session,
      input.prompt,
      (event) => {
        if (event.kind === 'codex_billing') {
          if (!admission) {
            invalidEvent ??= 'unexpected_billing'
            return
          }
          if (billing) {
            invalidEvent ??= 'multiple_billing'
          } else {
            billing = { ...event }
            // biome-ignore lint/performance/noDelete: moved verbatim from server.ts (OCV5-471); pre-existing there
            delete (billing as { kind?: string }).kind
          }
          return
        }
        structuredOutput.accept(event)
      },
      'max',
      model,
      admission?.requestId,
      undefined,
      'default',
      admission ? { codexRoute: admission.routeFrame } : undefined,
    )
    if (admission && billing) {
      const stage = await client.stageBilling(input.agentId, billing)
      stagedBilling = true
      await client.settleStaged(input.agentId, billing, stage)
    }
    if (admission && !billing) throw new Error('AUTO_DREAM_MISSING_BILLING')
    if (invalidEvent) throw new Error(`AUTO_DREAM_INVALID_EVENT_${invalidEvent}`)
    const output = structuredOutput.finish()
    completed = true
    return output
  } finally {
    if (admission && !billing && !stagedBilling) {
      await client.abandon(admission.requestId).catch(() => {})
    }
    if (input.phase === 'map' || !completed) {
      await this.sessions.destroySession(sessionKey).catch(() => {})
    }
  }
}

export type HydrateAutoDreamOptimizerProposalsInput = {
    runId: string
    agentId: string
    proposals: AutoDreamOptimizerProposal[]
  }

export async function _hydrateAutoDreamOptimizerProposals(
  this: AgentHandlersHost,
  input: HydrateAutoDreamOptimizerProposalsInput,
): Promise<AutoDreamOptimizerProposal[]> {
  const policy = await new AutoDreamPolicyClient().get({ fresh: true })
  if (!policy.enabled || policy.mode !== 'optimizer_v2') {
    throw new Error('AUTO_DREAM_OPTIMIZER_NOT_ENABLED')
  }
  const [profile, persona, jobs] = await Promise.all([
    readUserProfile(),
    readFile(paths.agentClaudeMd(input.agentId), 'utf8').catch(() => ''),
    this.cron ? this.cron.listJobs() : Promise.resolve([]),
  ])
  const skillStore = buildAgentSkillStore(input.agentId)
  const userSkills = new Map(
    (await skillStore.list({ includePlatform: false })).map((skill) => [skill.name, skill]),
  )
  const preferenceSnapshot = policy.auditContext?.preferences ?? {}
  const hydrated: AutoDreamOptimizerProposal[] = []

  for (const proposal of input.proposals) {
    let targetId = proposal.targetId
    let before = ''
    let after = proposal.after
    if (proposal.action === 'profile.replace') {
      before = profile.text
    } else if (proposal.action === 'memory.upsert' || proposal.action === 'memory.delete') {
      const file = proposal.targetId.replace(/^memory\//, '')
      const current = await new MemoryDir(input.agentId).read(file)
      if (proposal.action === 'memory.delete') {
        if (!current) continue
        after = ''
      }
      before = current?.content ?? ''
    } else if (proposal.action === 'skill.upsert' || proposal.action === 'skill.delete') {
      const name = proposal.targetId.replace(/^skill\//, '')
      const metadata = userSkills.get(name)
      if (metadata && !metadata.writable) continue
      const current = await skillStore.view(name, undefined, { includePlatform: false })
      if (proposal.action === 'skill.delete') {
        if (!current || typeof current === 'string') continue
        after = ''
      }
      before = current && typeof current !== 'string' ? current.rawContent : ''
    } else if (proposal.action === 'rule.replace' || proposal.action === 'agent.persona.replace') {
      before = persona
    } else if (proposal.action === 'preference.patch') {
      const key = proposal.targetId.slice('preferences.'.length)
      const current = Object.prototype.hasOwnProperty.call(preferenceSnapshot, key)
        ? preferenceSnapshot[key]
        : null
      before = JSON.stringify(current)
    } else if (proposal.action === 'schedule.upsert' || proposal.action === 'schedule.delete') {
      const requestedId = proposal.targetId.replace(/^schedule\//, '')
      const jobId =
        requestedId === 'new'
          ? `auto-dream-${createHash('sha256')
              .update(`${input.runId}\0${proposal.after}`)
              .digest('hex')
              .slice(0, 24)}`
          : requestedId
      if (jobs.some((job) => job.id === jobId && job.agent !== input.agentId)) continue
      const current = jobs.find((job) => job.id === jobId && job.agent === input.agentId)
      if (proposal.action === 'schedule.delete') {
        if (!current) continue
        after = ''
      } else {
        try {
          after = JSON.stringify(normalizeAutoDreamSchedule(after, input.agentId, jobId))
        } catch {
          continue
        }
      }
      before = current ? JSON.stringify(current) : ''
      targetId = `schedule/${jobId}`
    } else if (proposal.action === 'plugin.install') {
      before = ''
    } else if (proposal.action === 'manual.review') {
      before = proposal.before
    } else {
      continue
    }

    const fingerprint = createHash('sha256')
      .update(`${proposal.action}\0${targetId}\0${before}\0${after}`)
      .digest('hex')
    hydrated.push({
      ...proposal,
      id: createHash('sha256')
        .update(`${input.runId}\0${hydrated.length}\0${fingerprint}`)
        .digest('hex')
        .slice(0, 32),
      fingerprint,
      targetId,
      before,
      after,
      beforeFingerprint: createHash('sha256').update(before).digest('hex'),
    })
  }
  return hydrated
}

export async function _applyAutoDreamOptimizerProposal(
  this: AgentHandlersHost,
  input: { agentId: string; proposal: AutoDreamOptimizerProposal },
  client: AutoDreamOptimizerClient,
): Promise<{ ok: true; result?: string } | { ok: false; conflict: string }> {
  const { agentId, proposal } = input
  if (proposal.action === 'preference.patch') {
    return await client.applyMasterProposal(proposal)
  }
  if (proposal.action === 'profile.replace') {
    const current = await readUserProfile()
    if (current.text === proposal.after) return { ok: true, result: 'profile already applied' }
    if (createHash('sha256').update(current.text).digest('hex') !== proposal.beforeFingerprint) {
      return { ok: false, conflict: '用户画像已在审计后发生变化。' }
    }
    const result = await writeUserProfile(proposal.after, current.version)
    return result.ok
      ? { ok: true, result: 'profile applied' }
      : { ok: false, conflict: 'conflict' in result ? '用户画像已发生变化。' : result.error }
  }
  if (proposal.action === 'memory.upsert' || proposal.action === 'memory.delete') {
    const file = proposal.targetId.replace(/^memory\//, '')
    if (!MEMORY_FILE_RE.test(file)) throw new Error('AUTO_DREAM_MEMORY_TARGET_INVALID')
    const store = new MemoryDir(agentId)
    const current = await store.read(file)
    const currentText = current?.content ?? ''
    if (proposal.action === 'memory.upsert' && currentText === proposal.after) {
      return { ok: true, result: 'memory already applied' }
    }
    if (proposal.action === 'memory.delete' && !current) {
      return { ok: true, result: 'memory already deleted' }
    }
    if (createHash('sha256').update(currentText).digest('hex') !== proposal.beforeFingerprint) {
      return { ok: false, conflict: '该记忆已在审计后发生变化。' }
    }
    if (proposal.action === 'memory.delete') {
      if (!current) return { ok: true, result: 'memory already deleted' }
      const result = await store.applyBatchCas({
        upserts: [],
        deletes: [{ file, expectedVersion: current.version }],
      })
      return result.ok
        ? { ok: true, result: 'memory deleted' }
        : { ok: false, conflict: '该记忆已发生变化。' }
    }
    const result = await store.write(file, proposal.after, current?.version ?? null)
    return result.ok
      ? { ok: true, result: 'memory applied' }
      : { ok: false, conflict: '该记忆已发生变化。' }
  }
  if (proposal.action === 'skill.upsert' || proposal.action === 'skill.delete') {
    const name = proposal.targetId.replace(/^skill\//, '')
    const store = buildAgentSkillStore(agentId)
    const current = await store.view(name, undefined, { includePlatform: false })
    const currentText = current && typeof current !== 'string' ? current.rawContent : ''
    if (proposal.action === 'skill.delete' && !current) {
      return { ok: true, result: 'skill already deleted' }
    }
    if (proposal.action === 'skill.upsert' && current && typeof current !== 'string') {
      const desired = parseFrontmatter(proposal.after)
      const currentParsed = parseFrontmatter(current.rawContent)
      if (
        desired.body === currentParsed.body &&
        desired.meta.description === currentParsed.meta.description &&
        JSON.stringify(desired.meta.tags ?? []) === JSON.stringify(currentParsed.meta.tags ?? []) &&
        JSON.stringify(desired.meta.related_skills ?? []) ===
          JSON.stringify(currentParsed.meta.related_skills ?? [])
      ) {
        return { ok: true, result: 'skill already applied' }
      }
    }
    if (createHash('sha256').update(currentText).digest('hex') !== proposal.beforeFingerprint) {
      return { ok: false, conflict: '该技能已在审计后发生变化。' }
    }
    if (proposal.action === 'skill.delete') {
      const removed = await store.delete(name)
      return removed.ok
        ? { ok: true, result: 'skill deleted' }
        : { ok: false, conflict: removed.error ?? '技能删除失败。' }
    }
    const parsed = parseFrontmatter(proposal.after)
    const description = typeof parsed.meta.description === 'string' ? parsed.meta.description : ''
    const saved = await store.save(
      {
        name,
        description,
        version: parsed.meta.version,
        tags: parsed.meta.tags,
        related_skills: parsed.meta.related_skills,
      },
      parsed.body,
    )
    return saved.ok
      ? { ok: true, result: 'skill applied' }
      : { ok: false, conflict: saved.error ?? '技能保存失败。' }
  }
  if (proposal.action === 'rule.replace' || proposal.action === 'agent.persona.replace') {
    if (proposal.targetId !== 'agent-persona') {
      throw new Error('AUTO_DREAM_PERSONA_TARGET_INVALID')
    }
    const path = paths.agentClaudeMd(agentId)
    const current = await readFile(path, 'utf8').catch(() => '')
    if (current === proposal.after) return { ok: true, result: 'agent rules already applied' }
    if (createHash('sha256').update(current).digest('hex') !== proposal.beforeFingerprint) {
      return { ok: false, conflict: 'Agent 规则已在审计后发生变化。' }
    }
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
    await writeFile(tmp, proposal.after, { mode: 0o600 })
    await rename(tmp, path)
    return { ok: true, result: 'agent rules applied' }
  }
  if (proposal.action === 'schedule.upsert' || proposal.action === 'schedule.delete') {
    if (!this.cron) throw new Error('AUTO_DREAM_CRON_UNAVAILABLE')
    const requestedId = proposal.targetId.replace(/^schedule\//, '')
    const jobId = requestedId === 'new' ? `auto-dream-${proposal.id}` : requestedId
    const jobs = await this.cron.listJobs()
    const current = jobs.find((job) => job.id === jobId && job.agent === agentId)
    if (jobs.some((job) => job.id === jobId && job.agent !== agentId)) {
      throw new Error('AUTO_DREAM_SCHEDULE_TARGET_OWNED_BY_ANOTHER_AGENT')
    }
    const currentText = current ? JSON.stringify(current) : ''
    let desired: import('./cron.js').CronJob | undefined
    if (proposal.action === 'schedule.delete' && !current) {
      return { ok: true, result: 'schedule already deleted' }
    }
    if (proposal.action === 'schedule.upsert') {
      desired = normalizeAutoDreamSchedule(proposal.after, agentId, jobId)
      const desiredText = JSON.stringify(desired)
      if (currentText === desiredText) return { ok: true, result: 'schedule already applied' }
    }
    if (createHash('sha256').update(currentText).digest('hex') !== proposal.beforeFingerprint) {
      return { ok: false, conflict: '该定时任务已在审计后发生变化。' }
    }
    if (proposal.action === 'schedule.delete') {
      await this.cron.removeJob(jobId)
      return { ok: true, result: 'schedule deleted' }
    }
    if (!desired) throw new Error('AUTO_DREAM_SCHEDULE_INVALID')
    await this.cron.addJob(desired)
    return { ok: true, result: 'schedule applied' }
  }
  throw new Error('AUTO_DREAM_ACTION_UNSUPPORTED')
}

/**
 * Auto-Dream paid turn: exact local catalog authority path, but a hermetic
 * CCB process (`--bare --tools "" --strict-mcp-config`) with no ambient
 * persona/repo/memory/skills/MCP/resume context.
 */
export async function _runAutoDreamModel(
  this: AgentHandlersHost,
  input: AutoDreamModelRun,
): Promise<string> {
  const cfg = await this._getAgentsConfig()
  const sourceAgent =
    cfg.agents.find((row) => row.id === input.agentId) ??
    cfg.agents.find((row) => row.id === cfg.default)
  if (!sourceAgent) throw new Error('AUTO_DREAM_AGENT_NOT_FOUND')
  const agent: AgentDef = {
    ...sourceAgent,
    model: input.model,
    provider: undefined,
    runnerKind: undefined,
    persona: undefined,
    mcpServers: [],
    toolsets: [],
  }
  const execution = await resolveLocalExecutionIfEnforced({
    agent,
    kind: 'turn',
    model: input.model,
    defaultModel: this.deps.config.defaults.model,
  })
  if (execution && execution.engine !== 'ccb') throw new Error('AUTO_DREAM_MODEL_NOT_CCB')
  const model = execution?.canonicalModel ?? input.model
  const sessionKey = `auto-dream:${input.attemptId}`
  const session = await this.sessions.getOrCreate({
    sessionKey,
    agent,
    ...localExecutionOverride(execution),
    channel: 'auto-dream',
    peerId: sessionKey,
    userId: input.userId,
    effortLevel: 'medium',
    workload: 'auto-dream',
    hermeticNoTools: true,
    structuredOutputSchema: AUTO_DREAM_PROPOSAL_JSON_SCHEMA,
  })
  const collector = new AutoDreamStructuredOutputCollector()
  try {
    await this.sessions.submit(
      session,
      input.prompt,
      (event) => collector.accept(event),
      'medium',
      model,
    )
    return collector.finish()
  } finally {
    await this.sessions.destroySession(sessionKey).catch(() => {})
  }
}
