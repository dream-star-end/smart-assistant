/**
 * Non-first-screen memory, auto-dream, context hygiene, archives, cron,
 * research library, and skills CRUD/files/history REST implementations.
 * Loaded on demand via `memorySkillsApi` lazy proxies.
 */
import type {
  AuthSession,
  CronCreateInput,
  CronJob,
  SkillDetail,
  ResearchLibraryDoc,
  ResearchLibraryUploadResult,
  SkillSummary,
  MemoryDocResponse,
  MemoryConflict,
  PutMemoryResult,
  MemoryIndexResponse,
  MemoryContextView,
  MemoryUsageDashboard,
  AutoDreamReportResponse,
  AutoDreamOptimizerState,
  ArchivedMemoryEntry,
  ArchivedSkillEntry,
  ContextHealthReport,
  ContextHygieneRunOptions,
  ContextHygieneRunRecord,
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
  fetchWithExecutionGuard,
} from "./http";

export const memorySkillsLazyImpl = {
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
        fetchWithExecutionGuard(`/api/agents/${encodeURIComponent(agentId)}/memory/${target}`, {
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
      fetchWithExecutionGuard(`/api/agents/${encodeURIComponent(agentId)}/memory/${target}`, {
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
        fetchWithExecutionGuard(`/api/agents/${encodeURIComponent(agentId)}/memory/memory`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 逐会话记忆使用统计（精确事件，不解析工具文本；days=1..90）。 */
  getMemoryUsage: (a: AuthSession, agentId: string, days = 30) =>
    jsonOrThrow<MemoryUsageDashboard>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(
          `/api/agents/${encodeURIComponent(agentId)}/memory/usage?days=${Math.max(1, Math.min(90, Math.floor(days)))}`,
          { credentials: "include", headers: bearerHeaders(t) },
        ),
      ),
    ),

  /** 智能体当前能用到的记忆来源（GET /api/agents/:id/memory/context；只读元信息，展开时才取）。 */
  getMemoryContext: (a: AuthSession, agentId: string) =>
    jsonOrThrow<MemoryContextView>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/agents/${encodeURIComponent(agentId)}/memory/context`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** Auto-Dream 最近一次梦境报告与当前进度；响应经过容器端严格白名单投影。 */
  getAutoDreamReport: (a: AuthSession, agentId: string) =>
    jsonOrThrow<AutoDreamReportResponse>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/agents/${encodeURIComponent(agentId)}/auto-dream-report`, {
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
        fetchWithExecutionGuard(`/api/agents/${encodeURIComponent(agentId)}/auto-dream-optimizer`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  runAutoDreamOptimizer: (a: AuthSession, agentId: string) =>
    jsonOrThrow<AutoDreamOptimizerState>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/agents/${encodeURIComponent(agentId)}/auto-dream-optimizer`, {
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
        fetchWithExecutionGuard(`/api/agents/${encodeURIComponent(agentId)}/auto-dream-optimizer/cancel`, {
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
        fetchWithExecutionGuard(
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
        fetchWithExecutionGuard(
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
      fetchWithExecutionGuard(`/api/agents/${encodeURIComponent(agentId)}/memory/files/${encodeURIComponent(file)}`, {
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
        fetchWithExecutionGuard(
          `/api/agents/${encodeURIComponent(agentId)}/memory/files/${encodeURIComponent(file)}`,
          { method: "DELETE", credentials: "include", headers: bearerHeaders(t) },
        ),
      ),
    );
    return out.deleted ?? out.ok ?? true;
  },

  // ── OCV5-840: 上下文健康体检、确定性清理与可逆归档箱 ────────────────────────

  /** 常驻上下文健康体检报告（GET /api/agents/:id/context-health）。 */
  getContextHealth: (a: AuthSession, agentId: string) =>
    jsonOrThrow<ContextHealthReport>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/agents/${encodeURIComponent(agentId)}/context-health`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /**
   * 立即执行一次确定性上下文体检/安全归档清理（POST /api/agents/:id/context-hygiene/run）。
   * 支持 `pruneSkillHistoryNames` / `pruneArchivalIds` 精确选择集，避免误删未勾选项。
   */
  runContextHygiene: (a: AuthSession, agentId: string, options: ContextHygieneRunOptions = {}) => {
    const body: ContextHygieneRunOptions = {
      ...options,
      ...(options.pruneSkillHistoryNames !== undefined
        ? { pruneSkillHistoryNames: options.pruneSkillHistoryNames }
        : {}),
      ...(options.pruneArchivalIds !== undefined
        ? { pruneArchivalIds: options.pruneArchivalIds }
        : {}),
    };
    return jsonOrThrow<{ ok: boolean; run: ContextHygieneRunRecord }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/agents/${encodeURIComponent(agentId)}/context-hygiene/run`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    );
  },

  /** 最近上下文清理回执列表（GET /api/agents/:id/context-hygiene/history）。 */
  getContextHygieneHistory: (a: AuthSession, agentId: string, limit = 10) =>
    jsonOrThrow<{ runs: ContextHygieneRunRecord[] }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(
          `/api/agents/${encodeURIComponent(agentId)}/context-hygiene/history?limit=${Math.max(1, Math.min(50, Math.floor(limit)))}`,
          { credentials: "include", headers: bearerHeaders(t) },
        ),
      ),
    ),

  /** 列出核心记忆归档箱（GET /api/agents/:id/memory/archive）。 */
  listArchivedMemories: (a: AuthSession, agentId: string) =>
    jsonOrThrow<{ items: ArchivedMemoryEntry[] }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/agents/${encodeURIComponent(agentId)}/memory/archive`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 批量安全归档核心记忆文件（POST /api/agents/:id/memory/archive）。 */
  archiveMemoryFiles: (a: AuthSession, agentId: string, files: string[], reason?: string) =>
    jsonOrThrow<{ ok: boolean; batchId: string; archived: ArchivedMemoryEntry[]; skipped: unknown[]; bytesSaved: number }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/agents/${encodeURIComponent(agentId)}/memory/archive`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ files, ...(reason ? { reason } : {}) }),
        }),
      ),
    ),

  /** 一键还原归档核心记忆（支持单条 id 或整批 batchId；POST /api/agents/:id/memory/archive/restore）。 */
  restoreArchivedMemories: (a: AuthSession, agentId: string, opts: { id?: string; batchId?: string }) =>
    jsonOrThrow<{
      ok: boolean;
      restored: ArchivedMemoryEntry[];
      skipped: unknown[];
      preservedEditedFiles?: string[];
    }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/agents/${encodeURIComponent(agentId)}/memory/archive/restore`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(opts),
        }),
      ),
    ),

  /** 列出技能归档箱（GET /api/skills/archive）。 */
  listArchivedSkills: (a: AuthSession) =>
    jsonOrThrow<{ items: ArchivedSkillEntry[] }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/skills/archive", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ),

  /** 将指定用户技能移入可逆归档箱（POST /api/skills/:name/archive）。 */
  archiveSkill: (a: AuthSession, name: string, reason?: string) =>
    jsonOrThrow<{ ok: boolean; batchId: string; entry?: ArchivedSkillEntry; skippedReason?: string }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/skills/${encodeURIComponent(name)}/archive`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(reason ? { reason } : {}),
        }),
      ),
    ),

  /** 一键还原归档技能（支持单条 id/name 或整批 batchId；POST /api/skills/archive/restore）。 */
  restoreArchivedSkills: (a: AuthSession, opts: { id?: string; name?: string; batchId?: string }) =>
    jsonOrThrow<{
      ok: boolean;
      restored: ArchivedSkillEntry[];
      skipped: unknown[];
      preservedEditedFiles?: string[];
    }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/skills/archive/restore", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(opts),
        }),
      ),
    ),

  /** 定时任务列表（GET /api/cron）。 */
  listCron: (a: AuthSession, q?: { boardProjectId?: string }) => {
    const qs = q?.boardProjectId ? `?boardProjectId=${encodeURIComponent(q.boardProjectId)}` : "";
    return jsonOrThrow<{ jobs: CronJob[] }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/cron${qs}`, { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.jobs || []);
  },

  /** 可用送达通道（GET /api/cron/channels）。失败由调用方回退写死三项。 */
  listCronChannels: (a: AuthSession) =>
    jsonOrThrow<{ channels: Array<{ value: string; available: boolean }> }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/cron/channels", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.channels || []),

  /** 新建定时任务（POST /api/cron）。 */
  createCron: (a: AuthSession, body: CronCreateInput) =>
    jsonOrThrow<{ ok: boolean; job?: CronJob }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/cron", {
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
        fetchWithExecutionGuard(`/api/cron/${encodeURIComponent(id)}`, {
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
        fetchWithExecutionGuard(`/api/cron/${encodeURIComponent(id)}`, {
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
        fetchWithExecutionGuard("/api/me/research/library", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.documents || []),

  /** 文献库删单篇(DELETE /api/me/research/library/:docId)。 */
  deleteResearchDoc: (a: AuthSession, docId: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/me/research/library/${encodeURIComponent(docId)}`, {
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
        fetchWithExecutionGuard(`/api/me/research/library?filename=${encodeURIComponent(file.name)}`, {
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
        fetchWithExecutionGuard("/api/skills", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.skills || []),

  /** 技能详情（GET /api/skills/:name）。 */
  getSkill: (a: AuthSession, name: string) =>
    jsonOrThrow<{ skill: SkillDetail }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/skills/${encodeURIComponent(name)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.skill),

  /** 删除技能（DELETE /api/skills/:name）。 */
  deleteSkill: (a: AuthSession, name: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/skills/${encodeURIComponent(name)}`, {
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
        fetchWithExecutionGuard(`/api/skills/${encodeURIComponent(name)}`, {
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
        fetchWithExecutionGuard(`/api/skills/${encodeURIComponent(name)}`, {
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
        fetchWithExecutionGuard(`/api/skills/${encodeURIComponent(name)}?file=${encodeURIComponent(path)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 写技能辅助文件（PUT /api/skills/:name/files;references/assets/evals/scripts）。 */
  putSkillFile: (a: AuthSession, name: string, path: string, content: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/skills/${encodeURIComponent(name)}/files`, {
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
        fetchWithExecutionGuard(`/api/skills/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`, {
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
        fetchWithExecutionGuard(`/api/skills/${encodeURIComponent(name)}/history`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 恢复历史版本（POST /api/skills/:name/restore;以新版本号写回,可再回滚）。 */
  restoreSkillVersion: (a: AuthSession, name: string, version: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/skills/${encodeURIComponent(name)}/restore`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ version }),
        }),
      ),
    ),

};
