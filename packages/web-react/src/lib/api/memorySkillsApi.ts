/**
 * api: memory files and index, auto-dream reports and optimizer, cron, research library, skills (files, history, evals, training, drafts), community tutorials.
 *
 * Moved verbatim out of `api` in api.ts — FINDINGS §8 (cc2), OCV5-475. `api`
 * spreads this object at the same position, so its keys, order and values are unchanged.
 */
import type {
  AuthSession,
  CommunityBlogPrecheck,
  CommunityTutorialCategory,
  CommunityTutorialDetail,
  CommunityTutorialDraft,
  CommunityTutorialMine,
  CommunityTutorialPage,
  CommunityTutorialReviseResult,
  CommunityTutorialSummary,
  TutorialImageUpload,
  TutorialKind,
  TutorialSnapshotDraft,
  TutorialSnapshotSubmitResult,
  CronCreateInput,
  CronJob,
  SkillDetail,
  ResearchLibraryDoc,
  ResearchLibraryUploadResult,
  SkillSummary,
  SkillDraftDetail,
  SkillDraftSummary,
  SkillEvalGenJob,
  SkillEvalRun,
  SkillEvalsFile,
  SkillRunUsage,
  SkillTrainRun,
  SkillTrainStartResult,
  MemoryDocResponse,
  MemoryConflict,
  PutMemoryResult,
  MemoryIndexResponse,
  MemoryUsageDashboard,
  AutoDreamReportResponse,
  AutoDreamOptimizerState,
  MemoryFileContent,
  PutMemoryFileResult,
} from "../types";
import {
  callWithRefresh,
  assertAuthResponseCurrent,
  bearerHeaders,
  withReqId,
  ApiError,
  jsonOrThrow,
} from "./http";

export const memorySkillsApi = {
  // ── 容器内管理（记忆 / 定时任务 / 技能；经 commercial router 自动代理进用户容器） ──
  //
  // 这些 host 级路径对商业用户本会 403 BLOCKED，但命中 bridgeApiAllowlist 的
  // proxyFromCommercial 条目后由 router 注入 bridge nonce 转发到用户容器内 gateway
  // (127.0.0.1:18789，按 userId 隔离)。前端只需普通 Bearer fetch，无需特殊 header。
  // 容器未就绪时 router 会先 ensureContainerReady（可能冷启 ~40s），失败返 503/4503。

  /** 取用户画像文档（GET /api/agents/:id/memory/user）。
   *  用户画像 = 共享的 user.md,单文档纯 markdown;limit = 字符预算(后端权威,前端展示)；
   *  version = 乐观锁令牌,PUT 回传以检测并发写。核心记忆走 getMemoryIndex/文件子路由。 */
  getMemory: (a: AuthSession, agentId: string, target: "user") =>
    jsonOrThrow<MemoryDocResponse>(
      callWithRefresh(a, (t) =>
        fetch(`/api/agents/${encodeURIComponent(agentId)}/memory/${target}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /**
   * 写用户画像文档（PUT /api/agents/:id/memory/user）。核心记忆 PUT 已 410(改文件子路由)。
   * 带乐观锁 version：后端在 version 落后时返 409 `{ conflict }`（智能体在用户编辑期间改了画像）。
   * 409 不当作错误抛,解析 conflict 交回上层刷新基线；其余非 2xx 仍走统一 ApiError。
   */
  putMemory: async (
    a: AuthSession,
    agentId: string,
    target: "user",
    text: string,
    version?: string,
  ): Promise<PutMemoryResult> => {
    const res = await callWithRefresh(a, (t) =>
      fetch(`/api/agents/${encodeURIComponent(agentId)}/memory/${target}`, {
        method: "PUT",
        credentials: "include",
        headers: bearerHeaders(t, true),
        body: JSON.stringify(version !== undefined ? { text, version } : { text }),
      }),
    );
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as {
        conflict?: Partial<MemoryConflict>;
      } | null;
      assertAuthResponseCurrent(res);
      const c = body?.conflict;
      if (c && typeof c.text === "string") {
        return {
          ok: false,
          conflict: {
            text: c.text,
            version: String(c.version ?? ""),
            charCount: Number(c.charCount ?? 0),
            limit: Number(c.limit ?? 0),
          },
        };
      }
      // 非预期的 409（无 conflict 载荷）：按普通错误抛，保持统一错误信封。
      throw new ApiError({ status: 409, message: withReqId("记忆写入冲突", res), body });
    }
    const out = await jsonOrThrow<{
      ok: boolean;
      version: string;
      charCount?: number;
      limit?: number;
    }>(res);
    return { ok: true, version: out.version, charCount: out.charCount, limit: out.limit };
  },

  /** 取某 agent 的核心记忆索引 + 文件列表（GET /api/agents/:id/memory/memory）。
   *  memdir 范式:返回只读索引文本 + 每条记忆文件的元数据(name/description/type/mtime)。
   *  正文按需经 getMemoryFile 单取(渐进披露,不一次拉全部正文)。 */
  getMemoryIndex: (a: AuthSession, agentId: string) =>
    jsonOrThrow<MemoryIndexResponse>(
      callWithRefresh(a, (t) =>
        fetch(`/api/agents/${encodeURIComponent(agentId)}/memory/memory`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 逐会话记忆使用统计（精确事件，不解析工具文本；days=1..90）。 */
  getMemoryUsage: (a: AuthSession, agentId: string, days = 30) =>
    jsonOrThrow<MemoryUsageDashboard>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/agents/${encodeURIComponent(agentId)}/memory/usage?days=${Math.max(1, Math.min(90, Math.floor(days)))}`,
          { credentials: "include", headers: bearerHeaders(t) },
        ),
      ),
    ),

  /** Auto-Dream 最近一次梦境报告与当前进度；响应经过容器端严格白名单投影。 */
  getAutoDreamReport: (a: AuthSession, agentId: string) =>
    jsonOrThrow<AutoDreamReportResponse>(
      callWithRefresh(a, (t) =>
        fetch(`/api/agents/${encodeURIComponent(agentId)}/auto-dream-report`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  // Auto‑Dream 全面优化:前端调用方(管理中心「优化」分区 / 侧栏待确认计数)已下线(OCV5-360);
  // 方法保留以便回滚恢复,后端路由与状态文件未动。
  getAutoDreamOptimizer: (a: AuthSession, agentId: string) =>
    jsonOrThrow<AutoDreamOptimizerState>(
      callWithRefresh(a, (t) =>
        fetch(`/api/agents/${encodeURIComponent(agentId)}/auto-dream-optimizer`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  runAutoDreamOptimizer: (a: AuthSession, agentId: string) =>
    jsonOrThrow<AutoDreamOptimizerState>(
      callWithRefresh(a, (t) =>
        fetch(`/api/agents/${encodeURIComponent(agentId)}/auto-dream-optimizer`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: "{}",
        }),
      ),
    ),

  cancelAutoDreamOptimizer: (a: AuthSession, agentId: string) =>
    jsonOrThrow<AutoDreamOptimizerState>(
      callWithRefresh(a, (t) =>
        fetch(`/api/agents/${encodeURIComponent(agentId)}/auto-dream-optimizer/cancel`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: "{}",
        }),
      ),
    ),

  mutateAutoDreamProposal: (
    a: AuthSession,
    agentId: string,
    proposalId: string,
    action: "apply" | "dismiss",
  ) =>
    jsonOrThrow<AutoDreamOptimizerState>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/agents/${encodeURIComponent(agentId)}/auto-dream-optimizer/proposals/${proposalId}/${action}`,
          {
            method: "POST",
            credentials: "include",
            headers: bearerHeaders(t, true),
            body: "{}",
          },
        ),
      ),
    ),

  /** 取单个记忆文件正文（GET /api/agents/:id/memory/files/:file）。version=乐观锁令牌。 */
  getMemoryFile: (a: AuthSession, agentId: string, file: string) =>
    jsonOrThrow<MemoryFileContent>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/agents/${encodeURIComponent(agentId)}/memory/files/${encodeURIComponent(file)}`,
          { credentials: "include", headers: bearerHeaders(t) },
        ),
      ),
    ),

  /**
   * 写单个记忆文件（PUT /api/agents/:id/memory/files/:file，body `{ content, version? }`）。
   * 新建传 version=undefined(不做版本校验)；编辑带 version 做乐观锁。version 落后 → 409
   * `{ conflict:{ content|current|text, version } }`(文件已被别处修改):不当错误抛,交回上层
   * 刷新基线并保留用户未保存文本。其余非 2xx 走统一 ApiError。
   */
  putMemoryFile: async (
    a: AuthSession,
    agentId: string,
    file: string,
    content: string,
    version?: string,
  ): Promise<PutMemoryFileResult> => {
    const res = await callWithRefresh(a, (t) =>
      fetch(`/api/agents/${encodeURIComponent(agentId)}/memory/files/${encodeURIComponent(file)}`, {
        method: "PUT",
        credentials: "include",
        headers: bearerHeaders(t, true),
        body: JSON.stringify(version !== undefined ? { content, version } : { content }),
      }),
    );
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as {
        conflict?: { content?: string; current?: string; text?: string; version?: unknown };
      } | null;
      assertAuthResponseCurrent(res);
      const c = body?.conflict;
      // 存储层 conflict 用 `current`,路由若对齐 user 用 `text`,一律兼容取正文。
      const latest = c ? (c.content ?? c.current ?? c.text) : undefined;
      if (c && typeof latest === "string") {
        return { ok: false, conflict: { content: latest, version: String(c.version ?? "") } };
      }
      throw new ApiError({ status: 409, message: withReqId("记忆文件写入冲突", res), body });
    }
    const out = await jsonOrThrow<{ ok: boolean; version: string }>(res);
    return { ok: true, version: out.version };
  },

  /** 删除单个记忆文件（DELETE /api/agents/:id/memory/files/:file）。返回是否删除成功。 */
  deleteMemoryFile: async (a: AuthSession, agentId: string, file: string): Promise<boolean> => {
    const out = await jsonOrThrow<{ ok?: boolean; deleted?: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/agents/${encodeURIComponent(agentId)}/memory/files/${encodeURIComponent(file)}`,
          { method: "DELETE", credentials: "include", headers: bearerHeaders(t) },
        ),
      ),
    );
    return out.deleted ?? out.ok ?? true;
  },

  /** 定时任务列表（GET /api/cron）。 */
  listCron: (a: AuthSession, q?: { boardProjectId?: string }) => {
    const qs = q?.boardProjectId ? `?boardProjectId=${encodeURIComponent(q.boardProjectId)}` : "";
    return jsonOrThrow<{ jobs: CronJob[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/cron${qs}`, { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.jobs || []);
  },

  /** 可用送达通道（GET /api/cron/channels）。失败由调用方回退写死三项。 */
  listCronChannels: (a: AuthSession) =>
    jsonOrThrow<{ channels: Array<{ value: string; available: boolean }> }>(
      callWithRefresh(a, (t) =>
        fetch("/api/cron/channels", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.channels || []),

  /** 新建定时任务（POST /api/cron）。 */
  createCron: (a: AuthSession, body: CronCreateInput) =>
    jsonOrThrow<{ ok: boolean; job?: CronJob }>(
      callWithRefresh(a, (t) =>
        fetch("/api/cron", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ),

  /** 改定时任务（PUT /api/cron/:id，如 {enabled}）。 */
  updateCron: (a: AuthSession, id: string, patch: Record<string, unknown>) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/cron/${encodeURIComponent(id)}`, {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(patch),
        }),
      ),
    ),

  /** 删除定时任务（DELETE /api/cron/:id）。 */
  deleteCron: (a: AuthSession, id: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/cron/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 文献库列表(GET /api/me/research/library,master 直存,非容器代理)。
   *  前端调用方(管理中心「文献」分区)已下线(OCV5-360);方法保留以便回滚恢复。 */
  listResearchLibrary: (a: AuthSession) =>
    jsonOrThrow<{ documents: ResearchLibraryDoc[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/research/library", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.documents || []),

  /** 文献库删单篇(DELETE /api/me/research/library/:docId)。 */
  deleteResearchDoc: (a: AuthSession, docId: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/research/library/${encodeURIComponent(docId)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 文献库上传入库(POST /api/me/research/library?filename=,raw bytes ≤25MiB)。 */
  uploadResearchDoc: (a: AuthSession, file: File) =>
    jsonOrThrow<ResearchLibraryUploadResult>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/research/library?filename=${encodeURIComponent(file.name)}`, {
          method: "POST",
          credentials: "include",
          headers: {
            ...bearerHeaders(t),
            "content-type": file.type || "application/octet-stream",
          },
          body: file,
        }),
      ),
    ),

  /** 技能列表（GET /api/skills）。 */
  listSkills: (a: AuthSession) =>
    jsonOrThrow<{ skills: SkillSummary[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/skills", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.skills || []),

  /** 技能详情（GET /api/skills/:name）。 */
  getSkill: (a: AuthSession, name: string) =>
    jsonOrThrow<{ skill: SkillDetail }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.skill),

  /** 删除技能（DELETE /api/skills/:name）。 */
  deleteSkill: (a: AuthSession, name: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 更新技能(描述/正文/标签;PUT /api/skills/:name,旧版自动入 history)。 */
  updateSkill: (
    a: AuthSession,
    name: string,
    body: { description?: string; body?: string; tags?: string[]; agentIds?: string[] },
  ) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}`, {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ),

  /** 新建技能，同名已存在时服务端拒绝（PUT body createOnly，412 → ApiError.status 412）。 */
  createSkill: (a: AuthSession, name: string, body: { description?: string; body?: string; tags?: string[] }) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}`, {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ ...body, createOnly: true }),
        }),
      ),
    ),

  /** 读技能目录内单个文件（GET /api/skills/:name?file=<rel>）。 */
  getSkillFile: (a: AuthSession, name: string, path: string) =>
    jsonOrThrow<{ path: string; content: string }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}?file=${encodeURIComponent(path)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 写技能辅助文件（PUT /api/skills/:name/files;references/assets/evals/scripts）。 */
  putSkillFile: (a: AuthSession, name: string, path: string, content: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}/files`, {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ path, content }),
        }),
      ),
    ),

  /** 删技能辅助文件。 */
  deleteSkillFile: (a: AuthSession, name: string, path: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 技能版本历史（GET /api/skills/:name/history;快照覆盖 SKILL.md 正文）。 */
  getSkillHistory: (a: AuthSession, name: string) =>
    jsonOrThrow<{ history: Array<{ version: string; timestamp: string }>; writable: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}/history`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 恢复历史版本（POST /api/skills/:name/restore;以新版本号写回,可再回滚）。 */
  restoreSkillVersion: (a: AuthSession, name: string, version: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}/restore`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ version }),
        }),
      ),
    ),

  // ── 技能评测 + 训练(SkillOpt;经容器代理,消耗积分的操作在 UI 层强制成本确认) ──

  /** 评测用例 + 上次结果（GET /api/skills/:name/evals）。 */
  getSkillEvals: (a: AuthSession, name: string) =>
    jsonOrThrow<{
      evals: SkillEvalsFile | null;
      parseErrors?: string[];
      lastRun: {
        runId: string;
        finishedAt: number;
        benchmark: SkillEvalRun["benchmark"];
        usage: SkillRunUsage;
      } | null;
      writable: boolean;
    }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}/evals`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 保存评测用例（PUT /api/skills/:name/evals）。 */
  putSkillEvals: (a: AuthSession, name: string, evals: SkillEvalsFile) =>
    jsonOrThrow<{ ok: boolean; evals: SkillEvalsFile }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}/evals`, {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ evals }),
        }),
      ),
    ),

  /** 启动评测 run（POST /api/skills/:name/eval-run;消耗积分,调用前必须已过成本确认）。 */
  startSkillEvalRun: (
    a: AuthSession,
    name: string,
    body?: { mode?: "baseline" | "draft"; trainRunId?: string },
  ) =>
    jsonOrThrow<{ ok: boolean; runId: string }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}/eval-run`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body ?? {}),
        }),
      ),
    ),

  /** 评测 run 状态（GET /api/skill-eval/:runId）。 */
  getSkillEvalRun: (a: AuthSession, runId: string) =>
    jsonOrThrow<{ run: SkillEvalRun }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skill-eval/${encodeURIComponent(runId)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.run),

  /** 启动 AI 生成评测用例 job（POST /api/skills/:name/evals/generate;消耗积分,调用前必须
   *  已过成本确认）。生成绝不落库,只回草稿由前端灌进编辑器。经 ApiError 抛:409=同技能已有
   *  生成/评测在跑;403=非自建技能;404=技能不存在。 */
  generateSkillEvals: (a: AuthSession, name: string) =>
    jsonOrThrow<{ ok: boolean; runId: string }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}/evals/generate`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({}),
        }),
      ),
    ),

  /** AI 生成 job 状态（GET /api/skill-eval-gen/:runId;直接回 job,cases 仅 done）。 */
  getSkillEvalGen: (a: AuthSession, runId: string) =>
    jsonOrThrow<SkillEvalGenJob>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skill-eval-gen/${encodeURIComponent(runId)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 后台发布任务状态（GET /api/v5/release-jobs/:id;刷新后进度卡回源）。 */
  getReleaseJob: (a: AuthSession, id: string) =>
    jsonOrThrow<Record<string, unknown>>(
      callWithRefresh(a, (t) =>
        fetch(`/api/v5/release-jobs/${encodeURIComponent(id)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 启动训练 run（POST /api/skills/:name/train;消耗积分,调用前必须已过成本确认）。
   *  响应可带 feedbackRefs(命中的差评真实使用记录条数;旧后端缺省)。 */
  startSkillTrain: (a: AuthSession, name: string, body?: { focus?: string; autoEval?: boolean }) =>
    jsonOrThrow<SkillTrainStartResult>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}/train`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body ?? {}),
        }),
      ),
    ),

  /** 训练 run 列表（GET /api/skill-training，按 startedAt 降序）。
   *  用于页面刷新/服务重启后找回未完成或有草稿(diff_ready)的训练 run。 */
  listSkillTrainRuns: (a: AuthSession) =>
    jsonOrThrow<{ runs: SkillTrainRun[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/skill-training", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.runs || []),

  /** 训练 run 状态（GET /api/skill-training/:runId）。 */
  getSkillTrainRun: (a: AuthSession, runId: string) =>
    jsonOrThrow<{ run: SkillTrainRun }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skill-training/${encodeURIComponent(runId)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.run),

  /** 放弃训练 run(DELETE,连同草稿一起清)。 */
  discardSkillTrainRun: (a: AuthSession, runId: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skill-training/${encodeURIComponent(runId)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 草稿列表。 */
  listSkillDrafts: (a: AuthSession, runId: string) =>
    jsonOrThrow<{ drafts: SkillDraftSummary[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skill-training/${encodeURIComponent(runId)}/drafts`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.drafts || []),

  /** 草稿详情(草稿+现版两个 diff 侧)。 */
  getSkillDraft: (a: AuthSession, runId: string, name: string) =>
    jsonOrThrow<SkillDraftDetail>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/skill-training/${encodeURIComponent(runId)}/drafts/${encodeURIComponent(name)}`,
          {
            credentials: "include",
            headers: bearerHeaders(t),
          },
        ),
      ),
    ),

  /** 对草稿留评论 → AI 修订(消耗积分,UI 层须再次确认)。 */
  commentSkillDraft: (a: AuthSession, runId: string, name: string, comment: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/skill-training/${encodeURIComponent(runId)}/drafts/${encodeURIComponent(name)}/comment`,
          {
            method: "POST",
            credentials: "include",
            headers: bearerHeaders(t, true),
            body: JSON.stringify({ comment }),
          },
        ),
      ),
    ),

  /** 合并草稿到权威技能库(唯一写入)。 */
  mergeSkillTrainRun: (a: AuthSession, runId: string, name?: string) =>
    jsonOrThrow<{ ok: boolean; results: Array<{ name: string; ok: boolean; error?: string }> }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skill-training/${encodeURIComponent(runId)}/merge`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(name ? { name } : {}),
        }),
      ),
    ),

  // ── 教程工作室（公开目录 / 快照 / 管理评测） ────────────────────────────

  listCommunityTutorials: (opts?: {
    cursor?: string | null;
    query?: string;
    category?: CommunityTutorialCategory | null;
    limit?: number;
    /** 经验分享只列 markdown 投稿。 */
    kind?: TutorialKind | null;
  }) => {
    const qs = new URLSearchParams();
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.query) qs.set("q", opts.query);
    if (opts?.category) qs.set("category", opts.category);
    if (opts?.kind) qs.set("kind", opts.kind);
    if (opts?.limit) qs.set("limit", String(opts.limit));
    const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
    return jsonOrThrow<CommunityTutorialPage<CommunityTutorialSummary>>(
      fetch(`/api/tutorials${suffix}`),
    );
  },

  getCommunityTutorial: (id: string) =>
    jsonOrThrow<{ tutorial: CommunityTutorialDetail }>(
      fetch(`/api/tutorials/${encodeURIComponent(id)}`),
    ).then((result) => result.tutorial),

  submitCommunityTutorial: (a: AuthSession, draft: CommunityTutorialDraft) =>
    jsonOrThrow<{ tutorial: { id: string; status: "pending"; createdAt: string } }>(
      callWithRefresh(a, (token) =>
        fetch("/api/tutorials", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify(draft),
        }),
      ),
    ).then((result) => result.tutorial),

  submitTutorialSnapshot: (a: AuthSession, draft: TutorialSnapshotDraft) =>
    jsonOrThrow<TutorialSnapshotSubmitResult>(
      callWithRefresh(a, (token) =>
        fetch("/api/tutorials/snapshots", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify(draft),
        }),
      ),
    ).then((result) => ({
      tutorial: { ...result.tutorial, kind: result.tutorial.kind ?? "snapshot" },
      leakReport: result.leakReport ?? null,
    })),

  listMyCommunityTutorials: (a: AuthSession, cursor?: string | null) =>
    jsonOrThrow<CommunityTutorialPage<CommunityTutorialMine>>(
      callWithRefresh(a, (token) =>
        fetch(`/api/tutorials/mine${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, {
          credentials: "include",
          headers: bearerHeaders(token),
        }),
      ),
    ),

  /** 对话写博客的草稿卡预检：只读，和投稿同一套确定性检查（不含 AI 审核）。 */
  precheckCommunityTutorial: (a: AuthSession, draft: CommunityTutorialDraft) =>
    jsonOrThrow<CommunityBlogPrecheck>(
      callWithRefresh(a, (token) =>
        fetch("/api/tutorials/precheck", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify(draft),
        }),
      ),
    ),

  /** 我的某一篇投稿（作者本人）：状态、审核理由、正文。 */
  getMyCommunityTutorial: (a: AuthSession, id: string) =>
    jsonOrThrow<{ tutorial: CommunityTutorialMine }>(
      callWithRefresh(a, (token) =>
        fetch(`/api/tutorials/mine/${encodeURIComponent(id)}`, {
          credentials: "include",
          headers: bearerHeaders(token),
        }),
      ),
    ).then((result) => result.tutorial),

  /** 经验分享图片上传：原始字节（前端已压成 webp），服务端按魔数复核并去元数据。 */
  uploadTutorialImage: (a: AuthSession, file: Blob) =>
    jsonOrThrow<{ image: TutorialImageUpload }>(
      callWithRefresh(a, (token) =>
        fetch("/api/tutorials/images", {
          method: "POST",
          credentials: "include",
          headers: { ...bearerHeaders(token), "Content-Type": file.type || "image/webp" },
          body: file,
        }),
      ),
    ).then((result) => result.image),

  /** 作者/管理员读取未公开稿件里的图（编辑器预览、审核预览）；返回 Blob，调用方转 object URL。 */
  fetchTutorialImage: async (a: AuthSession, sha256: string): Promise<Blob> => {
    const res = await callWithRefresh(a, (token) =>
      fetch(`/api/tutorials/images/${encodeURIComponent(sha256)}`, {
        credentials: "include",
        headers: bearerHeaders(token),
      }),
    );
    if (!res.ok) throw new Error(`读取图片失败（${res.status}）`);
    return res.blob();
  },

  /** 修改已投稿的经验分享：待审 / 未通过的改后重审；已发布的审核通过前线上仍是旧版。 */
  reviseCommunityTutorial: (a: AuthSession, id: string, draft: CommunityTutorialDraft) =>
    jsonOrThrow<{ tutorial: CommunityTutorialReviseResult }>(
      callWithRefresh(a, (token) =>
        fetch(`/api/tutorials/${encodeURIComponent(id)}/revise`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify(draft),
        }),
      ),
    ).then((result) => result.tutorial),

  withdrawCommunityTutorial: (a: AuthSession, id: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (token) =>
        fetch(`/api/tutorials/${encodeURIComponent(id)}/withdraw`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify({}),
        }),
      ),
    ),
}
