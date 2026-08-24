/** Unified project scope: chat facade ↔ board work project. Do not merge the tables. */

export type ProjectScopeKind = "all" | "ungrouped" | "chat" | "work";

export type ProjectScopeToken = "all" | "none" | string;

export type ChatProjectLike = {
  id: string;
  name: string;
  boardProjectId?: string | null;
};

export type WorkProjectLike = {
  id: string;
  key: string;
  name: string;
  archivedAt?: number | null;
};

export type ResolvedProjectScope = {
  kind: ProjectScopeKind;
  token: ProjectScopeToken;
  chatProject: ChatProjectLike | null;
  workProject: WorkProjectLike | null;
  bound: boolean;
  /** Session search filter: undefined = no filter, null = ungrouped, string = chat_projects.id */
  chatProjectIdForFilter: string | null | undefined;
  invalid: boolean;
};

export const PROJECT_SCOPE_QUERY = "project";
export const PROJECT_SCOPE_STORAGE_PREFIX = "oc_v5_project_scope:";
export const UNBOUND_BOARD_COPY = "该会话项目未绑定看板";

/** Taskboard / Cost / Weekly: only a work project may query; never undefined=global. */
export function boardWorkQuery(
  scope: Pick<ResolvedProjectScope, "kind" | "workProject">,
): { projectId: string } | { blocked: string } {
  if (scope.kind === "work" && scope.workProject?.id) {
    return { projectId: scope.workProject.id };
  }
  return { blocked: UNBOUND_BOARD_COPY };
}

export function parseProjectScopeToken(raw: string | null | undefined): ProjectScopeToken | null {
  if (raw == null) return null;
  const v = raw.trim();
  if (!v) return null;
  if (v === "all" || v === "none") return v;
  if (v.length < 8 || v.length > 64) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(v)) return null;
  return v;
}

export function serializeProjectScopeToken(token: ProjectScopeToken): string {
  return token;
}

export function projectScopeStorageKey(userId: string): string {
  return `${PROJECT_SCOPE_STORAGE_PREFIX}${userId}`;
}

export function withProjectParam(input: URLSearchParams, token: ProjectScopeToken | null): URLSearchParams {
  const next = new URLSearchParams(input);
  if (!token || token === "all") next.delete(PROJECT_SCOPE_QUERY);
  else next.set(PROJECT_SCOPE_QUERY, token);
  return next;
}

export function isWorkScope(scope: Pick<ResolvedProjectScope, "kind">): boolean {
  return scope.kind === "work";
}

/**
 * Resolve a URL/local token against live lists.
 * Unknown / archived work projects fail-closed to `all` with `invalid: true`.
 */
export function resolveProjectScope(opts: {
  token: ProjectScopeToken | null;
  chatProjects: readonly ChatProjectLike[];
  workProjects: readonly WorkProjectLike[];
}): ResolvedProjectScope {
  const chats = opts.chatProjects;
  const works = opts.workProjects.filter((p) => !p.archivedAt);
  const token = opts.token ?? "all";

  const empty = (kind: ProjectScopeKind, t: ProjectScopeToken, invalid: boolean): ResolvedProjectScope => ({
    kind,
    token: t,
    chatProject: null,
    workProject: null,
    bound: false,
    chatProjectIdForFilter: kind === "ungrouped" ? null : undefined,
    invalid,
  });

  if (token === "all") return empty("all", "all", false);
  if (token === "none") return empty("ungrouped", "none", false);

  const work = works.find((p) => p.id === token);
  if (work) {
    const chat = chats.find((c) => c.boardProjectId === work.id) ?? null;
    return {
      kind: "work",
      token: work.id,
      chatProject: chat,
      workProject: work,
      bound: Boolean(chat),
      chatProjectIdForFilter: chat?.id,
      invalid: false,
    };
  }

  const archivedWork = opts.workProjects.find((p) => p.id === token && p.archivedAt);
  if (archivedWork) return empty("all", "all", true);

  const chat = chats.find((c) => c.id === token);
  if (chat) {
    const boundWork = chat.boardProjectId
      ? works.find((p) => p.id === chat.boardProjectId) ?? null
      : null;
    if (boundWork) {
      return {
        kind: "work",
        token: boundWork.id,
        chatProject: chat,
        workProject: boundWork,
        bound: true,
        chatProjectIdForFilter: chat.id,
        invalid: false,
      };
    }
    return {
      kind: "chat",
      token: chat.id,
      chatProject: chat,
      workProject: null,
      bound: false,
      chatProjectIdForFilter: chat.id,
      invalid: false,
    };
  }

  return empty("all", "all", true);
}

export function preferredScopeToken(scope: ResolvedProjectScope): ProjectScopeToken {
  if (scope.kind === "work" && scope.workProject) return scope.workProject.id;
  if (scope.kind === "chat" && scope.chatProject) return scope.chatProject.id;
  if (scope.kind === "ungrouped") return "none";
  return "all";
}

export function projectScopeSelectOptions(opts: {
  chatProjects: readonly ChatProjectLike[];
  workProjects: readonly WorkProjectLike[];
  variant?: "full" | "work";
}): { value: string; label: string; disabled?: boolean }[] {
  const works = opts.workProjects.filter((p) => !p.archivedAt);
  const options: { value: string; label: string; disabled?: boolean }[] = [
    { value: "all", label: "全部项目" },
    { value: "none", label: "未归类" },
  ];
  for (const w of works) {
    options.push({
      value: w.id,
      label: `${w.key} ${w.name}`,
    });
  }
  if (opts.variant === "work") return options;
  const boundChatIds = new Set(
    opts.chatProjects.filter((c) => c.boardProjectId && works.some((w) => w.id === c.boardProjectId)).map((c) => c.id),
  );
  const unbound = opts.chatProjects.filter((c) => !boundChatIds.has(c.id));
  for (const c of unbound) {
    options.push({ value: c.id, label: `会话组 · ${c.name}` });
  }
  return options;
}
