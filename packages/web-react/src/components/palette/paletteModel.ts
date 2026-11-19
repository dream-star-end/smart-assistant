import { isModelDegraded, modelCostLabel } from "../../lib/cursorModelPicker";
import type { PaletteRecent } from "../../lib/paletteRecents";
import type { SessionNeedsYouKind } from "../../lib/sessionStatus";
import type {
  ChatProject,
  ProjectAsset,
  PublicModel,
  Session,
  SessionSearchHit,
  UserSiteItem,
} from "../../lib/types";
import {
  type LiveActivityBucket,
  collectLiveActivity,
  liveActivityItemLabel,
} from "../sidebar/liveActivity";

/**
 * Pure model of the Ctrl/⌘K palette: which rows exist, in which group, in which
 * order. The component only renders this and wires keyboard/mouse to it.
 */

export type PaletteFilter = "all" | "project" | "session" | "file";
export const PALETTE_FILTERS: readonly { id: PaletteFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "project", label: "项目" },
  { id: "session", label: "会话" },
  { id: "file", label: "文件" },
];

export function nextPaletteFilter(cur: PaletteFilter, step: 1 | -1): PaletteFilter {
  const i = PALETTE_FILTERS.findIndex((f) => f.id === cur);
  const n = PALETTE_FILTERS.length;
  return PALETTE_FILTERS[(((i + step) % n) + n) % n]!.id;
}

export type PaletteActionId =
  | "new-in-project"
  | "new-session"
  | "new-project"
  | "move-session"
  | "open-home"
  | "open-board"
  | "open-sites"
  | "open-memory"
  | "open-skills"
  | "open-cron"
  | "open-connectors"
  | "open-quick-ask";

const WORKSPACE_ACTION_IDS: ReadonlySet<PaletteActionId> = new Set([
  "open-board",
  "open-sites",
  "open-memory",
  "open-skills",
  "open-cron",
  "open-connectors",
  "open-quick-ask",
]);

const UPGRADED_WORKSPACE_ACTION_IDS: ReadonlySet<PaletteActionId> = new Set([
  "open-memory",
  "open-skills",
  "open-cron",
  "open-connectors",
  "open-quick-ask",
]);

export type PaletteAction = { id: PaletteActionId; label: string; keywords?: string; hint?: string };

/** 供 ⌘K 展示的站点最小子集，与 UserSiteItem 完全兼容。 */
export type PaletteSiteItem = Pick<
  UserSiteItem,
  "id" | "slug" | "title"
> &
  Partial<Pick<UserSiteItem, "url" | "customDomain" | "visibility" | "hasServerApi" | "lastPublishedAt" | "updatedAt">>;

export type PaletteModelMeta = {
  label: string;
  isFlagship: boolean;
  isCurrent: boolean;
  isDegraded: boolean;
  costLabel?: string;
  promoLabel?: string;
};

export type PaletteItem =
  | { kind: "project"; key: string; project: ChatProject }
  | {
      kind: "session";
      key: string;
      sessionId: string;
      title: string;
      projectId: string | null;
      /** Message-content hit: the server snippet. */
      snippet?: string;
      at?: number;
      /** 活态状态标记（待拍板 / 运行中 / 刚完成未读），用于 ⌘K 直达识别。 */
      liveBucket?: LiveActivityBucket;
      needsYouKind?: SessionNeedsYouKind;
      isSwarm?: boolean;
    }
  | { kind: "asset"; key: string; asset: ProjectAsset }
  | { kind: "site"; key: string; site: PaletteSiteItem }
  | {
      kind: "model";
      key: string;
      model: PublicModel;
      meta: PaletteModelMeta;
      disabled?: boolean;
    }
  | { kind: "action"; key: string; action: PaletteAction }
  | { kind: "move-target"; key: string; projectId: string | null; label: string; color?: string | null };

export type PaletteGroup = { id: string; label: string; items: PaletteItem[] };

export const PALETTE_PROJECT_LIMIT = 8;
export const PALETTE_SESSION_LIMIT = 20;
export const PALETTE_LIVE_LIMIT = 6;
export const PALETTE_SITE_LIMIT = 6;
export const PALETTE_SITE_IDLE_LIMIT = 4;
export const PALETTE_MODEL_LIMIT = 8;
export const PALETTE_MODEL_IDLE_LIMIT = 5;
export const PALETTE_RECENT_FALLBACK = 5;

const norm = (s: string) => s.toLowerCase();
const ASCII_FUZZY_RE = /^[a-z0-9][a-z0-9._-]{1,}$/;
const NON_FLAGSHIP_RE = /\b(mini|nano|haiku|flash|lite|small|fast-lite)\b/i;
const FLAGSHIP_RE =
  /(opus|gpt-5|gpt5|o3\b|codex|claude[-_\s]?(?:4|sonnet[-_\s]?4)|sonnet[-_\s]?4|gemini[-_\s]?(?:2\.5|3)[-_.\s]?pro|deepseek[-_\s]?v4[-_\s]?pro|glm[-_\s]?5|qwen[-_\s]?3[-_\s]?max|grok[-_\s]?(?:4|build))/i;

const PROJECT_TEMPLATE_KEYWORDS: Record<string, string> = {
  repo: "代码 仓库 code repo",
  research: "科研 调研 论文 research",
  writing: "写作 文档 长文 writing",
  blank: "通用 blank",
};

/**
 * 即时模糊匹配打分（0 = 不匹配，分数越高越靠前）：
 * - 前缀命中 > 词边界子串 > 普通子串 > 多词全命中 > ASCII 顺序子序列模糊命中（如 gp5 → GPT-5.4）。
 */
export function fuzzyMatchScore(text: string | null | undefined, query: string): number {
  const q = query.trim();
  if (!q) return 1;
  if (!text) return 0;
  const hay = norm(text);
  const needle = norm(q);

  const exactIdx = hay.indexOf(needle);
  if (exactIdx === 0) return 100;
  if (exactIdx > 0) {
    const prev = hay[exactIdx - 1] ?? " ";
    return /[\s\-_/.·›「]/.test(prev) ? 90 : 80;
  }

  const tokens = needle.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    let tokenScore = 0;
    for (const tok of tokens) {
      const s = fuzzyMatchScore(hay, tok);
      if (s === 0) return 0;
      tokenScore += s;
    }
    return Math.round((tokenScore / tokens.length) * 0.72);
  }

  if (ASCII_FUZZY_RE.test(needle)) {
    let qi = 0;
    let consecutive = 0;
    let maxConsecutive = 0;
    let firstHit = -1;
    let lastHit = -1;
    for (let hi = 0; hi < hay.length && qi < needle.length; hi += 1) {
      if (hay[hi] === needle[qi]) {
        if (firstHit < 0) firstHit = hi;
        consecutive = lastHit === hi - 1 ? consecutive + 1 : 1;
        if (consecutive > maxConsecutive) maxConsecutive = consecutive;
        lastHit = hi;
        qi += 1;
      }
    }
    if (qi === needle.length) {
      const span = lastHit - firstHit + 1;
      if (span <= needle.length * 3 + 4) {
        return 40 + Math.min(20, maxConsecutive * 5);
      }
    }
  }
  return 0;
}

export function paletteMatches(text: string | null | undefined, q: string): boolean {
  return fuzzyMatchScore(text, q) > 0;
}

export function sessionTime(s: Session): number | undefined {
  if (typeof s.lastAt === "number") return s.lastAt;
  const t = Date.parse(s.updatedAt);
  return Number.isNaN(t) ? undefined : t;
}

/** 识别强模型/旗舰模型，仅做显式标注与置顶排序，绝不隐藏或隐式降级任何模型。 */
export function isFlagshipModel(model: PublicModel): boolean {
  const rec = model as { flagship?: unknown; tier?: unknown; display_name?: unknown };
  if (rec.flagship === true || rec.tier === "flagship") return true;
  const label = typeof rec.display_name === "string" ? rec.display_name : "";
  const combined = `${model.id} ${label}`;
  if (NON_FLAGSHIP_RE.test(combined)) return false;
  if (FLAGSHIP_RE.test(combined)) return true;
  return typeof model.cost_x === "number" && Number.isFinite(model.cost_x) && model.cost_x >= 1.5;
}

export function describePaletteModel(
  model: PublicModel,
  activeModelId?: string | null,
): PaletteModelMeta {
  const dn = (model as { display_name?: unknown }).display_name;
  const label = typeof dn === "string" && dn.trim() ? dn.trim() : model.id;
  const promoRaw = (model as { promo_label?: unknown }).promo_label;
  const promoLabel = typeof promoRaw === "string" && promoRaw.trim() ? promoRaw.trim() : undefined;
  return {
    label,
    isFlagship: isFlagshipModel(model),
    isCurrent: Boolean(activeModelId && model.id === activeModelId),
    isDegraded: isModelDegraded(model),
    costLabel: modelCostLabel(model),
    promoLabel,
  };
}

function liveSearchKeywords(
  bucket: LiveActivityBucket | undefined,
  needsYouKind?: SessionNeedsYouKind,
  isSwarm?: boolean,
): string {
  if (!bucket) return "";
  if (bucket === "needs_you") {
    return needsYouKind === "approval"
      ? "待拍板 待我拍板 审批 权限 approval waiting live 活态"
      : "待回复 待拍板 回答 question waiting live 活态";
  }
  if (bucket === "running") {
    return isSwarm
      ? "协作中 蜂群 运行中 running streaming swarm live 活态"
      : "运行中 后台 running streaming live 活态";
  }
  return "刚完成 未读 已完成 unread done live 活态";
}

function sessionItem(
  s: Session,
  live?: { bucket: LiveActivityBucket; needsYouKind?: SessionNeedsYouKind; isSwarm?: boolean },
): PaletteItem {
  return {
    kind: "session",
    key: `session:${s.id}`,
    sessionId: s.id,
    title: s.title || "新对话",
    projectId: s.projectId ?? null,
    at: sessionTime(s),
    liveBucket: live?.bucket,
    needsYouKind: live?.needsYouKind,
    isSwarm: live?.isSwarm,
  };
}

function itemProjectId(item: PaletteItem): string | null | undefined {
  switch (item.kind) {
    case "project":
      return item.project.id;
    case "session":
      return item.projectId;
    case "asset":
      return item.asset.projectId;
    default:
      return undefined;
  }
}

function filterAllows(filter: PaletteFilter, item: PaletteItem): boolean {
  if (filter === "all") return true;
  if (filter === "project") return item.kind === "project";
  if (filter === "session") return item.kind === "session";
  return item.kind === "asset";
}

export type BuildPaletteInput = {
  query: string;
  filter: PaletteFilter;
  projects: readonly ChatProject[];
  sessions: readonly Session[];
  /** /api/sessions/search hits for this query (title or message). */
  messageHits?: readonly SessionSearchHit[];
  /** /api/project-assets?q= hits for this query. */
  assets?: readonly ProjectAsset[];
  currentProjectId: string | null;
  recents: readonly PaletteRecent[];
  actions: readonly PaletteAction[];
  /** 可选：活态会话数据源（与侧栏 LiveActivityStrip 同源）。 */
  isSending?: (id: string) => boolean;
  liveTerminal?: (
    id: string,
  ) => { lastOutcome?: string | null; lastErrorCode?: string | null } | undefined;
  sessionNeedsYou?: (id: string) => SessionNeedsYouKind | null | undefined;
  unreadIds?: ReadonlySet<string>;
  swarmSessionIds?: ReadonlySet<string>;
  /** 可选：站点列表（支持 ⌘K 直达站点详情）。 */
  sites?: readonly PaletteSiteItem[];
  /** 可选：显式模型列表与当前模型（仅在允许快速切换时展示）。 */
  models?: readonly PublicModel[];
  activeModelId?: string | null;
  canSelectModel?: boolean;
};

/** Rank inside one group: projects (active, then archived), chats (live first), then files/outputs. */
function rank(item: PaletteItem): number {
  if (item.kind === "project") return item.project.archivedAt ? 3 : 0;
  if (item.kind === "session") return 1;
  return 2;
}

function liveBucketPriority(bucket: LiveActivityBucket | undefined): number {
  if (bucket === "needs_you") return 0;
  if (bucket === "running") return 1;
  if (bucket === "unread_done") return 2;
  return 3;
}

function siteTime(site: PaletteSiteItem): number {
  const raw = site.lastPublishedAt || site.updatedAt;
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? 0 : ms;
}

function buildSiteItems(sites: readonly PaletteSiteItem[] | undefined, q: string): PaletteItem[] {
  if (!sites?.length) return [];
  if (!q) {
    return sites
      .slice()
      .sort((a, b) => siteTime(b) - siteTime(a))
      .slice(0, PALETTE_SITE_IDLE_LIMIT)
      .map((site) => ({ kind: "site", key: `site:${site.slug}`, site }));
  }
  return sites
    .map((site) => {
      const hay = `${site.title} ${site.slug} ${site.customDomain ?? ""} 站点 site 网站 部署`;
      const score = fuzzyMatchScore(hay, q);
      return { site, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || siteTime(b.site) - siteTime(a.site))
    .slice(0, PALETTE_SITE_LIMIT)
    .map(({ site }) => ({ kind: "site", key: `site:${site.slug}`, site }));
}

function buildModelItems(
  models: readonly PublicModel[] | undefined,
  activeModelId: string | null | undefined,
  canSelectModel: boolean | undefined,
  q: string,
): PaletteItem[] {
  if (!models?.length || !canSelectModel) return [];
  const described = models.map((model, idx) => ({
    model,
    idx,
    meta: describePaletteModel(model, activeModelId),
  }));

  const sortOrder = (
    a: { meta: PaletteModelMeta; idx: number; score?: number },
    b: { meta: PaletteModelMeta; idx: number; score?: number },
  ) => {
    if (a.meta.isDegraded !== b.meta.isDegraded) return a.meta.isDegraded ? 1 : -1;
    if ((b.score ?? 0) !== (a.score ?? 0)) return (b.score ?? 0) - (a.score ?? 0);
    if (a.meta.isCurrent !== b.meta.isCurrent) return a.meta.isCurrent ? -1 : 1;
    if (a.meta.isFlagship !== b.meta.isFlagship) return a.meta.isFlagship ? -1 : 1;
    return a.idx - b.idx;
  };

  if (!q) {
    return described
      .slice()
      .sort(sortOrder)
      .slice(0, PALETTE_MODEL_IDLE_LIMIT)
      .map(({ model, meta }) => ({
        kind: "model",
        key: `model:${model.id}`,
        model,
        meta,
        disabled: meta.isDegraded,
      }));
  }

  return described
    .map((entry) => {
      const hay = `${entry.meta.label} ${entry.model.id} ${entry.model.engine ?? ""} ${
        entry.meta.isFlagship ? "旗舰 flagship 强模型" : ""
      } 模型 model 切换`;
      const score = fuzzyMatchScore(hay, q);
      return { ...entry, score };
    })
    .filter((entry) => entry.score > 0)
    .sort(sortOrder)
    .slice(0, PALETTE_MODEL_LIMIT)
    .map(({ model, meta }) => ({
      kind: "model",
      key: `model:${model.id}`,
      model,
      meta,
      disabled: meta.isDegraded,
    }));
}

export function buildPaletteGroups(input: BuildPaletteInput): PaletteGroup[] {
  const q = input.query.trim();
  const groups: PaletteGroup[] = [];
  const projectById = new Map(input.projects.map((p) => [p.id, p]));
  const sessionById = new Map(input.sessions.map((s) => [s.id, s]));

  const liveSummary = collectLiveActivity({
    sessions: input.sessions,
    projects: input.projects,
    isSending: input.isSending,
    liveTerminal: input.liveTerminal,
    sessionNeedsYou: input.sessionNeedsYou,
    unreadIds: input.unreadIds,
    swarmSessionIds: input.swarmSessionIds,
  });
  const liveBySessionId = new Map(
    liveSummary.items.map((item) => [
      item.session.id,
      {
        bucket: item.bucket,
        needsYouKind: item.needsYouKind,
        isSwarm: item.isSwarm,
      },
    ]),
  );

  if (!q) {
    const shownLiveIds = new Set<string>();
    if (liveSummary.total > 0 && (input.filter === "all" || input.filter === "session")) {
      const liveItems = liveSummary.items.slice(0, PALETTE_LIVE_LIMIT).map((item) => {
        shownLiveIds.add(item.session.id);
        return sessionItem(item.session, {
          bucket: item.bucket,
          needsYouKind: item.needsYouKind,
          isSwarm: item.isSwarm,
        });
      });
      groups.push({ id: "live", label: "活态会话", items: liveItems });
    }

    const recentItems: PaletteItem[] = [];
    for (const r of input.recents) {
      if (r.kind === "project") {
        const p = projectById.get(r.id);
        if (p) recentItems.push({ kind: "project", key: `project:${p.id}`, project: p });
      } else {
        if (shownLiveIds.has(r.id)) continue;
        const s = sessionById.get(r.id);
        if (s) recentItems.push(sessionItem(s, liveBySessionId.get(s.id)));
      }
    }
    if (recentItems.length === 0) {
      if (input.filter === "project") {
        const activeProjects = input.projects
          .filter((p) => !p.archivedAt)
          .slice(0, PALETTE_PROJECT_LIMIT);
        for (const p of activeProjects) {
          recentItems.push({ kind: "project", key: `project:${p.id}`, project: p });
        }
      } else {
        // First use: no recents yet → the latest chats are the best guess.
        const latest = input.sessions
          .filter((s) => !s.archived && !shownLiveIds.has(s.id))
          .slice()
          .sort((a, b) => (sessionTime(b) ?? 0) - (sessionTime(a) ?? 0))
          .slice(0, PALETTE_RECENT_FALLBACK);
        recentItems.push(...latest.map((s) => sessionItem(s, liveBySessionId.get(s.id))));
      }
    }
    const shown = recentItems.filter((it) => filterAllows(input.filter, it));
    if (shown.length) groups.push({ id: "recent", label: "最近", items: shown });
  } else {
    const items: PaletteItem[] = [];
    // Projects by name (+ template keywords), archived ones last.
    const projects = input.projects
      .map((p) => {
        const extra = p.template ? (PROJECT_TEMPLATE_KEYWORDS[p.template] ?? "") : "";
        const score = fuzzyMatchScore(`${p.name} ${extra}`, q);
        return { p, score };
      })
      .filter((entry) => entry.score > 0)
      .sort(
        (a, b) =>
          Number(!!a.p.archivedAt) - Number(!!b.p.archivedAt) ||
          b.score - a.score,
      )
      .slice(0, PALETTE_PROJECT_LIMIT);
    for (const { p } of projects) items.push({ kind: "project", key: `project:${p.id}`, project: p });

    // Chats by title or live status keywords (client side), live/newest first, archived last.
    const titleHits = input.sessions
      .map((s) => {
        const live = liveBySessionId.get(s.id);
        const liveKw = live ? liveSearchKeywords(live.bucket, live.needsYouKind, live.isSwarm) : "";
        const titleScore = fuzzyMatchScore(s.title, q);
        const kwScore = liveKw ? Math.round(fuzzyMatchScore(liveKw, q) * 0.7) : 0;
        const score = Math.max(titleScore, kwScore);
        return { s, live, score };
      })
      .filter((entry) => entry.score > 0)
      .sort(
        (a, b) =>
          Number(!!a.s.archived) - Number(!!b.s.archived) ||
          liveBucketPriority(a.live?.bucket) - liveBucketPriority(b.live?.bucket) ||
          b.score - a.score ||
          (sessionTime(b.s) ?? 0) - (sessionTime(a.s) ?? 0),
      )
      .slice(0, PALETTE_SESSION_LIMIT);
    const seen = new Set<string>();
    for (const { s, live } of titleHits) {
      seen.add(s.id);
      items.push(sessionItem(s, live));
    }
    // Chats by message content (server), deduped against title hits.
    for (const h of input.messageHits ?? []) {
      if (seen.has(h.sessionId)) continue;
      seen.add(h.sessionId);
      const local = sessionById.get(h.sessionId);
      const live = liveBySessionId.get(h.sessionId);
      items.push({
        kind: "session",
        key: `session:${h.sessionId}`,
        sessionId: h.sessionId,
        title: local?.title || h.title || "新对话",
        projectId: (local ? local.projectId : h.projectId) ?? null,
        snippet: h.kind === "message" ? h.snippet : undefined,
        at: h.matchedAt,
        liveBucket: live?.bucket,
        needsYouKind: live?.needsYouKind,
        isSwarm: live?.isSwarm,
      });
    }
    // Files and outputs (server, across all projects).
    for (const a of input.assets ?? []) items.push({ kind: "asset", key: `asset:${a.id}`, asset: a });

    const visible = items.filter((it) => filterAllows(input.filter, it));
    const byRank = (list: PaletteItem[]) =>
      list
        .map((it, i) => ({ it, i }))
        .sort((x, y) => rank(x.it) - rank(y.it) || x.i - y.i)
        .map((x) => x.it);
    const cur = input.currentProjectId;
    const curProject = cur ? projectById.get(cur) : undefined;
    if (curProject) {
      const mine = visible.filter((it) => itemProjectId(it) === cur);
      const rest = visible.filter((it) => itemProjectId(it) !== cur);
      if (mine.length) groups.push({ id: "current", label: `当前项目 · ${curProject.name}`, items: byRank(mine) });
      if (rest.length) groups.push({ id: "other", label: "其他", items: byRank(rest) });
    } else if (visible.length) {
      groups.push({ id: "results", label: "搜索结果", items: byRank(visible) });
    }
  }

  if (input.filter === "all") {
    const siteItems = buildSiteItems(input.sites, q);
    if (siteItems.length) {
      groups.push({ id: "sites", label: "站点", items: siteItems });
    }

    const modelItems = buildModelItems(input.models, input.activeModelId, input.canSelectModel, q);
    if (modelItems.length) {
      groups.push({ id: "models", label: "显式切换模型", items: modelItems });
    }

    const hasUpgradedWorkspace = input.actions.some((a) => UPGRADED_WORKSPACE_ACTION_IDS.has(a.id));
    const matchedActions = input.actions.filter(
      (a) => a.id === "new-project" || paletteMatches(`${a.label} ${a.keywords ?? ""} ${a.hint ?? ""}`, q),
    );

    if (hasUpgradedWorkspace) {
      const workspaceActions = matchedActions.filter((a) => WORKSPACE_ACTION_IDS.has(a.id));
      const generalActions = matchedActions.filter((a) => !WORKSPACE_ACTION_IDS.has(a.id));
      if (workspaceActions.length) {
        groups.push({
          id: "workspace",
          label: "工作区入口",
          items: workspaceActions.map((a) => ({ kind: "action", key: `action:${a.id}`, action: a })),
        });
      }
      if (generalActions.length) {
        groups.push({
          id: "actions",
          label: "操作",
          items: generalActions.map((a) => ({ kind: "action", key: `action:${a.id}`, action: a })),
        });
      }
    } else if (matchedActions.length) {
      groups.push({
        id: "actions",
        label: "操作",
        items: matchedActions.map((a) => ({ kind: "action", key: `action:${a.id}`, action: a })),
      });
    }
  }
  return groups;
}

/** Step two of 「移动当前会话到…」: every active project except the chat's own, plus 未分类. */
export function buildMoveTargets(
  projects: readonly ChatProject[],
  session: Pick<Session, "projectId" | "title">,
  query: string,
): PaletteGroup[] {
  const q = query.trim();
  const items: PaletteItem[] = [];
  for (const p of projects) {
    if (p.archivedAt || p.id === (session.projectId ?? null) || !paletteMatches(p.name, q)) continue;
    items.push({ kind: "move-target", key: `move:${p.id}`, projectId: p.id, label: p.name, color: p.color });
  }
  if (session.projectId && paletteMatches("未分类", q)) {
    items.push({ kind: "move-target", key: "move:none", projectId: null, label: "未分类" });
  }
  return [{ id: "move", label: `把「${session.title || "新对话"}」移动到…`, items }];
}

export function flattenPalette(groups: readonly PaletteGroup[]): PaletteItem[] {
  return groups.flatMap((g) => g.items);
}

/** 供 CommandPalette 渲染活态会话胶囊文字使用。 */
export function paletteLiveLabel(item: Extract<PaletteItem, { kind: "session" }>): string | null {
  if (!item.liveBucket) return null;
  return liveActivityItemLabel({
    bucket: item.liveBucket,
    needsYouKind: item.needsYouKind,
    isSwarm: item.isSwarm,
  });
}

/** Actions available right now, before query filtering (new-project label carries the query). */
export function paletteActions(opts: {
  query: string;
  currentProject: Pick<ChatProject, "id" | "name"> | null;
  canNewInProject: boolean;
  canMoveSession: boolean;
  canOpenHome: boolean;
  canOpenBoard: boolean;
  canOpenSites?: boolean;
  canOpenManage?: boolean;
  canOpenQuickAsk?: boolean;
}): PaletteAction[] {
  const q = opts.query.trim();
  const out: PaletteAction[] = [];
  if (opts.currentProject && opts.canNewInProject) {
    out.push({
      id: "new-in-project",
      label: `新建会话于「${opts.currentProject.name}」`,
      keywords: "新建会话 new chat",
    });
  } else {
    out.push({ id: "new-session", label: "新建会话", keywords: "new chat" });
  }
  if (opts.canMoveSession) out.push({ id: "move-session", label: "移动当前会话到…", keywords: "move 项目" });
  if (opts.currentProject && opts.canOpenHome) {
    out.push({ id: "open-home", label: "打开项目主页", keywords: `home ${opts.currentProject.name}` });
  }
  if (opts.canOpenBoard) {
    out.push({
      id: "open-board",
      label: "打开看板",
      keywords: "board kanban 任务看板 任务",
      hint: "任务看板",
    });
  }
  if (opts.canOpenSites) {
    out.push({
      id: "open-sites",
      label: "打开站点",
      keywords: "sites website 站点工作区 站点 网站 部署",
      hint: "站点工作区",
    });
  }
  if (opts.canOpenManage) {
    out.push(
      {
        id: "open-memory",
        label: "记忆管理",
        keywords: "memory 记忆 管理中心 长期记忆",
        hint: "管理中心",
      },
      {
        id: "open-skills",
        label: "技能库",
        keywords: "skills 技能 管理中心 工作流",
        hint: "管理中心",
      },
      {
        id: "open-cron",
        label: "定时任务",
        keywords: "cron schedule 定时 计划任务 自动运行",
        hint: "管理中心",
      },
      {
        id: "open-connectors",
        label: "插件与连接器",
        keywords: "connectors plugins 插件 连接器 mcp",
        hint: "管理中心",
      },
    );
  }
  if (opts.canOpenQuickAsk) {
    out.push({
      id: "open-quick-ask",
      label: "打开快问小窗",
      keywords: "quick ask 快问 支线 小窗 速问",
      hint: "支线快问",
    });
  }
  out.push({ id: "new-project", label: q ? `新建项目「${q}」` : "新建项目…", keywords: "new project" });
  return out;
}
