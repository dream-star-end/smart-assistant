/**
 * Gateway skill / skill-eval / skill-training / release-job handlers
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-471. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. SkillHandlersHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import { resolveRuntimeExecutionAgent } from '@openclaude/storage'
import { saveUserSkill } from './userSkillWrite.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  defaultReleaseJobDir,
  isReleaseJobId,
  publicReleaseJob,
  readReleaseJob,
} from './releaseJobStore.js'
import {
  parseSkillEvalsJson,
  serializeSkillEvals,
  type SkillEvalCase,
  type SkillEvalsFile,
  type AgentsConfig,
  buildAgentSkillStore,
  buildUserSkillStore,
  validateSkillAgentScope,
  paths,
  loadSessionTurns,
} from '@openclaude/storage'
import { isHiddenSystemAgentId } from './agentVisibility.js'
import { SkillTrainJobStore } from './skillTrainJobs.js'
import { type SkillEvalRun, SkillEvalJobStore, armsForMode } from './skillEvalJobs.js'
import {
  type GraderArmInput,
  type SkillEvalCaseResult,
  addUsage,
  buildEvalCasePrompt,
  buildGraderPrompt,
  computeBenchmark,
  emptyUsage,
  gradesToAssertions,
  parseGraderJson,
} from './skillEval.js'
import { SkillEvalGenJobStore, type SkillEvalGenRun } from './skillEvalGenJobs.js'
import {
  SESSION_EXCERPT_MAX_CHARS,
  buildGeneratePrompt,
  buildGenerationNote,
  buildSessionExcerpt,
  finalizeGeneratedCases,
} from './skillEvalGen.js'
import {
  MAX_FEEDBACK_SCENARIOS,
  SKILL_TRAIN_DEFAULT_MODEL,
  SKILL_TRAIN_EFFORT,
  buildFeedbackScenariosSection,
  buildSkillTrainPrompt,
  normalizeSkillTrainArgs,
  type FeedbackScenario,
} from './skillTrain.js'
import { fetchUserSkillFeedbackRefs, type SkillFeedbackRef } from './skillUsageReporter.js'
import { resolveLocalExecutionIfEnforced, localExecutionOverride } from './server.js'
import type { Gateway, LocalExecutionDecision } from './server.js'

export interface SkillHandlersHost {
  _collectGenSessionExcerpts: Gateway['_collectGenSessionExcerpts']
  _collectSkillFeedbackScenarios: Gateway['_collectSkillFeedbackScenarios']
  _getAgentsConfigUserView: Gateway['_getAgentsConfigUserView']
  _mapLocalExecutionError: Gateway['_mapLocalExecutionError']
  _onTrainEvent: Gateway['_onTrainEvent']
  _ownedTrainRun: Gateway['_ownedTrainRun']
  _runSkillEval: Gateway['_runSkillEval']
  _runSkillEvalGen: Gateway['_runSkillEvalGen']
  _skillAutoRegressionTick: Gateway['_skillAutoRegressionTick']
  _skillEvalTurn: Gateway['_skillEvalTurn']
  _skillRegressionTimer: Gateway['_skillRegressionTimer']
  _trainingAgent: Gateway['_trainingAgent']
  cron: Gateway['cron']
  deps: Gateway['deps']
  getUserId: Gateway['getUserId']
  log: Gateway['log']
  readBody: Gateway['readBody']
  readJsonBody: Gateway['readJsonBody']
  sendError: Gateway['sendError']
  sendJson: Gateway['sendJson']
  sessions: Gateway['sessions']
  skillDrafts: Gateway['skillDrafts']
  skillEvalGenJobs: Gateway['skillEvalGenJobs']
  skillEvalJobs: Gateway['skillEvalJobs']
  skillTrainJobs: Gateway['skillTrainJobs']
  syncMarketplaceHubForManagement: Gateway['syncMarketplaceHubForManagement']
  validateSkillAgentScopeInput: Gateway['validateSkillAgentScopeInput']
}

// GET /api/agents/:id/skills — list
export async function handleSkillsList(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
): Promise<void> {
  if (isHiddenSystemAgentId(agentId)) return this.sendError(res, 404, 'agent not found')
  if (req.method !== 'GET') return this.sendError(res, 405, 'method not allowed')
  const identity = await resolveRuntimeExecutionAgent({ id: agentId })
  const store = buildAgentSkillStore(
    identity.agent.id,
    identity.context.assets ? { profile: identity.context.assets.profile } : undefined,
  )
  // User-facing surface: never enumerate platform baseline/seed skills.
  const list = await store.list({ includePlatform: false })
  this.sendJson(res, 200, { skills: list })
}

// GET/PUT/DELETE /api/agents/:id/skills/:name
export async function handleSkillItem(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  skillName: string,
): Promise<void> {
  if (isHiddenSystemAgentId(agentId)) return this.sendError(res, 404, 'agent not found')
  const identity = await resolveRuntimeExecutionAgent({ id: agentId })
  const store = buildAgentSkillStore(
    identity.agent.id,
    identity.context.assets ? { profile: identity.context.assets.profile } : undefined,
  )
  if (req.method === 'GET') {
    // User-facing read: platform skills resolve to 404, never leak their body.
    const v = await store.view(skillName, undefined, { includePlatform: false })
    if (!v || typeof v === 'string') return this.sendError(res, 404, 'skill not found')
    this.sendJson(res, 200, { skill: v })
    return
  }
  if (req.method === 'PUT') {
    const body = await this.readJsonBody<{
      description?: string
      body?: string
      tags?: string[]
    }>(req)
    const r = await store.save(
      { name: skillName, description: body.description ?? '', tags: body.tags },
      body.body ?? '',
    )
    if (!r.ok) return this.sendError(res, 400, r.error ?? 'save failed')
    this.sendJson(res, 200, { ok: true })
    return
  }
  if (req.method === 'DELETE') {
    const r = await store.delete(skillName)
    if (!r.ok) return this.sendError(res, 404, r.error ?? 'delete failed')
    this.sendJson(res, 200, { ok: true })
    return
  }
  this.sendError(res, 405, 'method not allowed')
}

// GET /api/skills — user-level skill library list.
// Aggregates shared + all agents' legacy + marketplace hub (NOT per-agent seed),
// so a user sees one unified "my skills" library regardless of which agent is active.
export async function handleUserSkillsList(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') return this.sendError(res, 405, 'method not allowed')
  await this.syncMarketplaceHubForManagement()
  const store = buildUserSkillStore()
  // User-facing surface: never enumerate platform baseline/seed skills.
  const list = await store.list({ includePlatform: false })
  this.sendJson(res, 200, { skills: list })
}

// PUT/DELETE /api/skills/:name/files — 技能目录内辅助文件的写/删(编辑器)。
// 路径白名单 references/|assets/|evals/|scripts/,单文件≤64KB;evals.json 过 schema。
export async function _handleUserSkillFiles(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  skillName: string,
): Promise<void> {
  const store = buildUserSkillStore()
  const skill = await store.view(skillName, undefined, { includePlatform: false })
  if (!skill || typeof skill === 'string') return this.sendError(res, 404, 'skill not found')
  if (skill.writable !== true) return this.sendError(res, 403, 'skill is read-only')
  const AUX_PREFIXES = ['references/', 'assets/', 'evals/', 'scripts/']
  if (req.method === 'PUT') {
    const body = await this.readJsonBody<{ path?: string; content?: string }>(req)
    const path = (body?.path ?? '').trim()
    const content = body?.content
    if (!path || typeof content !== 'string')
      return this.sendError(res, 400, 'path/content required')
    if (!AUX_PREFIXES.some((p) => path.startsWith(p)))
      return this.sendError(res, 400, `path 须位于 ${AUX_PREFIXES.join(' | ')} 之下`)
    if (Buffer.byteLength(content, 'utf8') > 64 * 1024)
      return this.sendError(res, 400, '单文件上限 64KB')
    if (path === 'evals/evals.json') {
      const parsed = parseSkillEvalsJson(content)
      if (!parsed.ok) {
        this.sendJson(res, 422, { error: 'invalid evals', errors: parsed.errors })
        return
      }
    }
    const r = await store.saveAuxFile(skillName, path, content)
    if (!r.ok) return this.sendError(res, 400, r.error ?? 'save failed')
    this.sendJson(res, 200, { ok: true })
    return
  }
  if (req.method === 'DELETE') {
    const path = new URL(req.url ?? '/', 'http://x').searchParams.get('path') ?? ''
    if (!AUX_PREFIXES.some((p) => path.startsWith(p)))
      return this.sendError(res, 400, 'invalid path')
    const r = await store.deleteAuxFile(skillName, path)
    if (!r.ok) return this.sendError(res, 400, r.error ?? 'delete failed')
    this.sendJson(res, 200, { ok: true })
    return
  }
  this.sendError(res, 405, 'method not allowed')
}

// GET /api/skills/:name/history — 版本历史;POST /api/skills/:name/restore — 恢复。
// 历史/恢复只覆盖 SKILL.md 正文(save() 快照机制),辅助文件不在快照范围。
export async function _handleUserSkillHistory(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  skillName: string,
): Promise<void> {
  if (req.method !== 'GET') return this.sendError(res, 405, 'method not allowed')
  const store = buildUserSkillStore()
  const skill = await store.view(skillName, undefined, { includePlatform: false })
  if (!skill || typeof skill === 'string') return this.sendError(res, 404, 'skill not found')
  this.sendJson(res, 200, {
    history: await store.history(skillName),
    writable: skill.writable === true,
  })
}

export async function _handleUserSkillRestore(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  skillName: string,
): Promise<void> {
  if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
  const store = buildUserSkillStore()
  const skill = await store.view(skillName, undefined, { includePlatform: false })
  if (!skill || typeof skill === 'string') return this.sendError(res, 404, 'skill not found')
  if (skill.writable !== true) return this.sendError(res, 403, 'skill is read-only')
  const body = await this.readJsonBody<{ version?: string }>(req)
  const version = (body?.version ?? '').trim()
  if (!version) return this.sendError(res, 400, 'version required')
  const r = await store.restore(skillName, version)
  if (!r.ok) return this.sendError(res, 400, r.error ?? 'restore failed')
  this.sendJson(res, 200, { ok: true })
}

export async function validateSkillAgentScopeInput(
  this: SkillHandlersHost,
  input: unknown,
): Promise<string[] | { error: string }> {
  const parsed = validateSkillAgentScope(input)
  if (!parsed.ok || !parsed.agentIds) return { error: parsed.error ?? 'invalid agentIds' }
  // 枚举面:走用户可见投影 —— view.agents 已剔除隐藏系统 agent、view.default 已
  // 收敛,故 allowed 集合天然不含隐藏 id(无需再手工 !isHiddenSystemAgentId 过滤)。
  let cfg: AgentsConfig
  try {
    cfg = await this._getAgentsConfigUserView()
  } catch {
    cfg = { agents: [{ id: 'main' }], routes: [], default: 'main' }
  }
  const allowed = new Set<string>(
    ['main', cfg.default, ...(cfg.agents ?? []).map((a) => a.id)].filter(
      (id): id is string => typeof id === 'string',
    ),
  )
  const bad = parsed.agentIds.find((id) => !allowed.has(id))
  if (bad) return { error: `unknown agentId: ${bad}` }
  return parsed.agentIds
}

// GET/PUT/DELETE /api/skills/:name — user-level skill item. Writes/deletes go to
// the shared library (delete also sweeps same-named legacy residue across agents).
export async function handleUserSkillItem(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  skillName: string,
): Promise<void> {
  if (req.method === 'GET') {
    await this.syncMarketplaceHubForManagement()
    const store = buildUserSkillStore()
    // User-facing read: platform skills resolve to 404, never leak their body.
    // ?file=<rel> → 读取技能目录内单个文件(编辑器/整目录发布导入用)。
    const fileParam = new URL(req.url ?? '/', 'http://x').searchParams.get('file')
    if (fileParam) {
      // 目录穿越由 view() 的词法守卫兜底;此处仅挡明显非法与 history/。
      if (
        fileParam.includes('..') ||
        fileParam.startsWith('/') ||
        fileParam.startsWith('history/')
      ) {
        return this.sendError(res, 400, 'invalid file path')
      }
      const content = await store.view(skillName, fileParam, { includePlatform: false })
      if (typeof content !== 'string') return this.sendError(res, 404, 'file not found')
      this.sendJson(res, 200, { path: fileParam, content })
      return
    }
    const v = await store.view(skillName, undefined, { includePlatform: false })
    if (!v || typeof v === 'string') return this.sendError(res, 404, 'skill not found')
    this.sendJson(res, 200, { skill: v })
    return
  }
  const store = buildUserSkillStore()
  if (req.method === 'PUT') {
    const body = await this.readJsonBody<{
      description?: string
      body?: string
      tags?: string[]
      agentIds?: unknown
      createOnly?: unknown
    }>(req)
    const hasDescription = Object.prototype.hasOwnProperty.call(body, 'description')
    const hasBody = Object.prototype.hasOwnProperty.call(body, 'body')
    const hasTags = Object.prototype.hasOwnProperty.call(body, 'tags')
    const hasAgentIds = Object.prototype.hasOwnProperty.call(body, 'agentIds')
    let agentIds: string[] | undefined
    if (hasAgentIds) {
      const scope = await this.validateSkillAgentScopeInput(body.agentIds)
      if (!Array.isArray(scope)) return this.sendError(res, 400, scope.error)
      agentIds = scope
    }
    if (hasAgentIds && !hasDescription && !hasBody && !hasTags) {
      const r = await store.setAgentScope(skillName, agentIds as string[])
      if (!r.ok) return this.sendError(res, 400, r.error ?? 'save failed')
      this.sendJson(res, 200, { ok: true })
      return
    }
    // `createOnly: true` in the body: 412 when the skill already exists
    // (checked and written under one per-name lock; see userSkillWrite.ts).
    // A body field, not If-None-Match: the master's container proxy forwards
    // only a fixed header set.
    const outcome = await saveUserSkill(
      store,
      {
        name: skillName,
        description: body.description ?? '',
        tags: body.tags,
        body: body.body ?? '',
        ...(agentIds ? { agentIds } : {}),
      },
      { createOnly: body.createOnly === true },
    )
    if (outcome.status === 'exists') return this.sendError(res, 412, 'skill already exists')
    if (!outcome.ok) return this.sendError(res, 400, outcome.error ?? 'save failed')
    this.sendJson(res, 200, { ok: true })
    return
  }
  if (req.method === 'DELETE') {
    const r = await store.delete(skillName)
    if (!r.ok) return this.sendError(res, 404, r.error ?? 'delete failed')
    this.sendJson(res, 200, { ok: true })
    return
  }
  this.sendError(res, 405, 'method not allowed')
}

// ── Skill evals(评测:用例文件 CRUD + 隔离双跑 run)──────────────────────
//
// 成本纪律:评测跑真模型、消耗用户积分 —— 启动只经显式 POST(前端有估算+确认
// 对话框),run.usage 逐 turn 累计供前端实报;用例上限(≤5)即成本上限。

/** GET: evals 文件 + 上次结果;PUT: 保存 evals(仅可写技能)。 */
export async function _handleSkillEvalsFile(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  skillName: string,
): Promise<void> {
  const store = buildUserSkillStore()
  // 评测读取面对平台 baseline 技能开放(includePlatform:true):平台技能的 evals 以
  // 源码形式随 ccb-baseline 分发,容器内本就整目录只读可 cat,这里不构成枚举泄露
  // ("用户向列表面禁平台技能"红线针对管理面板枚举);写入(PUT)仍被 writable 门挡住。
  const skill = await store.view(skillName, undefined, { includePlatform: true })
  if (!skill || typeof skill === 'string') return this.sendError(res, 404, 'skill not found')
  if (req.method === 'GET') {
    const raw = await store.view(skillName, 'evals/evals.json', { includePlatform: true })
    let evals: SkillEvalsFile | null = null
    let parseErrors: string[] | undefined
    if (typeof raw === 'string') {
      const parsed = parseSkillEvalsJson(raw)
      if (parsed.ok) evals = parsed.file
      else parseErrors = parsed.errors
    }
    let lastRun: unknown = null
    const lastRaw = await store.view(skillName, 'evals/last-run.json', {
      includePlatform: true,
    })
    if (typeof lastRaw === 'string') {
      try {
        lastRun = JSON.parse(lastRaw)
      } catch {}
    }
    this.sendJson(res, 200, {
      evals,
      parseErrors,
      lastRun,
      writable: skill.writable === true,
    })
    return
  }
  if (req.method === 'PUT') {
    if (skill.writable !== true) return this.sendError(res, 403, 'skill is read-only')
    const body = await this.readBody(req)
    let parsedBody: { evals?: unknown }
    try {
      parsedBody = JSON.parse(body)
    } catch {
      return this.sendError(res, 400, 'invalid JSON')
    }
    const parsed = parseSkillEvalsJson(JSON.stringify(parsedBody.evals ?? null))
    if (!parsed.ok) {
      this.sendJson(res, 422, { error: 'invalid evals', errors: parsed.errors })
      return
    }
    const w = await store.saveAuxFile(
      skillName,
      'evals/evals.json',
      serializeSkillEvals(parsed.file),
    )
    if (!w.ok) return this.sendError(res, 400, w.error ?? 'failed to save evals')
    this.sendJson(res, 200, { ok: true, evals: parsed.file })
    return
  }
  this.sendError(res, 405, 'method not allowed')
}

/** POST /api/skills/:name/eval-run — 启动评测(202 → runId,进度轮询 status)。 */
export async function _handleSkillEvalStart(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  skillName: string,
): Promise<void> {
  if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
  const userId = this.getUserId(req)
  const store = buildUserSkillStore()
  // 平台 baseline 技能允许跑 baseline 评测(canary 回归脚本/用户自查都走这里);
  // draft 模式天然被 train-run 属主校验挡住(训练本就拒平台技能)。
  const skill = await store.view(skillName, undefined, { includePlatform: true })
  if (!skill || typeof skill === 'string') return this.sendError(res, 404, 'skill not found')

  const body = await this.readJsonBody<{ mode?: string; trainRunId?: string }>(req).catch(
    () => ({}) as { mode?: string; trainRunId?: string },
  )
  const mode = body?.mode === 'draft' ? ('draft' as const) : ('baseline' as const)

  // draft 模式:草稿必须存在且属于本用户的训练 run,用草稿携带的用例(如有)覆盖现版用例。
  let draftDir: string | undefined
  let draftEvalsJson: string | undefined
  let trainRunId: string | null = null
  if (mode === 'draft') {
    const trainRun = body?.trainRunId ? this.skillTrainJobs.get(body.trainRunId) : undefined
    if (!trainRun || trainRun.userId !== userId)
      return this.sendError(res, 404, 'training run not found')
    const draft = await this.skillDrafts.readDraft(trainRun.runId, skillName)
    if (!draft || draft.record.op === 'delete')
      return this.sendError(res, 400, 'no evaluable draft for this skill in the training run')
    trainRunId = trainRun.runId
    draftDir = join(paths.skillDraftRunDir(trainRun.runId), skillName)
    draftEvalsJson = draft.evalsJson
  }

  // 用例来源:草稿附带 > 技能自带。没有用例 → 明确 400(而不是空跑烧积分)。
  let evalsRaw =
    draftEvalsJson ??
    ((await store.view(skillName, 'evals/evals.json', { includePlatform: true })) as string | null)
  if (typeof evalsRaw !== 'string') evalsRaw = null
  if (!evalsRaw)
    return this.sendError(res, 400, 'skill has no evals/evals.json — add eval cases first')
  const parsed = parseSkillEvalsJson(evalsRaw)
  if (!parsed.ok) {
    this.sendJson(res, 422, { error: 'invalid evals', errors: parsed.errors })
    return
  }

  const guard = this.skillEvalJobs.canStart(skillName)
  if (!guard.ok) return this.sendError(res, 409, guard.reason ?? 'cannot start eval')

  const run = await this.skillEvalJobs.create({
    runId: SkillEvalJobStore.newRunId(),
    skillName,
    userId,
    mode,
    trainRunId,
    model: SKILL_TRAIN_DEFAULT_MODEL,
    cases: parsed.file.cases,
    now: Date.now(),
  })
  void this._runSkillEval(run, { draftDir }).catch((err) => {
    void this.skillEvalJobs.finish(run, Date.now(), { error: String(err) })
  })
  this.sendJson(res, 202, { ok: true, runId: run.runId })
}

/** GET /api/skill-eval/:runId — run 状态(owner 校验,同训练 run 语义)。 */
export async function _handleSkillEvalRunStatus(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<void> {
  if (req.method !== 'GET') return this.sendError(res, 405, 'method not allowed')
  const run = this.skillEvalJobs.get(runId)
  if (!run) return this.sendError(res, 404, 'eval run not found')
  if (run.userId !== this.getUserId(req)) return this.sendError(res, 403, 'forbidden')
  this.sendJson(res, 200, { run })
}

// ── P1:AI 生成评测用例(异步 job + 轮询;不落库,只回草稿供编辑器审阅保存)──

/**
 * POST /api/skills/:name/evals/generate — 启动一次 AI 生成 run(202 → runId)。
 *   404 = 技能不存在/平台技能(与训练同权威:includePlatform:false → 平台名解析为 null,
 *         避免 403/404 变成平台技能目录的存在性 oracle);
 *   403 = 技能存在但只读(hub/非自建;写不进且会被 sync 覆盖,生成无意义) —— 与 PUT evals
 *         的可写性门同一权威(store.view(...).writable);
 *   409 = 同技能已有生成 or 评测在跑(生成/评测互斥,避免并跑扰乱与重复扣费)。
 */
export async function _handleSkillEvalGenStart(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  skillName: string,
): Promise<void> {
  if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
  const userId = this.getUserId(req)

  // 可写性门(与训练/PUT evals 同权威):includePlatform:false 让平台技能解析为 404,
  // 用户可写技能才放行;hub/只读技能存在但 writable!==true → 403。
  const store = buildUserSkillStore()
  const skill = await store.view(skillName, undefined, { includePlatform: false })
  if (!skill || typeof skill === 'string') return this.sendError(res, 404, 'skill not found')
  if (skill.writable !== true) return this.sendError(res, 403, 'skill is read-only')

  // 生成/评测互斥:同技能不能既生成又评测(各查各 store 的同技能活跃 run)。
  if (
    this.skillEvalGenJobs.activeForSkill(skillName) ||
    this.skillEvalJobs.activeForSkill(skillName)
  ) {
    return this.sendError(
      res,
      409,
      `a generation or eval for "${skillName}" is already in progress`,
    )
  }
  const guard = this.skillEvalGenJobs.canStart(skillName)
  if (!guard.ok) return this.sendError(res, 409, guard.reason ?? 'cannot start generation')

  const run = await this.skillEvalGenJobs.create({
    runId: SkillEvalGenJobStore.newRunId(),
    skillName,
    userId,
    model: SKILL_TRAIN_DEFAULT_MODEL,
    now: Date.now(),
  })
  // fire-and-forget:采集素材 → 生成 turn → 归一化落 job;任何异常都收敛为 job failed。
  void this._runSkillEvalGen(run, {
    skillMd: skill.rawContent,
    description: skill.description ?? '',
  }).catch((err) => {
    void this.skillEvalGenJobs.finishFailed(run, Date.now(), String(err))
  })
  this.sendJson(res, 202, { ok: true, runId: run.runId })
}

/** GET /api/skill-eval-gen/:runId — 生成 run 状态(owner 校验,与评测 run 同语义)。 */
export async function _handleSkillEvalGenStatus(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<void> {
  if (req.method !== 'GET') return this.sendError(res, 405, 'method not allowed')
  const run = this.skillEvalGenJobs.get(runId)
  if (!run) return this.sendError(res, 404, 'generation run not found')
  if (run.userId !== this.getUserId(req)) return this.sendError(res, 403, 'forbidden')
  this.sendJson(res, 200, {
    status: run.status,
    ...(run.status === 'done' ? { cases: run.cases } : {}),
    ...(run.note ? { note: run.note } : {}),
    usage: run.usage,
  })
}

/** GET /api/v5/release-jobs/:id — hydrate the in-chat release card after refresh. */
export function _handleReleaseJobStatus(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): void {
  // biome-ignore lint/correctness/noVoidTypeReturn: moved verbatim from server.ts (OCV5-471); pre-existing there
  if (req.method !== 'GET') return this.sendError(res, 405, 'method not allowed')
  // biome-ignore lint/correctness/noVoidTypeReturn: moved verbatim from server.ts (OCV5-471); pre-existing there
  if (!isReleaseJobId(id)) return this.sendError(res, 400, 'invalid release job id')
  this.getUserId(req)
  const job = readReleaseJob(defaultReleaseJobDir(), id)
  // biome-ignore lint/correctness/noVoidTypeReturn: moved verbatim from server.ts (OCV5-471); pre-existing there
  if (!job) return this.sendError(res, 404, 'release job not found')
  this.sendJson(res, 200, publicReleaseJob(job))
}

/** 生成编排:采集素材 → 单个隔离 turn(deepseek,正常计费)→ 宽容解析+归一化+过格式权威。 */
export async function _runSkillEvalGen(
  this: SkillHandlersHost,
  run: SkillEvalGenRun,
  input: { skillMd: string; description: string },
): Promise<void> {
  // 现有用例(补充生成的去重锚 + id 归一化避让);读不到按空处理。
  let existingCases: SkillEvalCase[] = []
  const store = buildUserSkillStore()
  const rawEvals = await store
    .view(run.skillName, 'evals/evals.json', { includePlatform: false })
    .catch(() => null)
  if (typeof rawEvals === 'string') {
    const parsedExisting = parseSkillEvalsJson(rawEvals)
    if (parsedExisting.ok) existingCases = parsedExisting.file.cases
  }

  const excerpts = await this._collectGenSessionExcerpts(run.skillName, input.description)
  const prompt = buildGeneratePrompt({
    skillName: run.skillName,
    description: input.description,
    skillMd: input.skillMd,
    existingCases,
    excerpts,
  })

  // 单 turn 无工具:素材已在 prompt 里,隔离一次性会话(同 _skillEvalTurn 形态,正常计费)。
  const { text, usage } = await this._skillEvalTurn(
    `skillevalgen:${run.runId}`,
    run.userId,
    prompt,
    run.model,
    {},
  )
  addUsage(run.usage, usage)

  const finalized = finalizeGeneratedCases(text, existingCases)
  if (!finalized.ok) {
    await this.skillEvalGenJobs.finishFailed(run, Date.now(), finalized.error)
    return
  }
  const note = buildGenerationNote({
    excerptCount: excerpts.length,
    existingCount: existingCases.length,
    generatedCount: finalized.cases.length,
  })
  await this.skillEvalGenJobs.finishDone(run, Date.now(), { cases: finalized.cases, note })
}

export type SkillEvalTurnOpts = {
    skillEvalExclude?: string
    skillEvalDraft?: { name: string; dir: string }
  }

/** 跑一个被测/评分 turn:一次性会话,收最终文本+用量,完了销毁会话释放资源。 */
export async function _skillEvalTurn(
  this: SkillHandlersHost,
  sessionKey: string,
  userId: string,
  prompt: string,
  model: string,
  opts: SkillEvalTurnOpts,
): Promise<{
  text: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  }
}> {
  const agent = await this._trainingAgent()
  if (!agent) throw new Error('no agent available for eval')
  // 模型权威 §3:skill-eval 是**真实计费的本地 turn**(无 envelope)→ kind='turn'
  // (codex 意图不降级、直接结构化拒:换个模型跑分等于换了被测对象)。
  const evalExec = await resolveLocalExecutionIfEnforced({
    catalog: this.sessions.runtime?.catalog,
    agent,
    kind: 'turn',
    model,
    defaultModel: this.deps.config.defaults.model,
  })
  const evalModel = evalExec?.canonicalModel ?? model
  const session = await this.sessions.getOrCreate({
    // flag 未开 → localExecutionOverride 展开为 {},**不带 model** —— 与改造前逐字
    // 一致(spawn 用 agent.model,submit 再按 run.model 覆盖)。零行为变化。
    sessionKey,
    agent,
    ...localExecutionOverride(evalExec),
    channel: 'skill-eval',
    peerId: sessionKey,
    userId,
    effortLevel: 'high',
    workload: 'skill-eval',
    skillEvalMode: true,
    skillEvalExclude: opts.skillEvalExclude,
    skillEvalDraft: opts.skillEvalDraft,
  })
  try {
    return await new Promise((resolvePromise, rejectPromise) => {
      // 文本块按 blockId 聚合(同 block 流式覆盖,不同 block 顺序拼接)。
      const texts = new Map<string, string>()
      const order: string[] = []
      this.sessions
        .submit(
          session,
          prompt,
          (e) => {
            if (e.kind === 'block' && e.block.kind === 'text' && typeof e.block.text === 'string') {
              // parser 发出的 text 是**增量片段**(内部才做累计),按 messageId 拼接。
              const id = e.block.messageId ?? 'b0'
              if (!texts.has(id)) order.push(id)
              texts.set(id, (texts.get(id) ?? '') + e.block.text)
            } else if (e.kind === 'final') {
              const text = order
                .map((id) => texts.get(id) ?? '')
                .join('\n')
                .trim()
              resolvePromise({ text, usage: e.meta })
            } else if (e.kind === 'error') {
              rejectPromise(new Error(e.error))
            }
          },
          'high',
          // getOrCreate 与 submit 的模型**同源**(flag 未开时 evalModel === model)。
          evalModel,
        )
        .catch(rejectPromise)
    })
  } finally {
    // 评测会话一次性:立即销毁,释放子进程/pids;失败不影响结果。
    await this.sessions.destroySession(sessionKey).catch(() => {})
  }
}

/** 评测编排:逐 case 逐 arm 隔离跑 → 每 case 一个匿名 grader turn → benchmark。 */
export async function _runSkillEval(
  this: SkillHandlersHost,
  run: SkillEvalRun,
  opts: { draftDir?: string },
): Promise<void> {
  run.status = 'running'
  await this.skillEvalJobs.touch(run, Date.now())
  const arms = armsForMode(run.mode)
  const preferences: Array<'draft' | 'current' | 'tie'> = []

  for (const c of run.cases) {
    const armOutputs: Array<{ arm: (typeof arms)[number]; result: SkillEvalCaseResult }> = []
    for (const arm of arms) {
      const sessionKey = `skilleval:${run.runId}:${c.id}:${arm}`
      const result: SkillEvalCaseResult = {
        caseId: c.id,
        arm,
        output: '',
        usage: emptyUsage(),
        assertions: [],
      }
      try {
        const { text, usage } = await this._skillEvalTurn(
          sessionKey,
          run.userId,
          buildEvalCasePrompt(c),
          run.model,
          {
            skillEvalExclude: arm === 'without' ? run.skillName : undefined,
            skillEvalDraft:
              arm === 'draft' && opts.draftDir
                ? { name: run.skillName, dir: opts.draftDir }
                : undefined,
          },
        )
        result.output = text.slice(0, 20_000)
        addUsage(result.usage, usage)
        addUsage(run.usage, usage)
      } catch (err) {
        result.error = String(err)
      }
      run.results.push(result)
      armOutputs.push({ arm, result })
      run.progress.done++
      await this.skillEvalJobs.touch(run, Date.now())
    }

    // grading(仅对无 error 的输出;全挂就跳过本 case)
    const gradable = armOutputs.filter((a) => !a.result.error)
    if (gradable.length === 0) continue
    run.status = 'grading'
    await this.skillEvalJobs.touch(run, Date.now())
    // 匿名化 + 随机顺序(盲测防位置偏好)。label→arm 映射只在本进程内存。
    const shuffled = [...gradable].sort(() => Math.random() - 0.5)
    const labels = ['A', 'B', 'C']
    const graderArms: GraderArmInput[] = shuffled.map((a, i) => ({
      label: labels[i],
      output: a.result.output,
    }))
    try {
      const { text: gradeText, usage: gradeUsage } = await this._skillEvalTurn(
        `skilleval:${run.runId}:grade:${c.id}`,
        run.userId,
        buildGraderPrompt(c, graderArms, {
          wantPreference: run.mode === 'draft' && gradable.length >= 2,
        }),
        run.model,
        {},
      )
      addUsage(run.usage, gradeUsage)
      const parsed = parseGraderJson(gradeText)
      if (!parsed) {
        for (const a of gradable) a.result.error = 'grader output unparseable'
      } else {
        shuffled.forEach((a, i) => {
          a.result.assertions = gradesToAssertions(c, parsed.grades[labels[i]])
        })
        if (parsed.preference && run.mode === 'draft') {
          const idx = parsed.preference === 'tie' ? -1 : labels.indexOf(parsed.preference)
          if (idx === -1) preferences.push('tie')
          else preferences.push(shuffled[idx]?.arm === 'draft' ? 'draft' : 'current')
        }
      }
    } catch (err) {
      for (const a of gradable) a.result.error = `grading failed: ${String(err)}`
    }
    run.status = 'running'
    await this.skillEvalJobs.touch(run, Date.now())
  }

  const benchmark = computeBenchmark(run.results, {
    draftMode: run.mode === 'draft',
    preferences,
  })
  await this.skillEvalJobs.finish(run, Date.now(), { benchmark })

  // 可写技能:落 evals/last-run.json 摘要(面板即开即见;draft 模式不写 —— 未合并)。
  if (run.mode === 'baseline') {
    const store = buildUserSkillStore()
    await store
      .saveAuxFile(
        run.skillName,
        'evals/last-run.json',
        `${JSON.stringify(
          {
            runId: run.runId,
            mode: run.mode,
            finishedAt: run.finishedAt,
            benchmark,
            usage: run.usage,
          },
          null,
          2,
        )}\n`,
      )
      .catch(() => {})
  }
}

export function _startSkillAutoRegression(this: SkillHandlersHost): void {
  // 检查间隔 1h(可 env 缩短供 e2e),真正执行按「距上次 ≥22h」判定 —— 每技能每日至多一轮。
  const checkMs = Number(process.env.OC_SKILL_REGRESSION_CHECK_MS) || 60 * 60 * 1000
  const minGapMs = Number(process.env.OC_SKILL_REGRESSION_MIN_GAP_MS) || 22 * 60 * 60 * 1000
  this._skillRegressionTimer = setInterval(() => {
    void this._skillAutoRegressionTick(minGapMs).catch((err) =>
      this.log.warn('skill auto-regression tick failed', {}, err),
    )
  }, checkMs)
  this._skillRegressionTimer.unref?.()
}

export async function _skillAutoRegressionTick(
  this: SkillHandlersHost,
  minGapMs: number,
): Promise<void> {
  const stampPath = join(paths.skillEvalsDir, 'auto-regression.json')
  let stamps: Record<string, number> = {}
  try {
    stamps = JSON.parse(await readFile(stampPath, 'utf-8')) as Record<string, number>
  } catch {}
  const store = buildUserSkillStore()
  const skills = await store.list({ includePlatform: false }).catch(() => [])
  for (const sk of skills) {
    if (!sk?.name) continue
    const raw = await store.view(sk.name, 'evals/evals.json', { includePlatform: false })
    if (typeof raw !== 'string') continue
    const parsed = parseSkillEvalsJson(raw)
    if (!parsed.ok || parsed.file.autoRegression !== true) continue
    const last = stamps[sk.name] ?? 0
    if (Date.now() - last < minGapMs) continue
    if (!this.skillEvalJobs.canStart(sk.name).ok) continue

    // 记录上一次通过率(回归对比基线);本轮结果由 _runSkillEval 写回 last-run.json。
    let prevWith: number | null = null
    const prevRaw = await store.view(sk.name, 'evals/last-run.json', { includePlatform: false })
    if (typeof prevRaw === 'string') {
      try {
        const prev = JSON.parse(prevRaw) as { benchmark?: { passRate?: { with?: number } } }
        prevWith = prev.benchmark?.passRate?.with ?? null
      } catch {}
    }

    stamps[sk.name] = Date.now()
    await mkdir(paths.skillEvalsDir, { recursive: true }).catch(() => {})
    await writeFile(stampPath, JSON.stringify(stamps, null, 2)).catch(() => {})

    const run = await this.skillEvalJobs.create({
      runId: SkillEvalJobStore.newRunId(),
      skillName: sk.name,
      // 'default' 即容器内 HTTP 侧的归属权威:商业代理刻意不转发 auth 头
      // (containerApiProxy FORWARD_REQUEST_HEADERS),getUserId 对代理请求恒为
      // 'default' —— 后台定时 run 用同值才能过 owner 校验,别改成别的。
      userId: 'default',
      mode: 'baseline',
      model: SKILL_TRAIN_DEFAULT_MODEL,
      cases: parsed.file.cases,
      now: Date.now(),
    })
    try {
      await this._runSkillEval(run, {})
    } catch (err) {
      await this.skillEvalJobs.finish(run, Date.now(), { error: String(err) })
    }

    const b = run.benchmark
    const withRate = b?.passRate?.with
    const failed = run.status === 'failed'
    const regressed =
      failed ||
      (b?.verdict ?? '').includes('反而更差') ||
      (prevWith !== null && withRate !== undefined && withRate < prevWith - 0.05)
    if (!regressed) continue

    // 推送提醒(不自动改技能、不自动开训练 —— 修复动作由用户在管理中心发起)。
    const pct = (x?: number | null) => (x == null ? '?' : `${Math.round(x * 100)}%`)
    const lines = [
      failed
        ? `自动回归运行失败:${run.error ?? '未知错误'}`
        : `断言通过率 ${pct(prevWith)} → ${pct(withRate)}${b?.verdict ? `(${b.verdict})` : ''}`,
      `本次回归消耗:输入 ${run.usage.inputTokens.toLocaleString()} / 输出 ${run.usage.outputTokens.toLocaleString()} tokens(${run.usage.turns} 轮,实际扣费以账单为准)`,
      '建议:打开 管理中心 → 技能 → 该技能 → 训练优化,让 AI 基于失败结果起草改进(草稿经你确认才会合并)。',
      '不再需要提醒可在 管理中心 → 技能 → 评测 里关闭「每日自动回归」。',
    ]
    await this.cron
      ?.deliverNotice(lines.join('\n'), {
        id: `skill-regression-${sk.name}`,
        schedule: '0 0 * * *',
        agent: 'main',
        prompt: '',
        deliver: 'webchat',
        enabled: true,
        label: `技能回归提醒:${sk.name}`,
      })
      .catch(() => {})
  }
}

// POST /api/skills/:name/train — start an async DeepSeek training run for ONE
// user-authored skill. Returns a runId immediately; progress via GET status.
/**
 * 采集「用户对该技能差评过的真实场景」摘录(供技能训练注入失败案例小节):
 *  1) GET master skill-feedback?slug=&layer=user(容器 token 通道,已内建 fail-open);
 *  2) 有 refs → 按 sessionKey 从**本地** sessions.db 取 turns(复用 P1 buildSessionExcerpt
 *     裁成 ≤1500 字符摘录),至多 MAX_FEEDBACK_SCENARIOS 段。
 * 返回 `{scenarios, total}`:scenarios=实际注入的摘录;total=master 未截断的差评总数
 * (DISTINCT session_key,供前端"已找到 N 条"提示)。任何环节失败/无数据 → `{[], 0}`
 * (训练照常,不注入失败案例小节)。内容主权不出容器:master 只回引用,摘录本体由本地 DB 组装。
 */
export async function _collectSkillFeedbackScenarios(
  this: SkillHandlersHost,
  skillName: string,
): Promise<{ scenarios: FeedbackScenario[]; total: number }> {
  let feedback: { refs: SkillFeedbackRef[]; total: number }
  try {
    // 拉取有界超时(fail-open):不让 master 慢响应拖住训练启动。
    feedback = await fetchUserSkillFeedbackRefs(skillName, { timeoutMs: 5_000 })
  } catch {
    return { scenarios: [], total: 0 } // 已 fail-open,这里再兜底一层绝不上抛
  }
  if (feedback.refs.length === 0) return { scenarios: [], total: 0 }
  const scenarios: FeedbackScenario[] = []
  for (const ref of feedback.refs) {
    if (scenarios.length >= MAX_FEEDBACK_SCENARIOS) break
    let turns: Awaited<ReturnType<typeof loadSessionTurns>>
    try {
      // sessions_meta.id / sessions_fts.session_id == sessionKey(sessionManager
      // indexTurn 用 session.sessionKey 作 FTS 主键),故 loadSessionTurns 直接吃 sessionKey。
      turns = await loadSessionTurns(ref.sessionKey)
    } catch {
      continue
    }
    const text = buildSessionExcerpt(turns, SESSION_EXCERPT_MAX_CHARS)
    if (!text) continue // 会话已归档/清理 → 跳过该 ref
    scenarios.push({ text })
  }
  return { scenarios, total: feedback.total }
}

export async function _handleSkillTrainStart(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  skillName: string,
): Promise<void> {
  if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
  const userId = this.getUserId(req)

  // Authority: only train user-authored skills. Use the user-management view so a
  // platform baseline/seed name resolves to 404 (same as a nonexistent skill) instead
  // of 403 — otherwise the 403/404 split would be an existence oracle for the
  // (otherwise hidden) platform skill catalog.
  const userStore = buildUserSkillStore()
  const current = await userStore.view(skillName, undefined, { includePlatform: false })
  if (!current || typeof current === 'string') return this.sendError(res, 404, 'skill not found')

  const guard = this.skillTrainJobs.canStart(skillName)
  if (!guard.ok) return this.sendError(res, 409, guard.reason ?? 'cannot start training')

  const agent = await this._trainingAgent()
  if (!agent) return this.sendError(res, 500, 'no agent available for training')

  const body = await this.readJsonBody<{ focus?: string; autoEval?: boolean }>(req).catch(
    () => ({}) as { focus?: string; autoEval?: boolean },
  )
  const runId = SkillTrainJobStore.newRunId()
  const opts = normalizeSkillTrainArgs(
    { runId, targetSkill: skillName, focus: body?.focus },
    agent.id,
  )
  await this.skillTrainJobs.create({
    runId,
    skillName,
    agentId: agent.id,
    userId,
    model: SKILL_TRAIN_DEFAULT_MODEL,
    effort: SKILL_TRAIN_EFFORT,
    autoEval: body?.autoEval !== false,
    now: Date.now(),
  })

  // 差评驱动:起训前拉「用户对该技能差评过的真实使用记录」→ 按 sessionKey 从本地
  // sessions.db 取摘录,注入训练 prompt 的失败案例小节。整链 fail-open:任一步失败/无
  // 数据都返回空 → 照常训练(feedbackRefs=0),绝不影响训练启动。
  const { scenarios: feedbackScenarios, total: feedbackTotal } =
    await this._collectSkillFeedbackScenarios(skillName)
  const feedbackSection = buildFeedbackScenariosSection(feedbackScenarios)
  // feedbackRefs:仅当确有素材注入训练时才回传 master 的未截断差评总数(前端"已找到 N 条")。
  // 差评存在但摘录全部拉不到(会话已清理)→ 无注入 → 0(不误报"将优先分析")。
  const feedbackRefs = feedbackScenarios.length > 0 ? feedbackTotal : 0

  // 模型权威 §3:skill-train 是**真实计费的本地 turn**(无 envelope)→ kind='turn'。
  // 投影不可用 / 模型不可用 / codex 意图 → 结构化拒(HTTP 4xx/503),不 spawn runner。
  let trainExec: LocalExecutionDecision | undefined
  try {
    trainExec = await resolveLocalExecutionIfEnforced({
      catalog: this.sessions.runtime?.catalog,
      agent,
      kind: 'turn',
      model: SKILL_TRAIN_DEFAULT_MODEL,
      defaultModel: this.deps.config.defaults.model,
    })
  } catch (err) {
    const mapped = this._mapLocalExecutionError(err)
    if (!mapped) throw err
    await this.skillTrainJobs.setStatus(runId, 'failed', Date.now(), mapped.message)
    return this.sendError(res, mapped.httpStatus, mapped.message)
  }
  const trainModel = trainExec?.canonicalModel ?? SKILL_TRAIN_DEFAULT_MODEL
  // Background session bound to this run (skillTrainRunId exposes skill_propose).
  const session = await this.sessions.getOrCreate({
    sessionKey: `skilltrain:${runId}`,
    agent,
    ...localExecutionOverride(trainExec),
    channel: 'skill-train',
    peerId: runId,
    userId,
    effortLevel: SKILL_TRAIN_EFFORT,
    skillTrainRunId: runId,
  })
  // Fire-and-forget: fold stream events into the run state; don't block the HTTP reply.
  void this.sessions
    .submit(
      session,
      buildSkillTrainPrompt(opts, new Date(), feedbackSection),
      (e) => this._onTrainEvent(runId, e),
      SKILL_TRAIN_EFFORT,
      trainModel,
      runId,
    )
    .catch((err) => {
      void this.skillTrainJobs.setStatus(runId, 'failed', Date.now(), String(err))
    })
  this.sendJson(res, 202, { ok: true, runId, feedbackRefs })
}

// GET /api/skill-training — 当前用户的训练 run 列表(startedAt 降序)。归属权威与
// _ownedTrainRun 同一来源(getUserId):runId 不再只活在前端组件 state 里,刷新页面 /
// gateway 重启后前端凭此找回 running(续轮询)或 diff_ready(续合并/修订)的 run。
export async function _handleSkillTrainList(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') return this.sendError(res, 405, 'method not allowed')
  this.sendJson(res, 200, { runs: this.skillTrainJobs.list(this.getUserId(req)) })
}

// GET /api/skill-training/:runId — run status. DELETE — discard run + its drafts.
export async function _handleSkillTrainRun(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<void> {
  const run = this._ownedTrainRun(req, res, runId)
  if (!run) return
  if (req.method === 'GET') {
    this.sendJson(res, 200, { run })
    return
  }
  if (req.method === 'DELETE') {
    await this.skillDrafts.deleteRun(runId)
    await this.skillTrainJobs.setStatus(runId, 'discarded', Date.now())
    this.skillTrainJobs.forget(runId)
    this.sendJson(res, 200, { ok: true })
    return
  }
  this.sendError(res, 405, 'method not allowed')
}

// GET /api/skill-training/:runId/drafts — list staged draft summaries.
export async function _handleSkillTrainDrafts(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<void> {
  if (req.method !== 'GET') return this.sendError(res, 405, 'method not allowed')
  if (!this._ownedTrainRun(req, res, runId)) return
  const drafts = await this.skillDrafts.listDrafts(runId)
  this.sendJson(res, 200, { drafts })
}

// GET /api/skill-training/:runId/drafts/:name — draft + current authoritative
// (the two diff sides). PUT — apply a manual user edit to the draft.
export async function _handleSkillTrainDraftItem(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  skillName: string,
): Promise<void> {
  if (!this._ownedTrainRun(req, res, runId)) return
  if (req.method === 'GET') {
    const draft = await this.skillDrafts.readDraft(runId, skillName)
    if (!draft) return this.sendError(res, 404, 'draft not found')
    const cur = await buildUserSkillStore().view(skillName, undefined, { includePlatform: false })
    const current =
      cur && typeof cur !== 'string'
        ? { body: cur.body, description: cur.description, version: cur.version }
        : null
    this.sendJson(res, 200, { draft, current })
    return
  }
  if (req.method === 'PUT') {
    const existing = await this.skillDrafts.readDraft(runId, skillName)
    if (!existing) return this.sendError(res, 404, 'draft not found')
    const body = await this.readJsonBody<{
      description?: string
      body?: string
      tags?: string[]
    }>(req)
    const r = await this.skillDrafts.writeDraft({
      runId,
      op: existing.record.op,
      meta: {
        name: skillName,
        description: body.description ?? existing.meta.description,
        tags: body.tags ?? existing.meta.tags,
      },
      body: body.body ?? existing.body,
      authoredBy: 'user',
    })
    if (!r.ok) return this.sendError(res, 400, r.error ?? 'save failed')
    this.sendJson(res, 200, { ok: true })
    return
  }
  this.sendError(res, 405, 'method not allowed')
}

// POST /api/skill-training/:runId/drafts/:name/comment — user comment → AI revises
// the draft by continuing the SAME training session (async; status returns to running).
export async function _handleSkillTrainComment(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  skillName: string,
): Promise<void> {
  if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
  const run = this._ownedTrainRun(req, res, runId)
  if (!run) return
  const body = await this.readJsonBody<{ comment: string; lineRange?: string }>(req)
  const comment = (body?.comment ?? '').trim()
  if (!comment) return this.sendError(res, 400, 'comment required')
  const agent = await this._trainingAgent()
  if (!agent) return this.sendError(res, 500, 'no agent available')

  const where = body.lineRange ? ` (lines ${body.lineRange})` : ''
  const revisePrompt = [
    `The user reviewed your draft for skill "${skillName}"${where} and commented:`,
    '',
    comment,
    '',
    `Revise the draft accordingly: re-issue skill_propose (runId="${runId}") with the`,
    'improved content addressing the comment. Keep all prior good content; change only',
    'what the comment asks for.',
  ].join('\n')

  // 模型权威 §3:同 skill-train 起训(本地 turn)。
  let reviseExec: LocalExecutionDecision | undefined
  try {
    reviseExec = await resolveLocalExecutionIfEnforced({
      catalog: this.sessions.runtime?.catalog,
      agent,
      kind: 'turn',
      model: SKILL_TRAIN_DEFAULT_MODEL,
      defaultModel: this.deps.config.defaults.model,
    })
  } catch (err) {
    const mapped = this._mapLocalExecutionError(err)
    if (!mapped) throw err
    return this.sendError(res, mapped.httpStatus, mapped.message)
  }
  const reviseModel = reviseExec?.canonicalModel ?? SKILL_TRAIN_DEFAULT_MODEL
  const session = await this.sessions.getOrCreate({
    sessionKey: `skilltrain:${runId}`,
    agent,
    ...localExecutionOverride(reviseExec),
    channel: 'skill-train',
    peerId: runId,
    userId: run.userId,
    effortLevel: SKILL_TRAIN_EFFORT,
    skillTrainRunId: runId,
  })
  await this.skillTrainJobs.reopen(runId, Date.now())
  void this.sessions
    .submit(
      session,
      revisePrompt,
      (e) => this._onTrainEvent(runId, e),
      SKILL_TRAIN_EFFORT,
      reviseModel,
      runId,
    )
    .catch((err) => {
      void this.skillTrainJobs.setStatus(runId, 'failed', Date.now(), String(err))
    })
  this.sendJson(res, 202, { ok: true, runId })
}

// POST /api/skill-training/:runId/merge — promote draft(s) into the AUTHORITATIVE
// library (the only write to live skills). Body {name?} merges one, else all.
export async function _handleSkillTrainMerge(
  this: SkillHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<void> {
  if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
  const run = this._ownedTrainRun(req, res, runId)
  if (!run) return
  if (run.status !== 'diff_ready') {
    return this.sendError(res, 409, `run is not ready to merge (status: ${run.status})`)
  }
  const body = await this.readJsonBody<{ name?: string }>(req).catch(
    () => ({}) as { name?: string },
  )
  const all = await this.skillDrafts.listDrafts(runId)
  const targets = body?.name ? all.filter((d) => d.name === body.name) : all
  if (targets.length === 0) return this.sendError(res, 404, 'no drafts to merge')

  const store = buildUserSkillStore()
  const results: Array<{ name: string; ok: boolean; error?: string }> = []
  for (const t of targets) {
    const draft = await this.skillDrafts.readDraft(runId, t.name)
    if (!draft) {
      results.push({ name: t.name, ok: false, error: 'draft vanished' })
      continue
    }
    const r =
      draft.record.op === 'delete'
        ? await store.delete(t.name)
        : await store.save(
            { name: t.name, description: draft.meta.description, tags: draft.meta.tags },
            draft.body,
          )
    // 草稿携带的评测用例随合并落库(evals/evals.json)—— 训练闭环的验收基准。
    if (r.ok && draft.record.op !== 'delete' && draft.evalsJson) {
      await store.saveAuxFile(t.name, 'evals/evals.json', draft.evalsJson).catch(() => {})
    }
    results.push({ name: t.name, ok: r.ok, error: r.error })
    if (r.ok) await this.skillDrafts.deleteDraft(runId, t.name)
  }

  // All drafts consumed → close the run; otherwise leave it for a retry.
  const remaining = await this.skillDrafts.listDrafts(runId)
  if (remaining.length === 0) {
    await this.skillTrainJobs.setStatus(runId, 'merged', Date.now())
    this.skillTrainJobs.forget(runId)
  }
  this.sendJson(res, 200, { ok: results.every((r) => r.ok), results })
}
