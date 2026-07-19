// REST 客户端(Node 20 全局 fetch)。用于:setup(登录/建种子会话)、API 侧校验(与
// 用户可见断言互为佐证)、清理(DELETE e2e- 会话)。绝不碰真实用户数据——只用注入的
// canary/预发账号,会话一律 e2e- 前缀。

import { config } from './env';

export interface LoginResult {
  token: string;
  userId: string;
  credits: string;
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

export interface TapeRecordsPage {
  records?: any[];
  nextCursor?: number | null;
  total?: number;
}

export class Api {
  private base = config().baseUrl;

  async login(): Promise<LoginResult> {
    const cfg = config();
    // 登录端点有限流(每账号短窗)。逐条用例各登录一次,serial 跑本不该撞;但仍对 429
    // 做退避重试,防共享 canary 账号被其它门/并发短暂占满限流(轮询退避,非死 sleep)。
    let lastText = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`${this.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cfg.email, password: cfg.password, turnstile_token: cfg.turnstile }),
      });
      if (res.ok) {
        const j: any = await res.json();
        return { token: j.access_token, userId: String(j.user?.id ?? ''), credits: String(j.user?.credits ?? '') };
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

  /** §9 折叠卷/超大内容分页。route-not-found → null(端点未部署);资源 404 → 抛。 */
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
