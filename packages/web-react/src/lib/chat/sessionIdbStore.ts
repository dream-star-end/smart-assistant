/**
 * v5 会话本地 IndexedDB 持久存储（`SessionStore` + 双库事务队列 `IdbKV`）。
 *
 * 从 `lib/persist.ts` 抽离的纯浏览器存储层（OCV5-490 / OCV5-928）：
 *  - 按 user 命名空间隔离（`ocv5_sessions__<safeUser>` + `ocv5_dispatches__<safeUser>`）；
 *  - 会话缓存库保持无显式版本号（防跨版本降级报错），精确出站/控制日志独立使用 v1 库；
 *  - 无 IndexedDB 环境（SSR / jsdom / 隐私模式禁用）自动降级为安全 no-op / 显式事务拒绝。
 */
import type { ChatMessage, ChatRoutingSnapshot } from "./model";
import type {
  InboundControlStop,
  InboundMessage,
  InboundPermissionResponse,
} from "./frames";
import { sessionTitleFromText } from "../sessionTitle";

/** A browser turn that has not yet received the server's durable-admission
 * acknowledgement. The exact wire payload is journaled without a count/byte
 * cap so reload/reconnect can replay the same idempotent logical turn. */
export type StoredPendingDispatch = {
  msgId: string;
  payload: InboundMessage;
  enqueuedAt: number;
};

export type StoredPendingDispatchRecord = StoredPendingDispatch & {
  sessId: string;
};

export type StoredPendingControl = {
  kind: "control";
  sessId: string;
  controlId: string;
  controlKind: "stop" | "permission";
  clientMessageId?: string;
  requestId?: string;
  behavior?: "allow" | "deny";
  agentId: string;
  payload:
    | (InboundControlStop & { controlId: string })
    | (InboundPermissionResponse & { controlId: string });
  enqueuedAt: number;
  attempt: number;
  status?: "queued" | "awaiting_receipt" | "persisted";
  /**
   * 仅作服务端围栏的 stop(「正在重试中」软状态下用户按停止):源轮在服务端已终态,这条控制只为
   * 让 master 取消已入队的自动恢复子轮。它**不**代表一个待收尾的在飞 turn:reload 不据此恢复
   * in-flight / 「正在停止…」,回执也不清当前(可能已是下一轮的)发送态。
   */
  fenceOnly?: true;
};

/**
 * 持久化的会话快照。**刻意只持久 reducer 产出的稳定数据 + 断点续传游标**，剥离流式
 * 指针 / Map 等运行期瞬态（注水后由 rebuildIndexes 重建，详见 socket.loadStored）。
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
  _frameSeqContainerId?: number;
  _sendingInFlight?: boolean;
  _activeClientMessageId?: string;
  _activeAgentId?: string;
  _dispatchPaused?: boolean;
  _cancelledAutomaticRecoveryIds?: Record<string, true>;
  /** Permission requestIds already settled in this browser; a stale re-sent
   *  `outbound.permission_request` for them must not open a new card. */
  _settledPermissionRequestIds?: Record<string, true>;
  _automaticRecoveryDecisions?: Record<string, true>;
  /** Client-only rejection feedback survives a placeholder preceding history hydration. */
  _recoveryRejectedNotices?: Record<string, { code: string; notice: string }>;
  /** 刷新后仍未裁决的源轮。历史失败 tape 不能把它当成终态否决。 */
  _deferredTerminalErrorClientMessageId?: string;
  _deferredTerminalErrorPaint?: {
    normalized: string;
    text: string;
    detail?: string;
    displayMessage?: string;
    clientMessageId?: string;
    traceId?: string;
  };
  _turnStartedAt?: number;
  _lastFrameAt?: number;
  _maxSeq?: number;
  /** History revision paired with `_maxSeq` for safe incremental reads. */
  _historyRevision?: number;
  /** 归档 `_orderSeq` 水位(字段名为滚动兼容保留)。*/
  _archivedThroughSeq?: number;
  /** 已归档消息条数(会话总数 = tail + 此值;UI"还有 N 条"与"从云端加载"按钮据此)。*/
  _archivedCount?: number;
  _trackerResetAt?: number;
  /** server 时钟域的 tracker reset 截止（见 chat/model.ts 字段注释）,随 reload 保留。*/
  _trackerResetServerTs?: number;
  _localTeardownAt?: number;
  _agentSwitchedAt?: number | null;
  /** 最近一次发送的路由字段快照(model/teamMode/effort);reload 后合成续写复用。 */
  _lastRouting?: ChatRoutingSnapshot;
  /** 会话级模型选择(per-session 持久化;同设备 reload 即时恢复,服务端 canonical 到达后 server-wins)。 */
  _selectedModelId?: string;
  _preparedModelSwitch?: { id: string; targetModel: string };
  _snapshotStream?: { streamKey: string; agentId: string };
  _pendingDispatches?: StoredPendingDispatch[];
  /** Hydration-only view of the exact durable control journal. It is stored in
   * the existing v1 dispatch DB, never inline in the best-effort session row. */
  _pendingControls?: StoredPendingControl[];
};

const DISPATCH_DB_VERSION = 1;
const SESSION_STORE = "sessions";
const PENDING_DISPATCH_STORE = "pending_dispatches";
const SETTLED_DISPATCH_STORE = "settled_dispatches";
const SETTLED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function pendingDispatchKey(sessId: string, msgId: string): string {
  return `${sessId}\0${msgId}`;
}

function pendingControlKey(sessId: string, controlId: string): string {
  return `control\0${sessId}\0${controlId}`;
}

/** 解析可用的 IDBFactory；不可用（SSR/jsdom/禁用）返回 null。*/
function resolveFactory(explicit?: IDBFactory): IDBFactory | null {
  if (explicit) return explicit;
  try {
    return typeof indexedDB !== "undefined" ? indexedDB : null;
  } catch {
    return null;
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

export function dispatchDbNameForUser(userId: string | null | undefined): string {
  return dbNameForUser(userId).replace("ocv5_sessions__", "ocv5_dispatches__");
}

/** Thin multi-store IndexedDB adapter. Session-cache methods remain
 * best-effort; exact journal mutations reject unless their transaction
 * commits, which is the physical-send fence. */
class IdbKV {
  private readonly dbName: string;
  private readonly factory: IDBFactory | null;
  private readonly version: number | undefined;
  private readonly storesToCreate: readonly string[];
  private dbp: Promise<IDBDatabase | null> | null = null;

  constructor(
    dbName: string,
    storesToCreate: readonly string[],
    factory?: IDBFactory,
    version?: number,
  ) {
    this.dbName = dbName;
    this.factory = resolveFactory(factory);
    this.version = version;
    this.storesToCreate = storesToCreate;
  }

  private openDb(): Promise<IDBDatabase | null> {
    if (this.dbp) return this.dbp;
    const f = this.factory;
    if (!f) return Promise.resolve(null);

    let opening!: Promise<IDBDatabase | null>;
    opening = new Promise<IDBDatabase | null>((resolve) => {
      let settled = false;
      let blockedTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (db: IDBDatabase | null) => {
        if (blockedTimer) {
          clearTimeout(blockedTimer);
          blockedTimer = null;
        }
        if (settled) {
          db?.close();
          return;
        }
        settled = true;
        resolve(db);
      };
      let req: IDBOpenDBRequest;
      try {
        req = this.version === undefined ? f.open(this.dbName) : f.open(this.dbName, this.version);
      } catch {
        finish(null);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const storeName of this.storesToCreate) {
          if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          if (this.dbp === opening) this.dbp = null;
        };
        finish(db);
      };
      req.onerror = () => finish(null);
      req.onblocked = () => {
        if (!blockedTimer) blockedTimer = setTimeout(() => finish(null), 3_000);
      };
    });
    this.dbp = opening;
    void opening.then((db) => {
      if (!db && this.dbp === opening) this.dbp = null;
    });
    return opening;
  }

  private run<T>(
    storeName: string,
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
            const tx = db.transaction(storeName, mode);
            req = make(tx.objectStore(storeName));
          } catch {
            resolve(undefined);
            return;
          }
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(undefined);
        }),
    );
  }

  private executeDurableTransaction<T = void>(
    storeNames: string | readonly string[],
    work: (tx: IDBTransaction) => IDBRequest<T> | void,
  ): Promise<void> {
    return this.openDb().then((db) => {
      if (!db) throw new Error("indexeddb unavailable");
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (reason: unknown) => {
          if (settled) return;
          settled = true;
          reject(reason instanceof Error ? reason : new Error("indexeddb transaction failed"));
        };
        try {
          const tx = db.transaction(storeNames as string | string[], "readwrite");
          const req = work(tx);
          if (req) req.onerror = () => fail(req.error);
          tx.onerror = () => fail(tx.error);
          tx.onabort = () => fail(tx.error);
          tx.oncomplete = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
        } catch (error) {
          fail(error);
        }
      });
    });
  }

  get<T>(storeName: string, key: string): Promise<T | undefined> {
    return this.run<T>(storeName, "readonly", (s) => s.get(key) as IDBRequest<T>);
  }
  getAll<T>(storeName: string): Promise<T[]> {
    return this.run<T[]>(storeName, "readonly", (s) => s.getAll() as IDBRequest<T[]>).then((r) => r ?? []);
  }
  put(storeName: string, key: string, value: unknown): Promise<unknown> {
    return this.run(storeName, "readwrite", (s) => s.put(value, key));
  }
  putDurably(storeName: string, key: string, value: unknown): Promise<void> {
    return this.executeDurableTransaction(storeName, (tx) => tx.objectStore(storeName).put(value, key));
  }
  delete(storeName: string, key: string): Promise<unknown> {
    return this.run(storeName, "readwrite", (s) => s.delete(key));
  }
  deleteDurably(storeName: string, key: string): Promise<void> {
    return this.executeDurableTransaction(storeName, (tx) => tx.objectStore(storeName).delete(key));
  }
  settleDispatchDurably(key: string, settledAt: number): Promise<void> {
    return this.executeDurableTransaction(
      [PENDING_DISPATCH_STORE, SETTLED_DISPATCH_STORE],
      (tx) => {
        tx.objectStore(SETTLED_DISPATCH_STORE).put({ key, settledAt }, key);
        tx.objectStore(PENDING_DISPATCH_STORE).delete(key);
      },
    );
  }
  async clearStores(storeNames: readonly string[]): Promise<void> {
    const db = await this.openDb();
    if (!db) return;
    const existing = storeNames.filter((storeName) => db.objectStoreNames.contains(storeName));
    if (existing.length === 0) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(existing, "readwrite");
        for (const storeName of existing) tx.objectStore(storeName).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }
  close(): void {
    const p = this.dbp;
    this.dbp = null;
    if (p) void p.then((db) => db?.close());
  }
}

function stripSessionJournalFields(session: StoredSession): StoredSession {
  const {
    _pendingDispatches: legacyPending,
    _pendingControls: pendingControls,
    ...clean
  } = session;
  void legacyPending;
  void pendingControls;
  return clean;
}

function buildJournalRouting(payload: InboundMessage): ChatRoutingSnapshot {
  return {
    model: payload.model,
    teamMode: payload.teamMode === true,
    effortLevel: payload.effortLevel ?? null,
    ...(payload.contextTier ? { contextTier: payload.contextTier } : {}),
    ...(payload.serviceTier ? { serviceTier: payload.serviceTier } : {}),
  };
}

function buildJournalRecoveryFields(
  recovery: NonNullable<InboundMessage["content"]["recovery"]>,
): Partial<ChatMessage> {
  return {
    _recoveryOfClientMessageId: recovery.sourceClientMessageId,
    _recoveryMode: recovery.mode,
    _automaticRecovery: recovery.automatic,
    // Keep the shared retry lineage across a reload too (OCV5-355).
    ...("attempt" in recovery
      ? {
          _automaticRecoveryRootClientMessageId: recovery.rootClientMessageId,
          _automaticRecoveryAttempt: recovery.attempt,
          _automaticRecoveryMax: recovery.max,
        }
      : {}),
  };
}

function reconstructJournalUserMessage(item: StoredPendingDispatch): ChatMessage {
  const payload = item.payload;
  const media = payload.content.media;
  const displayText = payload.content.displayText ?? payload.content.text ?? "";
  const attemptMatch = /:(\d+)$/.exec(payload.idempotencyKey);
  const attempt = attemptMatch ? Number(attemptMatch[1]) : 0;
  const recovery = payload.content.recovery;
  return {
    id: item.msgId,
    role: "user",
    text: displayText,
    ts: payload.ts,
    status: "queued",
    ...(displayText !== payload.content.text ? { _modelText: payload.content.text } : {}),
    ...(media ? { _media: media.filter((entry) => entry.hidden !== true) } : {}),
    ...(payload.content.imageEdit && media ? { _retryMedia: media } : {}),
    ...(payload.content.imageEdit ? { _imageEdit: payload.content.imageEdit } : {}),
    ...(payload.content.replyTo ? { _replyTo: payload.content.replyTo } : {}),
    ...(recovery ? buildJournalRecoveryFields(recovery) : {}),
    _routing: buildJournalRouting(payload),
    _sendAttempt: Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0,
  };
}

function reconstructDispatchOnlySession(
  sessId: string,
  items: StoredPendingDispatch[],
): StoredSession {
  items.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  const first = items[0]!;
  const messages = items.map(reconstructJournalUserMessage);
  const firstPayload = first.payload;
  const firstText = firstPayload.content.displayText ?? firstPayload.content.text ?? "";
  const routing = messages.at(-1)!._routing!;
  return {
    id: sessId,
    agentId: firstPayload.agentId ?? "main",
    title: sessionTitleFromText(firstText),
    messages,
    createdAt: first.enqueuedAt,
    lastAt: items.at(-1)!.enqueuedAt,
    _lastRouting: routing,
    ...(routing.model ? { _selectedModelId: routing.model } : {}),
    _pendingDispatches: items,
  };
}

function reconstructControlOnlySession(
  sessId: string,
  controls: StoredPendingControl[],
): StoredSession {
  const first = controls[0]!;
  return {
    id: sessId,
    agentId: first.agentId || "main",
    title: "恢复中的会话",
    messages: [],
    createdAt: first.enqueuedAt,
    lastAt: controls.at(-1)!.enqueuedAt,
    ...(first.controlKind === "stop" && first.clientMessageId
      ? {
          _sendingInFlight: true,
          _activeClientMessageId: first.clientMessageId,
        }
      : {}),
    _pendingControls: controls,
  };
}

function groupPendingJournalsBySession(
  pending: readonly StoredPendingDispatchRecord[],
  pendingControls: readonly StoredPendingControl[],
): {
  bySession: Map<string, StoredPendingDispatch[]>;
  controlsBySession: Map<string, StoredPendingControl[]>;
} {
  const bySession = new Map<string, StoredPendingDispatch[]>();
  for (const item of pending) {
    if (!item || typeof item.sessId !== "string") continue;
    const list = bySession.get(item.sessId) ?? [];
    list.push({ msgId: item.msgId, payload: item.payload, enqueuedAt: item.enqueuedAt });
    bySession.set(item.sessId, list);
  }
  const controlsBySession = new Map<string, StoredPendingControl[]>();
  for (const control of pendingControls) {
    const list = controlsBySession.get(control.sessId) ?? [];
    list.push(control);
    controlsBySession.set(control.sessId, list);
  }
  return { bySession, controlsBySession };
}

function hydrateSessionWithJournals(
  session: StoredSession,
  bySession: Map<string, StoredPendingDispatch[]>,
  controlsBySession: Map<string, StoredPendingControl[]>,
): StoredSession {
  const items = bySession.get(session.id);
  const controls = controlsBySession.get(session.id);
  bySession.delete(session.id);
  controlsBySession.delete(session.id);
  const clean = stripSessionJournalFields(session);
  if (items?.length) items.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  if (controls?.length) controls.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  return {
    ...clean,
    ...(items?.length ? { _pendingDispatches: items } : {}),
    ...(controls?.length ? { _pendingControls: controls } : {}),
  };
}

/**
 * 单一 user 命名空间下的会话持久存储。put/get/getAll/delete 直透 IdbKV，
 * wipe 清空整个命名空间（登出隐私收尾）。无 IndexedDB 时全 no-op。
 */
export class SessionStore {
  readonly userId: string;
  private readonly sessionsKv: IdbKV;
  private readonly dispatchKv: IdbKV;
  private readonly pendingJournalWrites = new Set<Promise<void>>();
  // wipe 后置 dead：让随后到来的 flush/debounce 写（如登出 teardown 的 final flush）变 no-op，
  // 否则 live 会话会被重新写回刚清空的命名空间 → 击穿隐私 wipe。
  private dead = false;

  constructor(userId: string, factory?: IDBFactory) {
    this.userId = userId;
    this.sessionsKv = new IdbKV(dbNameForUser(userId), [SESSION_STORE], factory);
    this.dispatchKv = new IdbKV(
      dispatchDbNameForUser(userId),
      [PENDING_DISPATCH_STORE, SETTLED_DISPATCH_STORE],
      factory,
      DISPATCH_DB_VERSION,
    );
  }

  async putSession(s: StoredSession): Promise<void> {
    if (this.dead || !s?.id) return;
    await this.sessionsKv.put(SESSION_STORE, s.id, stripSessionJournalFields(s));
  }

  /** Whole-session durable write. It deliberately cannot mutate the exact
   * pending-dispatch store. */
  async putSessionDurably(s: StoredSession): Promise<void> {
    if (this.dead) throw new Error("session store is closed");
    if (!s?.id) throw new Error("session id is required");
    await this.sessionsKv.putDurably(SESSION_STORE, s.id, stripSessionJournalFields(s));
  }

  /** Exact journal write: success means its own readwrite transaction committed. */
  async putPendingDispatch(sessId: string, item: StoredPendingDispatch): Promise<void> {
    if (this.dead) throw new Error("session store is closed");
    if (!sessId || !item?.msgId) throw new Error("pending dispatch identity is required");
    const write = this.dispatchKv.putDurably(
      PENDING_DISPATCH_STORE,
      pendingDispatchKey(sessId, item.msgId),
      { sessId, ...item } satisfies StoredPendingDispatchRecord,
    );
    this.pendingJournalWrites.add(write);
    try {
      await write;
    } finally {
      this.pendingJournalWrites.delete(write);
    }
  }

  async deletePendingDispatch(sessId: string, msgId: string): Promise<void> {
    if (this.dead || !sessId || !msgId) return;
    const key = pendingDispatchKey(sessId, msgId);
    await this.dispatchKv.settleDispatchDurably(key, Date.now());
    await this.sessionsKv.deleteDurably(PENDING_DISPATCH_STORE, key).catch((err) => {
      void err;
    });
    const session = await this.sessionsKv.get<StoredSession>(SESSION_STORE, sessId);
    if (session?._pendingDispatches?.some((item) => item.msgId === msgId)) {
      const { _pendingDispatches: legacyPending, ...clean } = session;
      const remaining = legacyPending.filter((item) => item.msgId !== msgId);
      await this.sessionsKv.put(
        SESSION_STORE,
        sessId,
        remaining.length > 0 ? { ...clean, _pendingDispatches: remaining } : clean,
      );
    }
  }

  async putPendingControl(item: StoredPendingControl): Promise<void> {
    if (this.dead) throw new Error("session store is closed");
    if (!item?.sessId || !item.controlId || item.kind !== "control") {
      throw new Error("pending control identity is required");
    }
    const write = this.dispatchKv.putDurably(
      PENDING_DISPATCH_STORE,
      pendingControlKey(item.sessId, item.controlId),
      item,
    );
    this.pendingJournalWrites.add(write);
    try {
      await write;
    } finally {
      this.pendingJournalWrites.delete(write);
    }
  }

  async deletePendingControl(sessId: string, controlId: string): Promise<void> {
    if (this.dead || !sessId || !controlId) return;
    await this.dispatchKv.settleDispatchDurably(pendingControlKey(sessId, controlId), Date.now());
  }

  private async readAndPruneSettledKeys(now = Date.now()): Promise<Set<string>> {
    const settled = await this.dispatchKv.getAll<{ key?: string; settledAt?: number }>(SETTLED_DISPATCH_STORE);
    const cutoff = now - SETTLED_RETENTION_MS;
    const keys = new Set<string>();
    const expired: string[] = [];
    for (const item of settled) {
      if (typeof item?.key !== "string") continue;
      if (typeof item.settledAt === "number" && item.settledAt > 0 && item.settledAt < cutoff) expired.push(item.key);
      else keys.add(item.key);
    }
    if (expired.length > 0) void Promise.allSettled(expired.map((k) => this.dispatchKv.delete(SETTLED_DISPATCH_STORE, k)));
    return keys;
  }

  private async collectPendingControls(settledKeys?: Set<string>): Promise<StoredPendingControl[]> {
    const [pending, keys] = await Promise.all([
      this.dispatchKv.getAll<StoredPendingControl>(PENDING_DISPATCH_STORE),
      settledKeys ? Promise.resolve(settledKeys) : this.readAndPruneSettledKeys(),
    ]);
    return pending
      .filter((item) =>
        item?.kind === "control" &&
        typeof item.sessId === "string" && item.sessId.length > 0 &&
        typeof item.controlId === "string" && item.controlId.length > 0 &&
        !keys.has(pendingControlKey(item.sessId, item.controlId)))
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }

  async getPendingControls(): Promise<StoredPendingControl[]> {
    return this.dead ? [] : this.collectPendingControls();
  }

  private async collectPendingDispatches(
    sessions?: StoredSession[],
    settledKeys?: Set<string>,
  ): Promise<StoredPendingDispatchRecord[]> {
    const sessionRows = sessions ?? (await this.sessionsKv.getAll<StoredSession>(SESSION_STORE));
    const [pending, legacyV2, keys] = await Promise.all([
      this.dispatchKv.getAll<StoredPendingDispatchRecord>(PENDING_DISPATCH_STORE),
      this.sessionsKv.getAll<StoredPendingDispatchRecord>(PENDING_DISPATCH_STORE),
      settledKeys ? Promise.resolve(settledKeys) : this.readAndPruneSettledKeys(),
    ]);
    const unresolved = new Map<string, StoredPendingDispatchRecord>();
    const add = (item: StoredPendingDispatchRecord) => {
      if (!item || typeof item.sessId !== "string" || !item.sessId || typeof item.msgId !== "string" || !item.msgId) return;
      const key = pendingDispatchKey(item.sessId, item.msgId);
      if (!keys.has(key) && !unresolved.has(key)) unresolved.set(key, item);
    };
    for (const item of pending) add(item);
    for (const item of legacyV2) add(item);
    for (const session of sessionRows) {
      if (!session?.id || !Array.isArray(session._pendingDispatches)) continue;
      for (const item of session._pendingDispatches) add({ sessId: session.id, ...item });
    }
    return [...unresolved.values()].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }

  async getPendingDispatches(): Promise<StoredPendingDispatchRecord[]> {
    return this.dead ? [] : this.collectPendingDispatches();
  }

  /** Hydration-only view: merge the independent journal into session values
   * in memory without ever writing it back into the sessions store. */
  async getAllForHydration(): Promise<StoredSession[]> {
    if (this.dead) return [];
    const [sessions, settledKeys] = await Promise.all([
      this.sessionsKv.getAll<StoredSession>(SESSION_STORE),
      this.readAndPruneSettledKeys(),
    ]);
    const [pending, pendingControls] = await Promise.all([
      this.collectPendingDispatches(sessions, settledKeys),
      this.collectPendingControls(settledKeys),
    ]);
    const { bySession, controlsBySession } = groupPendingJournalsBySession(pending, pendingControls);
    const hydrated = sessions.map((session) =>
      hydrateSessionWithJournals(session, bySession, controlsBySession),
    );
    for (const [sessId, items] of bySession) {
      hydrated.push(reconstructDispatchOnlySession(sessId, items));
    }
    for (const [sessId, controls] of controlsBySession) {
      hydrated.push(reconstructControlOnlySession(sessId, controls));
    }
    return hydrated;
  }

  getSession(id: string): Promise<StoredSession | undefined> {
    if (this.dead) return Promise.resolve(undefined);
    return this.sessionsKv
      .get<StoredSession>(SESSION_STORE, id)
      .then((session) => (session ? stripSessionJournalFields(session) : undefined));
  }

  async getAll(): Promise<StoredSession[]> {
    if (this.dead) return [];
    const sessions = await this.sessionsKv.getAll<StoredSession>(SESSION_STORE);
    return sessions.map(stripSessionJournalFields);
  }

  async deleteSession(id: string): Promise<void> {
    if (this.dead) return;
    const [pending, controls] = await Promise.all([
      this.getPendingDispatches(),
      this.getPendingControls(),
    ]);
    await Promise.all([
      ...pending
        .filter((item) => item.sessId === id)
        .map((item) => this.deletePendingDispatch(id, item.msgId)),
      ...controls
        .filter((item) => item.sessId === id)
        .map((item) => this.deletePendingControl(id, item.controlId)),
    ]);
    await this.sessionsKv.delete(SESSION_STORE, id);
  }

  /** 清空本 user 命名空间（登出/隐私收尾）。同步置 dead 防 wipe 与 final flush 竞态。*/
  async wipe(): Promise<void> {
    this.dead = true;
    await Promise.allSettled([...this.pendingJournalWrites]);
    const [pending, controls] = await Promise.all([
      this.collectPendingDispatches(),
      this.collectPendingControls(),
    ]);
    await Promise.all([
      this.sessionsKv.clearStores([SESSION_STORE, PENDING_DISPATCH_STORE]),
      this.dispatchKv.clearStores([PENDING_DISPATCH_STORE, SETTLED_DISPATCH_STORE]),
    ]);
    const now = Date.now();
    await Promise.allSettled([
      ...pending.map((item) =>
        this.dispatchKv.settleDispatchDurably(pendingDispatchKey(item.sessId, item.msgId), now),
      ),
      ...controls.map((item) =>
        this.dispatchKv.settleDispatchDurably(pendingControlKey(item.sessId, item.controlId), now),
      ),
    ]);
  }

  close(): void {
    this.sessionsKv.close();
    this.dispatchKv.close();
  }
}
