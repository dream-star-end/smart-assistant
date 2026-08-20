import type { ChatProject, Session, SessionSearchHit } from "../../lib/types";
import {
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
  GROUP_HEADER_HEIGHT,
  HINT_ROW_HEIGHT,
  PROJECT_ROW_HEIGHT,
  SEARCH_HIT_HEIGHT,
  SESSION_ROW_HEIGHT,
  SESSION_ROW_HEIGHT_PREVIEW,
} from "./constants";

export type FlatItem =
  | { kind: "header"; key: string; label: string; height: number }
  | { kind: "session"; key: string; session: Session; indent?: boolean; height: number }
  | { kind: "project"; key: string; project: ChatProject; count: number; collapsed: boolean; height: number }
  | { kind: "hint"; key: string; text: string; height: number }
  | { kind: "searchHit"; key: string; hit: SessionSearchHit; height: number }
  | { kind: "archivedToggle"; key: string; count: number; expanded: boolean; height: number };

export type FlattenInput = {
  searching: boolean;
  showProjects: boolean;
  showPreview: boolean;
  pinned: Session[];
  projects: ChatProject[];
  projectSessions: Map<string, Session[]>;
  sessions: Session[];
  ungroupedGroups: [string, Session[]][];
  collapsedProjectIds?: Set<string>;
  archived: Session[];
  archivedExpanded: boolean;
  archivedLoading?: boolean;
  searchHits: SessionSearchHit[];
  searchRemote: "idle" | "loading" | "empty" | "error";
  localEmpty: boolean;
};

function virtualDefaultProject(count: number): ChatProject {
  return {
    id: DEFAULT_PROJECT_ID,
    name: DEFAULT_PROJECT_NAME,
    sortOrder: Number.MAX_SAFE_INTEGER,
    createdAt: 0,
    updatedAt: 0,
    sessionCount: count,
  };
}

export function flattenSidebarItems(input: FlattenInput): FlatItem[] {
  const sessionH = input.showPreview ? SESSION_ROW_HEIGHT_PREVIEW : SESSION_ROW_HEIGHT;
  const items: FlatItem[] = [];

  if (input.searching) {
    for (const [label, list] of input.ungroupedGroups) {
      if (label) items.push({ kind: "header", key: `h-${label}`, label, height: GROUP_HEADER_HEIGHT });
      for (const s of list) {
        items.push({ kind: "session", key: `s-${s.id}`, session: s, height: sessionH });
      }
    }
    if (input.searchRemote === "loading") {
      items.push({ kind: "hint", key: "search-loading", text: "正在搜索消息…", height: HINT_ROW_HEIGHT });
    } else if (input.searchRemote === "error") {
      items.push({ kind: "hint", key: "search-error", text: "消息搜索失败", height: HINT_ROW_HEIGHT });
    } else if (input.searchRemote === "empty" && input.searchHits.length === 0) {
      items.push({
        kind: "hint",
        key: "search-empty-msg",
        text: input.localEmpty ? "没有匹配的会话" : "没有匹配的消息内容",
        height: HINT_ROW_HEIGHT,
      });
    }
    if (input.searchHits.length > 0) {
      items.push({
        kind: "header",
        key: "h-msg-hits",
        label: "消息内容匹配",
        height: GROUP_HEADER_HEIGHT,
      });
      for (const hit of input.searchHits) {
        items.push({ kind: "searchHit", key: `hit-${hit.sessionId}-${hit.matchedAt}`, hit, height: SEARCH_HIT_HEIGHT });
      }
    }
    if (items.length === 0 && input.localEmpty) {
      items.push({ kind: "hint", key: "search-empty", text: "没有匹配的会话", height: HINT_ROW_HEIGHT });
    }
    return items;
  }

  if (input.pinned.length > 0) {
    items.push({ kind: "header", key: "h-pinned", label: "置顶", height: GROUP_HEADER_HEIGHT });
    for (const s of input.pinned) {
      items.push({ kind: "session", key: `s-${s.id}`, session: s, height: sessionH });
    }
  }

  if (input.showProjects) {
    items.push({ kind: "header", key: "h-projects", label: "项目", height: GROUP_HEADER_HEIGHT });
    for (const p of input.projects) {
      const kids = input.projectSessions.get(p.id) ?? [];
      const count = input.sessions.filter((s) => s.projectId === p.id && !s.archived).length;
      const collapsed = input.collapsedProjectIds?.has(p.id) ?? false;
      items.push({ kind: "project", key: `p-${p.id}`, project: p, count, collapsed, height: PROJECT_ROW_HEIGHT });
      if (!collapsed) {
        if (kids.length === 0) {
          items.push({ kind: "hint", key: `p-empty-${p.id}`, text: "暂无会话", height: HINT_ROW_HEIGHT });
        }
        for (const s of kids) {
          items.push({ kind: "session", key: `s-${s.id}`, session: s, indent: true, height: sessionH });
        }
      }
    }
  }

  const defaultKids = input.ungroupedGroups.flatMap(([, list]) => list);
  const defaultCollapsed = input.collapsedProjectIds?.has(DEFAULT_PROJECT_ID) ?? false;
  items.push({
    kind: "project",
    key: `p-${DEFAULT_PROJECT_ID}`,
    project: virtualDefaultProject(defaultKids.length),
    count: defaultKids.length,
    collapsed: defaultCollapsed,
    height: PROJECT_ROW_HEIGHT,
  });
  if (!defaultCollapsed) {
    if (defaultKids.length === 0) {
      items.push({
        kind: "hint",
        key: `p-empty-${DEFAULT_PROJECT_ID}`,
        text: "暂无会话",
        height: HINT_ROW_HEIGHT,
      });
    }
    for (const s of defaultKids) {
      items.push({ kind: "session", key: `s-${s.id}`, session: s, indent: true, height: sessionH });
    }
  }

  items.push({
    kind: "archivedToggle",
    key: "archived-toggle",
    count: input.archived.length,
    expanded: input.archivedExpanded,
    height: PROJECT_ROW_HEIGHT,
  });
  if (input.archivedExpanded) {
    if (input.archivedLoading) {
      items.push({ kind: "hint", key: "archived-loading", text: "正在加载已归档…", height: HINT_ROW_HEIGHT });
    } else if (input.archived.length === 0) {
      items.push({ kind: "hint", key: "archived-empty", text: "没有已归档的会话", height: HINT_ROW_HEIGHT });
    }
    for (const s of input.archived) {
      items.push({ kind: "session", key: `s-${s.id}`, session: s, height: sessionH });
    }
  }

  return items;
}

export function itemOffsets(items: FlatItem[]): number[] {
  const out = [0];
  let acc = 0;
  for (const it of items) {
    acc += it.height;
    out.push(acc);
  }
  return out;
}

export function findIndexAtOffset(offsets: number[], y: number): number {
  if (offsets.length < 2) return 0;
  let lo = 0;
  let hi = offsets.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
