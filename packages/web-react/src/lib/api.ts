import type { AuthSession, Billing, Message, Session, StreamHandlers, User } from "./types";

/**
 * 静默刷新：鉴权请求命中 HTTP 401 时，透明调用一次 /auth/refresh，成功则用新 token 重放一次原请求。
 *
 * 设计要点（避免重复登录、又不引入刷新风暴）：
 * - `make(token)` 是“用某个 token 发起一次请求”的工厂，便于带新 token 原样重放。
 * - 每次调用至多刷新一次：首发 401 → refresh → 重放；重放仍失败就如实返回（不再刷新）。
 * - refresh 走 credentials:'include' + 同源（浏览器自动带 __Host-oc_refresh cookie 与 Origin），
 *   后端据此轮换 cookie 并下发新 access token；其本身绝不走此包装（否则会自我递归）。
 * - refresh 失败（401）即视为会话过期：回写 onExpired，让 App 清鉴权回登录页，并把 401 原样抛给上层。
 */
// 每个 AuthSession 的共享刷新锁（singleflight）：并发 401 只发一次 /auth/refresh。
// 否则多个请求会用同一个 __Host-oc_refresh cookie 并发刷新，第二个携带已轮换的旧 cookie
// 到后端会被判 reuse → 撤销整个 token family → 正常用户被踢下线。
const refreshInFlight = new WeakMap<AuthSession, Promise<string | null>>();

function refreshOnce(a: AuthSession): Promise<string | null> {
  let pending = refreshInFlight.get(a);
  if (!pending) {
    pending = (async () => {
      const refreshed = await api.refresh();
      if (refreshed) {
        a.setToken(refreshed.accessToken);
        return refreshed.accessToken;
      }
      a.onExpired();
      return null;
    })().finally(() => refreshInFlight.delete(a));
    refreshInFlight.set(a, pending);
  }
  return pending;
}

async function callWithRefresh(
  a: AuthSession,
  make: (token: string) => Promise<Response>,
): Promise<Response> {
  const usedToken = a.getToken();
  const res = await make(usedToken);
  if (res.status !== 401) return res;
  // 若期间别的并发请求已刷新出新 token，直接用新 token 重放，不再触发 refresh。
  const current = a.getToken();
  const newToken = current && current !== usedToken ? current : await refreshOnce(a);
  if (!newToken) {
    // 刷新失败 → 会话过期（onExpired 已在 refreshOnce 内触发一次），把原始 401 交回上层。
    return res;
  }
  // 用新 token 重放一次（最多一次，重放仍失败不再刷新）。
  return make(newToken);
}

/**
 * 拼鉴权头：身份完全由 JWT(sub) 决定，只带 Bearer，不再自报 x-openclaude-trial-* 头。
 * 用显式 token 入参（而非读 session 当前值），便于 callWithRefresh 带新 token 原样重放。
 */
function bearerHeaders(token: string, json = false): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
  if (json) h["content-type"] = "application/json";
  return h;
}

/** 把 x-request-id 拼到错误信息末尾，方便用户反馈、运维追溯。 */
function withReqId(msg: string, res: Response): string {
  const id = res.headers.get("x-request-id");
  return id ? `${msg}（追踪号 ${id}）` : msg;
}

async function jsonOrThrow<T>(p: Promise<Response> | Response): Promise<T> {
  const res = await p;
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try {
      const b = await res.json();
      msg = (b?.error?.message as string) || (b?.message as string) || msg;
    } catch {
      /* ignore */
    }
    throw new Error(withReqId(msg, res));
  }
  return (await res.json()) as T;
}

export const api = {
  /**
   * P2a 邮箱+密码登录。成功返回内存态 accessToken + 用户信息（不落地）。
   * 失败时抛出后端 error.message（401 为通用文案），并按既有约定附带追踪号。
   */
  async login(email: string, password: string): Promise<{ accessToken: string; user: User }> {
    const res = await fetch("/api/v4/auth/login", {
      method: "POST",
      // credentials:'include' 让浏览器接收并存下 HttpOnly 刷新 cookie（同源），后续 refresh 才能用。
      credentials: "include",
      headers: { Accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      let msg = "登录失败";
      try {
        const b = await res.json();
        msg = (b?.error?.message as string) || msg;
      } catch {
        /* ignore */
      }
      throw new Error(withReqId(msg, res));
    }
    const b = (await res.json()) as { accessToken: string; user: User };
    return { accessToken: b.accessToken, user: b.user };
  },

  /**
   * 静默刷新：无 body、无 Authorization，仅凭同源 HttpOnly 刷新 cookie 换新 access token。
   * 浏览器在同源 fetch 上自动带 Origin（满足后端 CSRF 校验）。200 返回解析体，否则 null。
   * 该调用绝不经 callWithRefresh 包装，避免 401 时自我递归。
   */
  async refresh(): Promise<{ accessToken: string; user: User } | null> {
    try {
      const res = await fetch("/api/v4/auth/refresh", {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      const b = (await res.json()) as { accessToken: string; user: User };
      return { accessToken: b.accessToken, user: b.user };
    } catch {
      return null;
    }
  },

  /**
   * P2b-2 改密：必须验当前密码。成功后后端撤销该用户全部 refresh 会话（含当前），前端须重新登录。
   * 失败抛后端 error.message（含追踪号）。
   */
  changePassword: (a: AuthSession, currentPassword: string, newPassword: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch("/api/v4/auth/change-password", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ currentPassword, newPassword }),
        }),
      ),
    ),

  /** 主动登出：吊销刷新 cookie。错误一律吞掉（前端清状态即视为已登出）。 */
  async logout(): Promise<void> {
    try {
      await fetch("/api/v4/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
    } catch {
      /* ignore */
    }
  },

  me: (a: AuthSession) =>
    jsonOrThrow<{ user: User }>(
      callWithRefresh(a, (t) =>
        fetch("/api/v4/me", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((r) => r.user),

  /** 余额 + 账单流水。后端返回扁平 {currency, balanceCents, ledger}；失败返回 null（UI 静默不显示）。 */
  billing: (a: AuthSession): Promise<Billing | null> =>
    jsonOrThrow<Billing & { ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch("/api/v4/billing/summary", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    )
      .then((b) => ({ currency: b.currency, balanceCents: b.balanceCents, ledger: b.ledger || [] }))
      .catch(() => null),

  listSessions: (a: AuthSession) =>
    jsonOrThrow<{ sessions: Session[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/v4/chat/sessions", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((r) => r.sessions),

  getMessages: (a: AuthSession, id: string) =>
    jsonOrThrow<{ session: Session; messages: Message[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/v4/chat/sessions/${encodeURIComponent(id)}/messages`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  createSession: (a: AuthSession, title = "新对话") =>
    jsonOrThrow<{ session: Session }>(
      callWithRefresh(a, (t) =>
        fetch("/api/v4/chat/sessions", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ title }),
        }),
      ),
    ).then((r) => r.session),

  renameSession: (a: AuthSession, id: string, title: string) =>
    jsonOrThrow<{ session: Session }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/v4/chat/sessions/${encodeURIComponent(id)}`, {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ title }),
        }),
      ),
    ).then((r) => r.session),

  deleteSession: (a: AuthSession, id: string) =>
    callWithRefresh(a, (t) =>
      fetch(`/api/v4/chat/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
        headers: bearerHeaders(t),
      }),
    ).then((res) => {
      if (!res.ok && res.status !== 404) throw new Error(`删除失败 (${res.status})`);
    }),

  /** Returns true if the upstream sent an explicit `done` frame. */
  async stream(
    a: AuthSession,
    sessionId: string,
    content: string,
    h: StreamHandlers,
    signal?: AbortSignal,
    agentId?: string,
  ): Promise<boolean> {
    const res = await callWithRefresh(a, (t) =>
      fetch(`/api/v4/chat/sessions/${encodeURIComponent(sessionId)}/stream`, {
        method: "POST",
        credentials: "include",
        headers: bearerHeaders(t, true),
        // 只发 agentId：模型与人设由后端权威决定，前端不再传 model/system。
        body: JSON.stringify({ content, ...(agentId ? { agentId } : {}) }),
        signal,
      }),
    );
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream") || !res.body) {
      const body = await jsonOrThrow<{ session: Session; messages: Message[] }>(res);
      h.onDone({ session: body.session, messages: body.messages });
      return true;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let doneSeen = false;
    const handleEvent = (raw: string) => {
      // SSE events may carry multiple `data:` lines — concatenate them.
      const data = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) return;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(data);
      } catch {
        return;
      }
      if (frame.type === "delta") h.onDelta(String(frame.text || ""));
      else if (frame.type === "tool_card" && h.onToolCard)
        h.onToolCard({
          id: String(frame.id),
          title: String(frame.title || "工具"),
          status: String(frame.status || "done"),
          evidence: (frame.evidence as string[]) || [],
        });
      else if (frame.type === "error" && h.onError) {
        const tr = frame.trace as { requestId?: string } | undefined;
        h.onError({
          code: String(frame.code || "internal"),
          message: String(frame.message || "生成失败，请重试"),
          requestId: tr?.requestId,
        });
      } else if (frame.type === "done") {
        doneSeen = true;
        h.onDone({ session: frame.session as Session, messages: frame.messages as Message[] });
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const evt = buffer.slice(0, idx);
        buffer = buffer.slice(idx + buffer.slice(idx).match(/^\r?\n\r?\n/)![0].length);
        handleEvent(evt);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleEvent(buffer);
    return doneSeen;
  },
};
