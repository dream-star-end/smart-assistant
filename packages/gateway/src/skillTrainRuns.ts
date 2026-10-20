/**
 * Gateway skill training runs: generation session excerpts, training agent, owned run lookup, train events and auto-eval
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-533. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. SkillTrainRunsHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { parseSkillEvalsJson, buildUserSkillStore, paths, searchSessions, loadSessionTurns } from '@openclaude/storage'
import type { SessionStreamEvent } from './ccbMessageParser.js'
import type { SkillTrainRun } from './skillTrainJobs.js'
import { SkillEvalJobStore } from './skillEvalJobs.js'
import { MAX_SESSION_EXCERPTS, SESSION_EXCERPT_MAX_CHARS, buildSessionExcerpt, buildSessionSearchQuery, selectUsageSessionHits, type GenSessionExcerpt } from './skillEvalGen.js'
import { SKILL_TRAIN_DEFAULT_MODEL } from './skillTrain.js'
import { postInboxMessage } from './v3InboxPost.js'
import { buildSkillTrainCompleteNotice } from './ocSkillLocalRelay.js'
import type { Gateway } from './server.js'

export interface SkillTrainRunsHost {
  _getAgentsConfig: Gateway['_getAgentsConfig']
  _maybeAutoEvalTrainRun: Gateway['_maybeAutoEvalTrainRun']
  _runSkillEval: Gateway['_runSkillEval']
  getUserId: Gateway['getUserId']
  log: Gateway['log']
  sendError: Gateway['sendError']
  skillDrafts: Gateway['skillDrafts']
  skillEvalJobs: Gateway['skillEvalJobs']
  skillTrainJobs: Gateway['skillTrainJobs']
}

/**
 * 采集该技能近 30 天真实使用会话的摘录(sessionsDb FTS 既有导出,不 spawn CLI):
 * searchSessions 按 技能名+描述关键词 召回 → 30 天/排除评测训练自身通道过滤 →
 * loadSessionTurns 取每个会话 ≤1500 字符摘录,至多 5 段。任何 DB 异常都降级为空数组
 * (无素材 → 仅 SKILL.md 起草)。
 */
export async function _collectGenSessionExcerpts(this: SkillTrainRunsHost, name: string, description: string): Promise<GenSessionExcerpt[]> {
  const query = buildSessionSearchQuery(name, description)
  if (!query) return []
  let hits: Awaited<ReturnType<typeof searchSessions>>
  try {
    // 多召回一些以吸收 30 天/通道过滤后的损耗。
    hits = await searchSessions(query, MAX_SESSION_EXCERPTS + 5)
  } catch {
    return []
  }
  // 近 30 天 + 排除评测/训练/生成自身通道,取至多 N 个候选(纯逻辑,已单测)。
  const selected = selectUsageSessionHits(hits, Date.now(), MAX_SESSION_EXCERPTS)
  const out: GenSessionExcerpt[] = []
  for (const h of selected) {
    let turns: Awaited<ReturnType<typeof loadSessionTurns>>
    try {
      turns = await loadSessionTurns(h.sessionId)
    } catch {
      continue
    }
    const text = buildSessionExcerpt(turns, SESSION_EXCERPT_MAX_CHARS)
    if (!text) continue
    out.push({ title: h.title, text })
  }
  return out
}

// ── SkillOpt skill-training (async; train → diff → confirm-merge) ──

/** The agent that runs training sessions (default 'main', else the first agent). */
export async function _trainingAgent(this: SkillTrainRunsHost) {
  const cfg = await this._getAgentsConfig()
  return cfg.agents.find((a) => a.id === 'main') ?? cfg.agents[0] ?? null
}

/**
 * Resolve a run-scoped request: the run must exist AND be owned by the caller.
 * Sends 404/403 and returns null on failure. Every run-scoped endpoint (status,
 * drafts, diff, comment, merge, discard) gates on this so a leaked runId cannot be
 * read or mutated across users.
 */
export function _ownedTrainRun(this: SkillTrainRunsHost, req: IncomingMessage, res: ServerResponse, runId: string): SkillTrainRun | null {
  const run = this.skillTrainJobs.get(runId)
  if (!run) {
    this.sendError(res, 404, 'training run not found')
    return null
  }
  if (run.userId !== this.getUserId(req)) {
    this.sendError(res, 403, 'forbidden')
    return null
  }
  return run
}

/**
 * Fold a training session's stream event into the run state. On the agent's `final`
 * event the terminal state is resolved from the ACTUAL staged-draft count (source of
 * truth), not the proposal-call count; other events flow through applyEvent.
 */
export function _onTrainEvent(this: SkillTrainRunsHost, runId: string, e: SessionStreamEvent): void {
  if (e.kind === 'final') {
    void this.skillTrainJobs.addUsage(runId, e.meta, Date.now())
    void this.skillDrafts
      .listDrafts(runId)
      .then(async (d) => {
        await this.skillTrainJobs.finalize(runId, d.length, Date.now())
        // 训练完成 → 写一条站内信(对话内发起训练的用户多半已离开管理中心;前端发起的
        // 也可能已切走)。draft>0 报草稿数并引导看 diff,draft=0 明确「未产生草稿」。
        // fail-open:postInboxMessage 本就永不抛(缺 master env → no-op),这里再挂一层
        // warn,通知失败绝不影响 finalize / autoEval。
        const doneRun = this.skillTrainJobs.get(runId)
        void postInboxMessage(
          buildSkillTrainCompleteNotice(doneRun?.skillName ?? null, d.length),
        ).catch((err) => this.log.warn('skill train complete inbox notify failed', undefined, err))
        // 评测门(P1):产出草稿且用户启动时同意 autoEval → 自动对目标技能草稿跑
        // draft vs 现版评测。成本已在训练确认对话框中披露(autoEval 开关 + 估算)。
        if (d.length > 0) void this._maybeAutoEvalTrainRun(runId)
      })
      .catch(() => {})
    return
  }
  void this.skillTrainJobs.applyEvent(runId, e, Date.now())
}

/** 训练完成后的评测门:仅单技能训练 + autoEval + 有可用用例(草稿附带或技能自带)。 */
export async function _maybeAutoEvalTrainRun(this: SkillTrainRunsHost, trainRunId: string): Promise<void> {
  const tr = this.skillTrainJobs.get(trainRunId)
  if (!tr || !tr.autoEval || !tr.skillName) return
  const draft = await this.skillDrafts.readDraft(trainRunId, tr.skillName).catch(() => null)
  if (!draft || draft.record.op === 'delete') return
  const store = buildUserSkillStore()
  let evalsRaw =
    draft.evalsJson ??
    ((await store.view(tr.skillName, 'evals/evals.json', { includePlatform: false })) as
      | string
      | null)
  if (typeof evalsRaw !== 'string' || !evalsRaw) return // 无用例 → 不评(前端提示补用例)
  const parsed = parseSkillEvalsJson(evalsRaw)
  if (!parsed.ok) return
  const guard = this.skillEvalJobs.canStart(tr.skillName)
  if (!guard.ok) return
  const run = await this.skillEvalJobs.create({
    runId: SkillEvalJobStore.newRunId(),
    skillName: tr.skillName,
    userId: tr.userId,
    mode: 'draft',
    trainRunId,
    model: SKILL_TRAIN_DEFAULT_MODEL,
    cases: parsed.file.cases,
    now: Date.now(),
  })
  await this.skillTrainJobs.setEvalRunId(trainRunId, run.runId, Date.now())
  void this._runSkillEval(run, {
    draftDir: join(paths.skillDraftRunDir(trainRunId), tr.skillName),
  }).catch((err) => {
    void this.skillEvalJobs.finish(run, Date.now(), { error: String(err) })
  })
}
