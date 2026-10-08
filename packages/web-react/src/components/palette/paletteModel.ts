import type { PaletteRecent } from "../../lib/paletteRecents";
import type { ChatProject, ProjectAsset, Session, SessionSearchHit } from "../../lib/types";

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
  | "open-board";

export type PaletteAction = { id: PaletteActionId; label: string; keywords?: string };

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
    }
  | { kind: "asset"; key: string; asset: ProjectAsset }
  | { kind: "action"; key: string; action: PaletteAction }
  | { kind: "move-target"; key: string; projectId: string | null; label: string; color?: string | null };

export type PaletteGroup = { id: string; label: string; items: PaletteItem[] };

export const PALETTE_PROJECT_LIMIT = 8;
export const PALETTE_SESSION_LIMIT = 20;
export const PALETTE_RECENT_FALLBACK = 5;

const norm = (s: string) => s.toLowerCase();
export function paletteMatches(text: string | null | undefined, q: string): boolean {
  if (!q) return true;
  return !!text && norm(text).includes(norm(q));
}

export function sessionTime(s: Session): number | undefined {
  if (typeof s.lastAt === "number") return s.lastAt;
  const t = Date.parse(s.updatedAt);
  return Number.isNaN(t) ? undefined : t;
}

function sessionItem(s: Session): PaletteItem {
  return {
    kind: "session",
    key: `session:${s.id}`,
    sessionId: s.id,
    title: s.title || "新对话",
    projectId: s.projectId ?? null,
    at: sessionTime(s),
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
};

/** Rank inside one group: projects (active, then archived), chats, then files/outputs. */
function rank(item: PaletteItem): number {
  if (item.kind === "project") return item.project.archivedAt ? 3 : 0;
  if (item.kind === "session") return 1;
  return 2;
}

export function buildPaletteGroups(input: BuildPaletteInput): PaletteGroup[] {
  const q = input.query.trim();
  const groups: PaletteGroup[] = [];
  const projectById = new Map(input.projects.map((p) => [p.id, p]));
  const sessionById = new Map(input.sessions.map((s) => [s.id, s]));

  if (!q) {
    const recentItems: PaletteItem[] = [];
    for (const r of input.recents) {
      if (r.kind === "project") {
        const p = projectById.get(r.id);
        if (p) recentItems.push({ kind: "project", key: `project:${p.id}`, project: p });
      } else {
        const s = sessionById.get(r.id);
        if (s) recentItems.push(sessionItem(s));
      }
    }
    if (recentItems.length === 0) {
      // First use: no recents yet → the latest chats are the best guess.
      const latest = input.sessions
        .filter((s) => !s.archived)
        .slice()
        .sort((a, b) => (sessionTime(b) ?? 0) - (sessionTime(a) ?? 0))
        .slice(0, PALETTE_RECENT_FALLBACK);
      recentItems.push(...latest.map(sessionItem));
    }
    const shown = recentItems.filter((it) => filterAllows(input.filter, it));
    if (shown.length) groups.push({ id: "recent", label: "最近", items: shown });
  } else {
    const items: PaletteItem[] = [];
    // Projects by name, archived ones last.
    const projects = input.projects
      .filter((p) => paletteMatches(p.name, q))
      .sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt))
      .slice(0, PALETTE_PROJECT_LIMIT);
    for (const p of projects) items.push({ kind: "project", key: `project:${p.id}`, project: p });
    // Chats by title (client side), newest first, archived last.
    const titleHits = input.sessions
      .filter((s) => paletteMatches(s.title, q))
      .sort(
        (a, b) =>
          Number(!!a.archived) - Number(!!b.archived) || (sessionTime(b) ?? 0) - (sessionTime(a) ?? 0),
      )
      .slice(0, PALETTE_SESSION_LIMIT);
    const seen = new Set<string>();
    for (const s of titleHits) {
      seen.add(s.id);
      items.push(sessionItem(s));
    }
    // Chats by message content (server), deduped against title hits.
    for (const h of input.messageHits ?? []) {
      if (seen.has(h.sessionId)) continue;
      seen.add(h.sessionId);
      const local = sessionById.get(h.sessionId);
      items.push({
        kind: "session",
        key: `session:${h.sessionId}`,
        sessionId: h.sessionId,
        title: local?.title || h.title || "新对话",
        projectId: (local ? local.projectId : h.projectId) ?? null,
        snippet: h.kind === "message" ? h.snippet : undefined,
        at: h.matchedAt,
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
    const actions = input.actions.filter(
      (a) => a.id === "new-project" || paletteMatches(`${a.label} ${a.keywords ?? ""}`, q),
    );
    if (actions.length) {
      groups.push({
        id: "actions",
        label: "操作",
        items: actions.map((a) => ({ kind: "action", key: `action:${a.id}`, action: a })),
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

/** Actions available right now, before query filtering (new-project label carries the query). */
export function paletteActions(opts: {
  query: string;
  currentProject: Pick<ChatProject, "id" | "name"> | null;
  canNewInProject: boolean;
  canMoveSession: boolean;
  canOpenHome: boolean;
  canOpenBoard: boolean;
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
  if (opts.canOpenBoard) out.push({ id: "open-board", label: "打开看板", keywords: "board kanban 任务" });
  out.push({ id: "new-project", label: q ? `新建项目「${q}」` : "新建项目…", keywords: "new project" });
  return out;
}
