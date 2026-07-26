// REST 客户端(Node 20 全局 fetch)。用于:setup(登录/建种子会话)、API 侧校验(与
// 用户可见断言互为佐证)、清理(DELETE e2e- 会话)。绝不碰真实用户数据——只用注入的
// canary/预发账号,会话一律 e2e- 前缀。

import { config } from './env';

export interface LoginResult {
  token: string;
  userId: string;
  credits: string;
  accessExp: number;
}

export interface SessionListItem {
  id: string;
  agentId: string;
  title: string;
  messageCount: number;
  updatedAt: number;
}

export interface SessionDetail {
  id: string;
  messages: any[];
  maxSeq?: number;
  archivedCount?: number;
  [k: string]: unknown;
}

export interface ArchivePage {
  messages: any[]; // 升序
  hasMore: boolean;
  oldestSeq: number | null;
}

/** GET /api/sessions/:id/timeline —— 前端「查看更早历史记录」真正调用的分页端点。 */
export interface TimelinePage {
  messages: any[]; // 升序
  nextCursor: string | null;
  hasMore: boolean;
  timelineGeneration: number;
  snapshotMaxSeq?: number;
}

export interface TapeRecordsPage {
  records?: any[];
  nextCursor?: number | null;
  total?: number;
}

export class Api {
  private base = config().baseUrl;
  private cachedLogin: LoginResult | null = null;

  async login(): Promise<LoginResult> {
    const cfg = config();
    // 每条用例拿到的 token 必须覆盖其完整上限与 teardown；不足才重新登录。
    // Api 是 worker-scoped，所以正常 9 条矩阵只消耗一次登录额度。
    const minimumRemainingMs = cfg.turnTimeoutMs * 2 + 90_000;
    if (this.cachedLogin && this.cachedLogin.accessExp * 1000 - Date.now() > minimumRemainingMs) {
      return this.cachedLogin;
    }
    // 登录端点有限流(每账号短窗)。缓存需要续期时仍对 429 做退避重试，防共享
    // canary 账号被其它门/并发短暂占满限流(轮询退避,非死 sleep)。
    let lastText = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`${this.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cfg.email, password: cfg.password, turnstile_token: cfg.turnstile }),
      });
      if (res.ok) {
        const j: any = await res.json();
        const result = {
          token: j.access_token,
          userId: String(j.user?.id ?? ''),
          credits: String(j.user?.credits ?? ''),
          accessExp: Number(j.access_exp),
        };
        this.cachedLogin = result;
        return result;
      }
      lastText = (await res.text()).slice(0, 200);
      if (res.status !== 429) throw new Error(`[api] login ${res.status}: ${lastText}`);
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1))); // 4s,8s,12s 退避
    }
    throw new Error(`[api] login 429(退避重试耗尽): ${lastText}`);
  }

  private authHeaders(token: string, extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${token}`, ...extra };
  }

  async listSessions(token: string): Promise<SessionListItem[]> {
    const res = await fetch(`${this.base}/api/sessions/list`, { headers: this.authHeaders(token) });
    if (!res.ok) throw new Error(`[api] sessions/list ${res.status}`);
    const j: any = await res.json();
    return j.sessions ?? [];
  }

  async currentUserId(token: string): Promise<string> {
    const res = await fetch(`${this.base}/api/me`, { headers: this.authHeaders(token) });
    if (!res.ok) throw new Error(`[api] me ${res.status}`);
    const body: any = await res.json();
    const id = body?.user?.id ?? body?.id;
    if (id === undefined || id === null || String(id).length === 0) {
      throw new Error('[api] me missing user id');
    }
    return String(id);
  }

  async getSession(token: string, id: string, since?: number): Promise<SessionDetail> {
    const url = new URL(`${this.base}/api/sessions/${id}`);
    if (typeof since === 'number') url.searchParams.set('since', String(since));
    const res = await fetch(url, { headers: this.authHeaders(token) });
    if (!res.ok) throw new Error(`[api] getSession ${id} ${res.status}`);
    return (await res.json()) as SessionDetail;
  }

  /** 复刻前端"首发时才 PUT 建会话"的行为。body 兼容前端契约(agentId/title/messages)。 */
  async putSession(
    token: string,
    id: string,
    body: { agentId?: string; title?: string; model?: string; messages?: any[]; _baseSyncedAt?: number },
  ): Promise<{ status: number; ok: boolean; text: string }> {
    const res = await fetch(`${this.base}/api/sessions/${id}`, {
      method: 'PUT',
      headers: this.authHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ agentId: 'main', ...body }),
    });
    return { status: res.status, ok: res.ok, text: await res.text() };
  }

  async deleteSession(token: string, id: string): Promise<number> {
    const res = await fetch(`${this.base}/api/sessions/${id}`, {
      method: 'DELETE',
      headers: this.authHeaders(token),
    });
    return res.status;
  }

  async getArchive(token: string, id: string, before?: number, limit = 20): Promise<ArchivePage> {
    const url = new URL(`${this.base}/api/sessions/${id}/archive`);
    if (typeof before === 'number') url.searchParams.set('before', String(before));
    url.searchParams.set('limit', String(limit));
    const res = await fetch(url, { headers: this.authHeaders(token) });
    if (!res.ok) throw new Error(`[api] archive ${id} ${res.status}`);
    return (await res.json()) as ArchivePage;
  }

  /**
   * 真实时间线分页(UI 的「查看更早历史记录」= useChatSocket.loadOlderHistory 走的同一端点)。
   * cursor 省略 = 首页;返回体里的 nextCursor 直接回传下一页。
   */
  async getTimelinePage(
    token: string,
    id: string,
    cursor?: string | null,
    limit = 100,
  ): Promise<TimelinePage> {
    const url = new URL(`${this.base}/api/sessions/${id}/timeline`);
    if (typeof cursor === 'string' && cursor) url.searchParams.set('cursor', cursor);
    url.searchParams.set('limit', String(limit));
    const res = await fetch(url, { headers: this.authHeaders(token) });
    if (!res.ok) throw new Error(`[api] timeline ${id} ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return (await res.json()) as TimelinePage;
  }

  /** 不可变 tape 真实记录分页。route-not-found → null(端点未部署);资源 404 → 抛。 */
  async getTapeRecords(
    token: string,
    id: string,
    tapeId: string,
    cursor?: number,
    limit = 50,
  ): Promise<{ status: number; body: TapeRecordsPage | { error?: string; message?: string } }> {
    const url = new URL(`${this.base}/api/sessions/${id}/tape/${tapeId}/records`);
    if (typeof cursor === 'number') url.searchParams.set('cursor', String(cursor));
    url.searchParams.set('limit', String(limit));
    const res = await fetch(url, { headers: this.authHeaders(token) });
    let body: any = {};
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    return { status: res.status, body };
  }
}
