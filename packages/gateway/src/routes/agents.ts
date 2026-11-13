/**
 * Agent routes (agents, persona, memory, auto-dream optimizer, skills, skill eval/training, release jobs, messaging, delegate, advisor, ask-user, collaboration config)
 *
 * Ordered route table moved out of Gateway._handleHttpAfterCommercial (FINDINGS §7.5 step 2b,
 * OCV5-468). Each entry's match is the original branch condition and its handler the original
 * branch body (`return` → `return true`; a branch that falls through returns false; `path` /
 * `method` are the method's own `url.pathname` / `req.method ?? 'GET'` copies), so dispatchRoutes()
 * over this table behaves exactly like the if-chain it replaces. The Gateway dispatches it at the spot
 * the inline block used to be. Order matters: the first entry whose handler returns true wins.
 *
 * Dependencies are the narrow AgentRoutesIo below instead of the whole Gateway (read-only Gateway fields are
 * exposed as getters). Equivalence with the original chain: __tests__/httpRouteTables.test.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { type HttpRoute, predicateRoute, regexRoute } from './routeTable.js'

export interface AgentRoutesIo {
  _handleReleaseJobStatus(req: IncomingMessage, res: ServerResponse, id: string): void
  _handleSkillEvalGenStart(
    req: IncomingMessage,
    res: ServerResponse,
    skillName: string,
  ): Promise<void>
  _handleSkillEvalGenStatus(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void>
  _handleSkillEvalRunStatus(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void>
  _handleSkillEvalStart(req: IncomingMessage, res: ServerResponse, skillName: string): Promise<void>
  _handleSkillEvalsFile(req: IncomingMessage, res: ServerResponse, skillName: string): Promise<void>
  _handleSkillTrainComment(
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
    skillName: string,
  ): Promise<void>
  _handleSkillTrainDraftItem(
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
    skillName: string,
  ): Promise<void>
  _handleSkillTrainDrafts(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void>
  _handleSkillTrainList(req: IncomingMessage, res: ServerResponse): Promise<void>
  _handleSkillTrainMerge(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void>
  _handleSkillTrainRun(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void>
  _handleSkillTrainStart(
    req: IncomingMessage,
    res: ServerResponse,
    skillName: string,
  ): Promise<void>
  _handleUserSkillFiles(req: IncomingMessage, res: ServerResponse, skillName: string): Promise<void>
  _handleUserSkillHistory(
    req: IncomingMessage,
    res: ServerResponse,
    skillName: string,
  ): Promise<void>
  _handleUserSkillRestore(
    req: IncomingMessage,
    res: ServerResponse,
    skillName: string,
  ): Promise<void>
  handleAgentItem(req: IncomingMessage, res: ServerResponse, id: string): Promise<void>
  handleAgentMessage(
    req: IncomingMessage,
    res: ServerResponse,
    targetAgentId: string,
  ): Promise<void>
  handleAgentsCollection(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleAutoDreamOptimizer(
    req: IncomingMessage,
    res: ServerResponse,
    agentId: string,
  ): Promise<void>
  handleAutoDreamOptimizerCancel(
    req: IncomingMessage,
    res: ServerResponse,
    agentId: string,
  ): Promise<void>
  handleAutoDreamOptimizerProposal(
    req: IncomingMessage,
    res: ServerResponse,
    agentId: string,
    proposalId: string,
    action: 'apply' | 'dismiss',
  ): Promise<void>
  handleAutoDreamReport(req: IncomingMessage, res: ServerResponse, agentId: string): Promise<void>
  handleCollaborationConfig(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>
  handleConsultAdvisor(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleDelegateTask(
    req: IncomingMessage,
    res: ServerResponse,
    targetAgentId: string,
  ): Promise<void>
  handleDelegateWait(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleEngineAskUser(
    req: IncomingMessage,
    res: ServerResponse,
    targetAgentId: string,
  ): Promise<void>
  handleMemory(
    req: IncomingMessage,
    res: ServerResponse,
    agentId: string,
    target: 'memory' | 'user',
  ): Promise<void>
  handleMemoryFile(
    req: IncomingMessage,
    res: ServerResponse,
    agentId: string,
    file: string,
  ): Promise<void>
  handleMemoryUsage(
    req: IncomingMessage,
    res: ServerResponse,
    agentId: string,
    url: URL,
  ): Promise<void>
  handleMemoryContext(req: IncomingMessage, res: ServerResponse, agentId: string): Promise<void>
  handlePersona(req: IncomingMessage, res: ServerResponse, id: string): Promise<void>
  handleSkillItem(
    req: IncomingMessage,
    res: ServerResponse,
    agentId: string,
    skillName: string,
  ): Promise<void>
  handleSkillsList(req: IncomingMessage, res: ServerResponse, agentId: string): Promise<void>
  handleUserSkillItem(req: IncomingMessage, res: ServerResponse, skillName: string): Promise<void>
  handleUserSkillsList(req: IncomingMessage, res: ServerResponse): Promise<void>
  sendInternalError(res: ServerResponse, err: unknown): void
}

export const AGENT_ROUTES: readonly HttpRoute<AgentRoutesIo>[] = [
  predicateRoute(
    '/api/agents',
    (_req, url) => url.pathname === '/api/agents',
    (io, req, res, _url) => {
      io.handleAgentsCollection(req, res).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  regexRoute(
    '/api/agents/:1',
    (_req, url) => url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)$/),
    (io, req, res, _url, agentIdMatch) => {
      io.handleAgentItem(req, res, agentIdMatch[1]).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  regexRoute(
    '/api/agents/:1/persona',
    (_req, url) => url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/persona$/),
    (io, req, res, _url, personaMatch) => {
      io.handlePersona(req, res, personaMatch[1]).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  regexRoute(
    '/api/agents/:1/memory/:2',
    (_req, url) => url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/memory\/(memory|user)$/),
    (io, req, res, _url, memoryMatch) => {
      io.handleMemory(req, res, memoryMatch[1], memoryMatch[2] as 'memory' | 'user').catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  regexRoute(
    '/api/agents/:1/memory/usage',
    (_req, url) => url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/memory\/usage$/),
    (io, req, res, url, memoryUsageMatch) => {
      io.handleMemoryUsage(req, res, memoryUsageMatch[1], url).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  regexRoute(
    '/api/agents/:1/memory/context',
    (_req, url) => url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/memory\/context$/),
    (io, req, res, _url, memoryContextMatch) => {
      io.handleMemoryContext(req, res, memoryContextMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  regexRoute(
    '/api/agents/:1/auto-dream-report',
    (_req, url) => url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/auto-dream-report$/),
    (io, req, res, _url, autoDreamReportMatch) => {
      io.handleAutoDreamReport(req, res, autoDreamReportMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  regexRoute(
    '/api/agents/:1/auto-dream-optimizer',
    (_req, url) => url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/auto-dream-optimizer$/),
    (io, req, res, _url, optimizerMatch) => {
      io.handleAutoDreamOptimizer(req, res, optimizerMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  regexRoute(
    '/api/agents/:1/auto-dream-optimizer/cancel',
    (_req, url) =>
      url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/auto-dream-optimizer\/cancel$/),
    (io, req, res, _url, optimizerCancelMatch) => {
      io.handleAutoDreamOptimizerCancel(req, res, optimizerCancelMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  regexRoute(
    '/api/agents/:1/auto-dream-optimizer/proposals/:2/:3',
    (_req, url) =>
      url.pathname.match(
        /^\/api\/agents\/([a-zA-Z0-9_-]+)\/auto-dream-optimizer\/proposals\/([0-9a-f]{32})\/(apply|dismiss)$/,
      ),
    (io, req, res, _url, optimizerProposalMatch) => {
      io.handleAutoDreamOptimizerProposal(
        req,
        res,
        optimizerProposalMatch[1],
        optimizerProposalMatch[2],
        optimizerProposalMatch[3] as 'apply' | 'dismiss',
      ).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  // 单条记忆文件 CRUD(memdir)::file 用宽松 [^/]+ 捕获,handler 内 basename+MEMORY_FILE_RE 双保险。
  regexRoute(
    '/api/agents/:1/memory/files/:2',
    (_req, url) => url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/memory\/files\/([^/]+)$/),
    (io, req, res, _url, memoryFileMatch) => {
      io.handleMemoryFile(req, res, memoryFileMatch[1], memoryFileMatch[2]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  // User-level skill library (agentId-less; baseline + shared + aggregated legacy).
  predicateRoute(
    '/api/skills',
    (_req, url) => url.pathname === '/api/skills',
    (io, req, res, _url) => {
      io.handleUserSkillsList(req, res).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  regexRoute(
    '/api/skills/:1/files',
    (_req, url) => url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/files$/),
    (io, req, res, _url, userSkillFilesMatch) => {
      io._handleUserSkillFiles(req, res, userSkillFilesMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  regexRoute(
    '/api/skills/:1/history',
    (_req, url) => url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/history$/),
    (io, req, res, _url, userSkillHistoryMatch) => {
      io._handleUserSkillHistory(req, res, userSkillHistoryMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  regexRoute(
    '/api/skills/:1/restore',
    (_req, url) => url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/restore$/),
    (io, req, res, _url, userSkillRestoreMatch) => {
      io._handleUserSkillRestore(req, res, userSkillRestoreMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  regexRoute(
    '/api/skills/:1',
    (_req, url) => url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)$/),
    (io, req, res, _url, userSkillItemMatch) => {
      io.handleUserSkillItem(req, res, userSkillItemMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  regexRoute(
    '/api/agents/:1/skills',
    (_req, url) => url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/skills$/),
    (io, req, res, _url, skillsListMatch) => {
      io.handleSkillsList(req, res, skillsListMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  regexRoute(
    '/api/agents/:1/skills/:2',
    (_req, url) => url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/skills\/([a-z0-9-]+)$/),
    (io, req, res, _url, skillViewMatch) => {
      io.handleSkillItem(req, res, skillViewMatch[1], skillViewMatch[2]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  // ── Skill evals(用例 CRUD + 隔离双跑评测)──
  regexRoute(
    '/api/skills/:1/evals',
    (_req, url) => url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/evals$/),
    (io, req, res, _url, skillEvalsFileMatch) => {
      io._handleSkillEvalsFile(req, res, skillEvalsFileMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  regexRoute(
    '/api/skills/:1/eval-run',
    (_req, url) => url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/eval-run$/),
    (io, req, res, _url, skillEvalStartMatch) => {
      io._handleSkillEvalStart(req, res, skillEvalStartMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  regexRoute(
    '/api/skill-eval/:1',
    (_req, url) => url.pathname.match(/^\/api\/skill-eval\/([a-zA-Z0-9_-]+)$/),
    (io, req, res, _url, skillEvalRunMatch) => {
      io._handleSkillEvalRunStatus(req, res, skillEvalRunMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  // AI 生成用例(P1):启动异步生成 + 轮询状态。skill 名段用 [a-z0-9-]+ 与容器路由 /
  // bridge allowlist 完全一致(evals 精确路由带 $,不会吞掉 evals/generate)。
  regexRoute(
    '/api/skills/:1/evals/generate',
    (_req, url) => url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/evals\/generate$/),
    (io, req, res, _url, skillEvalGenStartMatch) => {
      io._handleSkillEvalGenStart(req, res, skillEvalGenStartMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  regexRoute(
    '/api/skill-eval-gen/:1',
    (_req, url) => url.pathname.match(/^\/api\/skill-eval-gen\/([a-zA-Z0-9_-]+)$/),
    (io, req, res, _url, skillEvalGenRunMatch) => {
      io._handleSkillEvalGenStatus(req, res, skillEvalGenRunMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  regexRoute(
    '/api/v5/release-jobs/:1',
    (_req, url) =>
      url.pathname.match(/^\/api\/v5\/release-jobs\/(rel-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12})$/),
    (io, req, res, _url, releaseJobMatch) => {
      io._handleReleaseJobStatus(req, res, releaseJobMatch[1])
      return true
    },
  ),
  // ── SkillOpt skill-training (async; train → diff → confirm-merge) ──
  regexRoute(
    '/api/skills/:1/train',
    (_req, url) => url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/train$/),
    (io, req, res, _url, skillTrainStartMatch) => {
      io._handleSkillTrainStart(req, res, skillTrainStartMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  regexRoute(
    '/api/skill-training/:1/drafts/:2',
    (_req, url) =>
      url.pathname.match(/^\/api\/skill-training\/([a-zA-Z0-9_-]+)\/drafts\/([a-z0-9-]+)$/),
    (io, req, res, _url, skillTrainDraftItemMatch) => {
      io._handleSkillTrainDraftItem(
        req,
        res,
        skillTrainDraftItemMatch[1],
        skillTrainDraftItemMatch[2],
      ).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  regexRoute(
    '/api/skill-training/:1/drafts/:2/comment',
    (_req, url) =>
      url.pathname.match(
        /^\/api\/skill-training\/([a-zA-Z0-9_-]+)\/drafts\/([a-z0-9-]+)\/comment$/,
      ),
    (io, req, res, _url, skillTrainCommentMatch) => {
      io._handleSkillTrainComment(
        req,
        res,
        skillTrainCommentMatch[1],
        skillTrainCommentMatch[2],
      ).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  regexRoute(
    '/api/skill-training/:1/drafts',
    (_req, url) => url.pathname.match(/^\/api\/skill-training\/([a-zA-Z0-9_-]+)\/drafts$/),
    (io, req, res, _url, skillTrainDraftsMatch) => {
      io._handleSkillTrainDrafts(req, res, skillTrainDraftsMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  regexRoute(
    '/api/skill-training/:1/merge',
    (_req, url) => url.pathname.match(/^\/api\/skill-training\/([a-zA-Z0-9_-]+)\/merge$/),
    (io, req, res, _url, skillTrainMergeMatch) => {
      io._handleSkillTrainMerge(req, res, skillTrainMergeMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  // 集合端点在 :runId 之前精确匹配 —— 训练 run 的找回入口(刷新/重启后 runId 不再只活在前端 state)。
  predicateRoute(
    '/api/skill-training',
    (_req, url) => url.pathname === '/api/skill-training',
    (io, req, res, _url) => {
      io._handleSkillTrainList(req, res).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  regexRoute(
    '/api/skill-training/:1',
    (_req, url) => url.pathname.match(/^\/api\/skill-training\/([a-zA-Z0-9_-]+)$/),
    (io, req, res, _url, skillTrainRunMatch) => {
      io._handleSkillTrainRun(req, res, skillTrainRunMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  // ── Inter-agent messaging ──
  regexRoute(
    '/api/agents/:1/message',
    (_req, url) => url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/message$/),
    (io, req, res, _url, agentMsgMatch) => {
      io.handleAgentMessage(req, res, agentMsgMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  // ── Async delegate job long-poll (Cursor MCP 60s ceiling) ──
  predicateRoute(
    '/api/delegate/wait',
    (_req, url) => url.pathname === '/api/delegate/wait',
    (io, req, res, _url) => {
      io.handleDelegateWait(req, res).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  // ── Advisor consult (dedicated; never /delegate) ──
  predicateRoute(
    'POST /api/agents/advisor/consult',
    (req, url) => url.pathname === '/api/agents/advisor/consult' && req.method === 'POST',
    (io, req, res, _url) => {
      io.handleConsultAdvisor(req, res).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  predicateRoute(
    '/api/collaboration-config',
    (_req, url) => url.pathname === '/api/collaboration-config',
    (io, req, res, url) => {
      io.handleCollaborationConfig(req, res, url).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
  // ── Synchronous task delegation ──
  regexRoute(
    '/api/agents/:1/delegate',
    (_req, url) => url.pathname.match(/^\/api\/agents\/([A-Za-z0-9._:-]+)\/delegate$/),
    (io, req, res, _url, delegateMatch) => {
      io.handleDelegateTask(req, res, delegateMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
  // ── Engine ask-user bridge (cursor MCP ask_user → web choice cards) ──
  regexRoute(
    '/api/agents/:1/ask-user',
    (_req, url) => url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/ask-user$/),
    (io, req, res, _url, askUserMatch) => {
      io.handleEngineAskUser(req, res, askUserMatch[1]).catch((err) =>
        io.sendInternalError(res, err),
      )
      return true
    },
  ),
]
