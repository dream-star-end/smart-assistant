import { withCardBusinessApi } from "./cardBusinessLoader";
import type { RequestExecutionGuard } from "./http";
import type {
  AuthSession,
  CommunityTutorialCategory,
  CommunityTutorialDraft,
  TutorialSnapshotDraft,
  SkillEvalsFile,
  TutorialKind,
} from "../types";
import { createLazyApiDomain } from "./lazyDomain";

type MemorySkillsLazyImpl = typeof import("./memorySkillsLazyImpl").memorySkillsLazyImpl;

const memorySkillsLazyProxy = createLazyApiDomain<MemorySkillsLazyImpl>(
  () => import("./memorySkillsLazyImpl").then((m) => m.memorySkillsLazyImpl),
  [
    "getMemory",
    "putMemory",
    "getMemoryIndex",
    "getMemoryUsage",
    "getMemoryContext",
    "getAutoDreamReport",
    "getAutoDreamOptimizer",
    "runAutoDreamOptimizer",
    "cancelAutoDreamOptimizer",
    "mutateAutoDreamProposal",
    "getMemoryFile",
    "putMemoryFile",
    "deleteMemoryFile",
    "getContextHealth",
    "runContextHygiene",
    "getContextHygieneHistory",
    "listArchivedMemories",
    "archiveMemoryFiles",
    "restoreArchivedMemories",
    "listArchivedSkills",
    "archiveSkill",
    "restoreArchivedSkills",
    "listCron",
    "listCronChannels",
    "createCron",
    "updateCron",
    "deleteCron",
    "listResearchLibrary",
    "deleteResearchDoc",
    "uploadResearchDoc",
    "listSkills",
    "getSkill",
    "deleteSkill",
    "updateSkill",
    "createSkill",
    "getSkillFile",
    "putSkillFile",
    "deleteSkillFile",
    "getSkillHistory",
    "restoreSkillVersion",
  ],
);

/**
 * api: memory files and index, auto-dream, context hygiene, cron, research library,
 * skills (CRUD, files, history, evals, training, drafts), and community tutorials.
 *
 * All non-first-screen implementations load on demand via `memorySkillsLazyImpl`
 * and `cardBusinessApi`, keeping them out of the first-screen static closure while
 * preserving exact `api.*` identity for callers and tests.
 */
export const memorySkillsApi = {
  ...memorySkillsLazyProxy,

  // ── 技能评测 + 训练(SkillOpt;经容器代理,消耗积分的操作在 UI 层强制成本确认) ──

  /** 评测用例 + 上次结果（GET /api/skills/:name/evals）。 */
  getSkillEvals: (a: AuthSession, name: string) =>
    withCardBusinessApi(a, undefined, (client) => client.getSkillEvals(a, name)),

  /** 保存评测用例（PUT /api/skills/:name/evals）。 */
  putSkillEvals: (a: AuthSession, name: string, evals: SkillEvalsFile) => {
    const frozen = structuredClone(evals);
    return withCardBusinessApi(a, undefined, (client) => client.putSkillEvals(a, name, frozen));
  },

  /** 启动评测 run（POST /api/skills/:name/eval-run;消耗积分,调用前必须已过成本确认）。 */
  startSkillEvalRun: (
    a: AuthSession,
    name: string,
    body?: { mode?: "baseline" | "draft"; trainRunId?: string },
  ) => {
    const frozen = body ? { ...body } : undefined;
    return withCardBusinessApi(a, undefined, (client) => client.startSkillEvalRun(a, name, frozen));
  },

  /** 评测 run 状态（GET /api/skill-eval/:runId）。 */
  getSkillEvalRun: (a: AuthSession, runId: string) =>
    withCardBusinessApi(a, undefined, (client) => client.getSkillEvalRun(a, runId)),

  /** 启动 AI 生成评测用例 job（POST /api/skills/:name/evals/generate）。 */
  generateSkillEvals: (a: AuthSession, name: string) =>
    withCardBusinessApi(a, undefined, (client) => client.generateSkillEvals(a, name)),

  /** AI 生成 job 状态（GET /api/skill-eval-gen/:runId;直接回 job,cases 仅 done）。 */
  getSkillEvalGen: (a: AuthSession, runId: string) =>
    withCardBusinessApi(a, undefined, (client) => client.getSkillEvalGen(a, runId)),

  /** 后台发布任务状态（GET /api/v5/release-jobs/:id;刷新后进度卡回源）。 */
  getReleaseJob: (a: AuthSession, id: string) =>
    withCardBusinessApi(a, undefined, (client) => client.getReleaseJob(a, id)),

  /** 启动训练 run（POST /api/skills/:name/train;消耗积分,调用前必须已过成本确认）。 */
  startSkillTrain: (a: AuthSession, name: string, body?: { focus?: string; autoEval?: boolean }) => {
    const frozen = body ? { ...body } : undefined;
    return withCardBusinessApi(a, undefined, (client) => client.startSkillTrain(a, name, frozen));
  },

  /** 训练 run 列表（GET /api/skill-training，按 startedAt 降序）。 */
  listSkillTrainRuns: (a: AuthSession) =>
    withCardBusinessApi(a, undefined, (client) => client.listSkillTrainRuns(a)),

  /** 训练 run 状态（GET /api/skill-training/:runId）。 */
  getSkillTrainRun: (a: AuthSession, runId: string) =>
    withCardBusinessApi(a, undefined, (client) => client.getSkillTrainRun(a, runId)),

  /** 放弃训练 run(DELETE,连同草稿一起清)。 */
  discardSkillTrainRun: (a: AuthSession, runId: string) =>
    withCardBusinessApi(a, undefined, (client) => client.discardSkillTrainRun(a, runId)),

  /** 草稿列表。 */
  listSkillDrafts: (a: AuthSession, runId: string) =>
    withCardBusinessApi(a, undefined, (client) => client.listSkillDrafts(a, runId)),

  /** 草稿详情(草稿+现版两个 diff 侧)。 */
  getSkillDraft: (a: AuthSession, runId: string, name: string) =>
    withCardBusinessApi(a, undefined, (client) => client.getSkillDraft(a, runId, name)),

  /** 对草稿留评论 → AI 修订(消耗积分,UI 层须再次确认)。 */
  commentSkillDraft: (a: AuthSession, runId: string, name: string, comment: string) =>
    withCardBusinessApi(a, undefined, (client) => client.commentSkillDraft(a, runId, name, comment)),

  /** 合并草稿到权威技能库(唯一写入)。 */
  mergeSkillTrainRun: (a: AuthSession, runId: string, name?: string) =>
    withCardBusinessApi(a, undefined, (client) => client.mergeSkillTrainRun(a, runId, name)),

  // ── 教程工作室（公开目录 / 快照 / 管理评测） ────────────────────────────

  listCommunityTutorials: (opts?: {
    cursor?: string | null;
    query?: string;
    category?: CommunityTutorialCategory | null;
    limit?: number;
    /** 经验分享只列 markdown 投稿。 */
    kind?: TutorialKind | null;
  }) => {
    const frozen = opts ? { ...opts } : undefined;
    return import("./cardBusinessApi").then((module) =>
      module.cardBusinessApi.listCommunityTutorials(frozen),
    );
  },

  getCommunityTutorial: (id: string) =>
    import("./cardBusinessApi").then((module) => module.cardBusinessApi.getCommunityTutorial(id)),

  submitCommunityTutorial: (
    a: AuthSession,
    draft: CommunityTutorialDraft,
    guard?: RequestExecutionGuard,
  ) => {
    const frozen = { ...draft };
    return withCardBusinessApi(a, guard, (client) =>
      client.submitCommunityTutorial(a, frozen, guard),
    );
  },

  submitTutorialSnapshot: (a: AuthSession, draft: TutorialSnapshotDraft) => {
    const frozen = {
      ...draft,
      selectedArtifacts: draft.selectedArtifacts.map((item) => ({ ...item })),
    };
    return withCardBusinessApi(a, undefined, (client) =>
      client.submitTutorialSnapshot(a, frozen),
    );
  },

  listMyCommunityTutorials: (a: AuthSession, cursor?: string | null) =>
    withCardBusinessApi(a, undefined, (client) => client.listMyCommunityTutorials(a, cursor)),

  /** 对话写博客的草稿卡预检：只读，和投稿同一套确定性检查（不含 AI 审核）。 */
  precheckCommunityTutorial: (
    a: AuthSession,
    draft: CommunityTutorialDraft,
    guard?: RequestExecutionGuard,
  ) => {
    const frozen = { ...draft };
    return withCardBusinessApi(a, guard, (client) =>
      client.precheckCommunityTutorial(a, frozen, guard),
    );
  },

  /** 我的某一篇投稿（作者本人）：状态、审核理由、正文。 */
  getMyCommunityTutorial: (a: AuthSession, id: string, guard?: RequestExecutionGuard) =>
    withCardBusinessApi(a, guard, (client) => client.getMyCommunityTutorial(a, id, guard)),

  /** 经验分享图片上传：原始字节（前端已压成 webp），服务端按魔数复核并去元数据。 */
  uploadTutorialImage: (a: AuthSession, file: Blob, guard?: RequestExecutionGuard) =>
    withCardBusinessApi(a, guard, (client) => client.uploadTutorialImage(a, file, guard)),

  /** 作者/管理员读取未公开稿件里的图（编辑器预览、审核预览）；返回 Blob，调用方转 object URL。 */
  fetchTutorialImage: async (a: AuthSession, sha256: string): Promise<Blob> =>
    withCardBusinessApi(a, undefined, (client) => client.fetchTutorialImage(a, sha256)),

  /** 修改已投稿的经验分享：待审 / 未通过的改后重审；已发布的审核通过前线上仍是旧版。 */
  reviseCommunityTutorial: (a: AuthSession, id: string, draft: CommunityTutorialDraft) => {
    const frozen = { ...draft };
    return withCardBusinessApi(a, undefined, (client) =>
      client.reviseCommunityTutorial(a, id, frozen),
    );
  },

  withdrawCommunityTutorial: (a: AuthSession, id: string) =>
    withCardBusinessApi(a, undefined, (client) => client.withdrawCommunityTutorial(a, id)),
};
