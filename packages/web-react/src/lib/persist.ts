/**
 * v5 会话本地持久层 —— IndexedDB 封装（按 user 命名空间）+ 历史合并纯函数。
 *
 * 设计取舍（系统架构视角）：
 *  - **权威分层**：server（gateway listSessions/getSession）是会话历史的 canonical 源；
 *    IndexedDB 只是「reload 不丢本地会话」的镜像缓存与断点续传游标载体。合并策略
 *    server-wins / 按 id 幂等（见 mergeFullServerWins / applyServerIncremental）。
 *  - **隐私按 user 命名空间**：每个用户一个独立 DB（dbNameForUser），换账号天然隔离
 *    （用户 B 永远读不到用户 A 的 DB），登出再额外 wipe 当前 user 的 DB（类比 P5 媒体
 *    缓存按 authKey 失效）。
 *  - **优雅降级**：无 IndexedDB 实现（SSR / jsdom 测试 / 隐私模式 / 存储被禁）时所有
 *    I/O 解析为 no-op/空，绝不抛——持久化是增强项，缺失不阻断对话。
 *  - **可测性**：IDBFactory 可注入（默认 globalThis.indexedDB），合并/命名空间为纯函数，
 *    无需真实 IndexedDB 即可单测核心逻辑。
 */
import type { ChatMessage } from "./chat/model";

/** IndexedDB schema 版本 + 唯一对象存储名。*/
const DB_VERSION = 1;
const STORE = "sessions";

/**
 * 持久化的会话快照。**刻意只持久 reducer 产出的稳定数据 + 断点续传游标**，剥离流式
 * 指针 / Map / in-flight 等运行期瞬态（注水后由 rebuildIndexes 重建，详见 socket.loadStored）。
 * `_lastFrameSeqByKey` / `_lastFrameSeq` 是断点续传游标（resume_failed 推进后必须落地，
 * 否则 reload 后 hello 仍发旧游标 → server 反复 resume 失败 → reload 死循环）。
 * `_maxSeq` 是 server canonical 增量游标（下次 getSession 的 sinceSeq）。
 */
export type StoredSession = {
  id: string;
  agentId: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  lastAt: number;
  updatedAt?: number;
  _lastFrameSeqByKey?: Record<string, number>;
  _lastFrameSeq?: number;
  _maxSeq?: number;
};

/** 解析可用的 IDBFactory；不可用（SSR/jsdom/禁用）返回 null。*/
function resolveFactory(explicit?: IDBFactory): IDBFactory | null {
  if (explicit) return explicit;
  try {
    return typeof indexedDB !== "undefined" ? indexedDB : null;
  } catch {
    // Firefox 隐私模式访问 indexedDB 可能抛 SecurityError。
    return null;
  }
}

/**
 * 极薄的 IndexedDB key→value 适配器（单 store）。所有方法在无 IndexedDB 时静默降级，
 * 任何底层 request 错误都 resolve 成空值（不 reject）——持久化失败绝不冒泡打断 UI。
 */
class IdbKV {
  private readonly dbName: string;
  private readonly factory: IDBFactory | null;
  private dbp: Promise<IDBDatabase | null> | null = null;

  constructor(dbName: string, factory?: IDBFactory) {
    this.dbName = dbName;
    this.factory = resolveFactory(factory);
  }

  private openDb(): Promise<IDBDatabase | null> {
    if (this.dbp) return this.dbp;
    const f = this.factory;
    if (!f) {
      this.dbp = Promise.resolve(null);
      return this.dbp;
    }
    this.dbp = new Promise<IDBDatabase | null>((resolve) => {
      let req: IDBOpenDBRequest;
      try {
        req = f.open(this.dbName, DB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
    return this.dbp;
  }

  private run<T>(
    mode: IDBTransactionMode,
    make: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T | undefined> {
    return this.openDb().then(
      (db) =>
        new Promise<T | undefined>((resolve) => {
          if (!db) {
            resolve(undefined);
            return;
          }
          let req: IDBRequest<T>;
          try {
            const tx = db.transaction(STORE, mode);
            req = make(tx.objectStore(STORE));
          } catch {
            resolve(undefined);
            return;
          }
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(undefined);
        }),
    );
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.run<T>("readonly", (s) => s.get(key) as IDBRequest<T>);
  }
  getAll<T>(): Promise<T[]> {
    return this.run<T[]>("readonly", (s) => s.getAll() as IDBRequest<T[]>).then((r) => r ?? []);
  }
  put(key: string, value: unknown): Promise<unknown> {
    return this.run("readwrite", (s) => s.put(value, key));
  }
  delete(key: string): Promise<unknown> {
    return this.run("readwrite", (s) => s.delete(key));
  }
  clear(): Promise<unknown> {
    return this.run("readwrite", (s) => s.clear());
  }
  close(): void {
    const p = this.dbp;
    this.dbp = null;
    if (p) void p.then((db) => db?.close());
  }
}

/**
 * 当前 user 的会话存储 DB 名（按 user 命名空间，隐私隔离的权威源）。
 * userId 经白名单 sanitize（DB 名只允许有限字符集，越界字符归一为 `_`）。
 */
export function dbNameForUser(userId: string | null | undefined): string {
  const safe = String(userId || "anon")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80);
  return `ocv5_sessions__${safe}`;
}

/**
 * full（server canonical 整带）合并：server 为权威在前，保留两类 local-only 消息：
 *  ① **末尾连续的乐观尾消息**（用户刚发出、server 尚未持久化的那一截：从尾部回溯到第一条
 *     server 认识的消息为止）——含流式中的 assistant/tool 等，它们尚未被 server 重写。
 *  ② **本地独有的 user 气泡**（出现在中段、非尾部那段）——用户消息是客户端权威，server 端
 *     永不以另一 id 重写它们；但 v5 当前不把用户消息 PUT 到 server（server 历史只含
 *     server-authored 的助手/委派/工具）。若像旧逻辑那样只保尾部，重连 server-wins 会丢掉
 *     夹在助手轮之前的用户输入（boss 报"会话不显示用户输入"的根因）。故额外保留这些 user 行。
 *
 * 注意只对 **user** 角色放宽：assistant/thinking/tool/agent-group 等乐观消息可能已被 server
 * 以 `srv-*` 重写，中段保留会出现重复卡片，故它们仍只保尾部（非尾部=已被取代→丢弃）。
 * 合并后按 ts 稳定排序：user 气泡 ts < 其轮 server 助手 ts → 正确落到该轮助手之前；server
 * 本就 ts 有序、尾部乐观消息 ts 最大 → 各归其位。跨设备（本地无此会话）仍需服务端持久化
 * 用户消息才能恢复——此修复彻底解决"同浏览器重连"。
 */
export function mergeFullServerWins(server: ChatMessage[], local: ChatMessage[]): ChatMessage[] {
  const serverIds = new Set<string>();
  for (const m of server) if (m?.id) serverIds.add(m.id);
  let i = local.length;
  while (i > 0 && local[i - 1]?.id && !serverIds.has(local[i - 1].id)) i--;
  const tail = local.slice(i);
  const preservedUsers = local
    .slice(0, i)
    .filter((m) => m?.role === "user" && m.id && !serverIds.has(m.id));
  if (!tail.length && !preservedUsers.length) return server;
  // 稳定排序（现代 JS Array.sort 稳定）：等 ts 时维持 server→preservedUsers→tail 的插入序。
  return [...server, ...preservedUsers, ...tail].sort((a, b) => (a?.ts ?? 0) - (b?.ts ?? 0));
}

/**
 * 增量合并（getSession ?since 返回的增量）：在 `local` 基础上，按 id 用 `incoming` 覆盖
 * 已有项（server-wins），并追加新 id。保持 local 既有顺序，新增项接在尾部。
 */
export function applyServerIncremental(
  local: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  if (!incoming.length) return local;
  const byId = new Map<string, ChatMessage>();
  for (const m of incoming) if (m?.id) byId.set(m.id, m);
  const merged = local.map((m) => (m?.id && byId.has(m.id) ? byId.get(m.id)! : m));
  const seen = new Set<string>();
  for (const m of local) if (m?.id) seen.add(m.id);
  for (const m of incoming) if (m?.id && !seen.has(m.id)) merged.push(m);
  return merged;
}

/**
 * 单一 user 命名空间下的会话持久存储。put/get/getAll/delete 直透 IdbKV，
 * wipe 清空整个命名空间（登出隐私收尾）。无 IndexedDB 时全 no-op。
 */
export class SessionStore {
  readonly userId: string;
  private readonly kv: IdbKV;
  // wipe 后置 dead：让随后到来的 flush/debounce 写（如登出 teardown 的 final flush）变 no-op，
  // 否则 live 会话会被重新写回刚清空的命名空间 → 击穿隐私 wipe。store 实例随即丢弃，
  // 同用户再登录会另建新实例（alive）。
  private dead = false;

  constructor(userId: string, factory?: IDBFactory) {
    this.userId = userId;
    this.kv = new IdbKV(dbNameForUser(userId), factory);
  }

  async putSession(s: StoredSession): Promise<void> {
    if (this.dead || !s?.id) return;
    await this.kv.put(s.id, s);
  }
  getSession(id: string): Promise<StoredSession | undefined> {
    if (this.dead) return Promise.resolve(undefined);
    return this.kv.get<StoredSession>(id);
  }
  getAll(): Promise<StoredSession[]> {
    if (this.dead) return Promise.resolve([]);
    return this.kv.getAll<StoredSession>();
  }
  async deleteSession(id: string): Promise<void> {
    if (this.dead) return;
    await this.kv.delete(id);
  }
  /** 清空本 user 命名空间（登出/隐私收尾）。同步置 dead 防 wipe 与 final flush 竞态。*/
  async wipe(): Promise<void> {
    this.dead = true;
    await this.kv.clear();
  }
  close(): void {
    this.kv.close();
  }
}
