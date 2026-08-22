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
import { TEAM_CARD_CLIENT_DISPLAY_FIELDS } from "@openclaude/protocol/teamCards";
import { normalizeTurnErrorCode } from "@openclaude/protocol";
import type {
  BashTail,
  ChatMessage,
  ChatRoutingSnapshot,
  ChildBlock,
  TimelineBashTailEvidence,
} from "./chat/model";
import type {
  InboundControlStop,
  InboundMessage,
  InboundPermissionResponse,
} from "./chat/frames";
import { agentGroupRunId, isServerAuthoredRow } from "./chat/model";
import { repairPostFinalProcessOrder } from "./chat/order";
import {
  collapsedAnchorTerminalKind,
  isTurnTapeProcessControl,
} from "./chat/render";
import { friendlyDelegateResultPreview } from "./chat/reducer";
import { sessionTitleFromText } from "./sessionTitle";

/** turn 终态收敛(RFC §5 M5):server 载荷自证的 turn 终态类别。 */
export type ServerTurnTerminal = "completed" | "error" | "interrupted";

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
};

/**
 * 从 server 载荷推导「已收尾 turn → 终态类别」映射(clientMessageId 键)。socket.applyServerMessages
 * 据此**显式收敛**:清发送态 + user 行置 replied/error(不依赖 completion-evidence 巧合路径)。
 *  - error:verified turn status 或任何带 _errorCode 的 server 终态行。
 *  - completed:真 lossless tape(finalize 时原子落库)展开的 server-authored 生成行
 *    (assistant/thinking/tool、无 _errorCode)—— 单行即证明整 turn 已收尾。
 * **completed 覆盖 error**:同 cmid 若迟到真 tape 已出现,以真内容为准。
 */
export function detectServerTerminalTurns(
  serverRows: readonly ChatMessage[],
): Map<string, ServerTurnTerminal> {
  const errored = new Set<string>();
  const interrupted = new Set<string>();
  const completed = new Set<string>();
  for (const m of serverRows) {
    const cmid = m?._clientMessageId;
    if (typeof cmid !== "string" || cmid.length === 0) continue;
    // A finalized tape's real rows carry the same non-display outcome as the
    // old process control. This is terminal evidence even when the tape only
    // contains plan/goal/agent-group/runtime-event records. It never creates
    // a substitute row or changes how the genuine record is rendered.
    if (m._turnTapeComplete === true || isTurnTapeProcessControl(m)) {
      const kind = collapsedAnchorTerminalKind(m._dispatchOutcome);
      if (kind === "completed") completed.add(cmid);
      else if (kind === "error") {
        if (normalizeTurnErrorCode(m._errorCode) === "service_restart") interrupted.add(cmid);
        else errored.add(cmid);
      }
      if (kind !== null) continue;
    }
    if (
      m._turnStatusRecord === true ||
      (typeof m._errorCode === "string" && m._errorCode.length > 0)
    ) {
      if (normalizeTurnErrorCode(m._errorCode) === "service_restart") interrupted.add(cmid);
      else errored.add(cmid);
    } else if (
      isServerAuthoredRow(m) &&
      (m.role === "assistant" || m.role === "thinking" || m.role === "tool")
    ) {
      completed.add(cmid);
    }
  }
  const out = new Map<string, ServerTurnTerminal>();
  for (const cmid of interrupted) out.set(cmid, "interrupted");
  for (const cmid of errored) out.set(cmid, "error");
  for (const cmid of completed) out.set(cmid, "completed");
  return out;
}

/** The session cache stays on whichever schema version already exists. The
 * exact outbound journal has its own DB so a frontend rollback never opens an
 * already-upgraded session DB with a lower explicit version. */
const DISPATCH_DB_VERSION = 1;
const SESSION_STORE = "sessions";
const PENDING_DISPATCH_STORE = "pending_dispatches";
const SETTLED_DISPATCH_STORE = "settled_dispatches";

function pendingDispatchKey(sessId: string, msgId: string): string {
  return `${sessId}\0${msgId}`;
}

function pendingControlKey(sessId: string, controlId: string): string {
  return `control\0${sessId}\0${controlId}`;
}

/**
 * 持久化的会话快照。**刻意只持久 reducer 产出的稳定数据 + 断点续传游标**，剥离流式
 * 指针 / Map 等运行期瞬态（注水后由 rebuildIndexes 重建，详见 socket.loadStored）。
 * `_lastFrameSeqByKey` / `_lastFrameSeq` 是断点续传游标（resume_failed 推进后必须落地，
 * 否则 reload 后 hello 仍发旧游标 → server 反复 resume 失败 → reload 死循环）。
 * `_sendingInFlight` / `_turnStartedAt` / `_lastFrameAt` 是 reload 恢复中的 exact turn
 * 活跃标记；只要带合法 clientMessageId，loadStored 就持续对账至服务端权威终态。
 * `_maxSeq` 是 server canonical 增量游标（下次 getSession 的 sinceSeq）。`_trackerResetAt` /
 * `_localTeardownAt` / `_agentSwitchedAt` 是 stop/timeout/switch 后的 late-frame cutoff，
 * 必须随 reload 保留，否则刷新会丢守卫、让旧非 final 帧把发送态复活。
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
  _sendingInFlight?: boolean;
  _activeClientMessageId?: string;
  _activeAgentId?: string;
  _dispatchPaused?: boolean;
  _cancelledAutomaticRecoveryIds?: Record<string, true>;
  _automaticRecoveryDecisions?: Record<string, true>;
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
  /** 最近一次发送的路由字段快照(model/teamMode/effort);reload 后合成续写复用,
   *  缺失会让暖 codex 会话的续写被计费闸拒(见 chat/model.ts 同名字段注释)。 */
  _lastRouting?: ChatRoutingSnapshot;
  /** 会话级模型选择(per-session 持久化;同设备 reload 即时恢复,服务端 canonical 到达后
   *  server-wins。与 _lastRouting 语义不同:那是"最近实际发送"供合成续写,这是"用户选择"。 */
  _selectedModelId?: string;
  _preparedModelSwitch?: { id: string; targetModel: string };
  _pendingDispatches?: StoredPendingDispatch[];
  /** Hydration-only view of the exact durable control journal. It is stored in
   * the existing v1 dispatch DB, never inline in the best-effort session row. */
  _pendingControls?: StoredPendingControl[];
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
      const finish = (db: IDBDatabase | null) => {
        if (settled) {
          db?.close();
          return;
        }
        settled = true;
        resolve(db);
      };
      let req: IDBOpenDBRequest;
      try {
        req = this.version === undefined
          ? f.open(this.dbName)
          : f.open(this.dbName, this.version);
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
      req.onblocked = () => {};
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

  private mutateCommitted<T>(
    storeName: string,
    mutate: (store: IDBObjectStore) => IDBRequest<T>,
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
          const tx = db.transaction(storeName, "readwrite");
          const req = mutate(tx.objectStore(storeName));
          req.onerror = () => fail(req.error);
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
    return this.mutateCommitted(storeName, (s) => s.put(value, key));
  }
  delete(storeName: string, key: string): Promise<unknown> {
    return this.run(storeName, "readwrite", (s) => s.delete(key));
  }
  deleteDurably(storeName: string, key: string): Promise<void> {
    return this.mutateCommitted(storeName, (s) => s.delete(key));
  }
  settleDispatchDurably(key: string, settledAt: number): Promise<void> {
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
          const tx = db.transaction(
            [PENDING_DISPATCH_STORE, SETTLED_DISPATCH_STORE],
            "readwrite",
          );
          tx.objectStore(SETTLED_DISPATCH_STORE).put({ key, settledAt }, key);
          tx.objectStore(PENDING_DISPATCH_STORE).delete(key);
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

/**
 * full（server canonical 整带）合并：server 为权威在前，保留两类 local-only 消息：
 *  ① **末尾连续的乐观尾消息**（用户刚发出、server 尚未持久化的那一截：从尾部回溯到第一条
 *     server 认识的消息为止）——含流式中的 assistant/tool 等，它们尚未被 server 重写。
 *  ② **本地独有的 user 气泡**（出现在中段、非尾部那段）——用户消息是客户端权威，server 端
 *     永不以另一 id 重写它们；但 v5 当前不把用户消息 PUT 到 server（server 历史只含
 *     server-authored 的助手/委派/工具）。若像旧逻辑那样只保尾部，重连 server-wins 会丢掉
 *     夹在助手轮之前的用户输入（boss 报"会话不显示用户输入"的根因）。故额外保留这些 user 行。
 *  ③ **本地独有的团队/委派卡**（agent-group / delegate-progress，中段）——团队卡是
 *     client-owned 展示结构，v5 server-authored 通道只写 assistant|thinking|tool 三种
 *     role、从不产出团队行（ccbMessageParser 显式把 Agent 卡排除在 durable 快照外），
 *     所以「中段 server 不认识的团队行」不是被取代的脏数据，而是 server 端根本没有的
 *     内容；旧逻辑只保尾部会在「团队轮之后又有新轮」的 reopen 场景整卡丢失。保留后由
 *     normalizeDelegateCards（loadStored/applyServerMessages 收口处）按 blockId/runId
 *     兜底折叠,不会与 server 带回的 delegate 工具行形成重复卡。
 *  ⑦ **本地 permission 卡**（中段）——CCB/Codex 引擎权限卡仍只在 reducer 生成；
 *     detached Cursor ask_user 卡现在会作为 server-authored `role:'permission'` 行
 *     出现在 getSession/full-sync 里（与 requestId 同 id）。同 id 走 server-wins；
 *     本地独有的引擎权限卡仍须保留，否则断线重连会丢卡或漂到 final 后。
 *
 * 其余角色（assistant/thinking/tool）乐观消息可能已被 server 以 `srv-*` 重写，中段保留
 * 会出现重复卡片，故仍只保尾部（非尾部=已被取代→丢弃）。
 * 合并时先按 local 原槽位放回 server 同 id 行与 client-owned 行，再追加 local 尚未见到的
 * server 行，最后按 `(anchorOrderSeq, ts, index)` 真全序：耐久行位置冻结，本地乐观窗只在
 * 原槽位前一条耐久行的锚点内用 ts/index 排列，server echo 后自然收敛到 `_orderSeq`。
 *
 * **债A 偿还(server-authored 团队卡)**：server 现会带回 agent-group 骨架行(id `srv-*`、
 * `_source:'server'`、无 childBlocks),用于跨设备/清缓存场景保住团队结构+终态。去重按 runId:
 *  - 本地富卡(m-*)同 runId 存在 → **local-wins**:丢弃 server 骨架行(它没有过程树,渲染会
 *    退化),本地富卡经下方 team-owned 保留逻辑存活 → 富卡不被吞、childBlocks 不丢(2c73030d);
 *  - 本地缺席(跨设备/清缓存)→ 采用 server 骨架行,渲染成无 childBlocks 的骨架卡。
 * server 骨架行与本地行按 id 天然不同(srv-* vs m-*),故 id 维度的 server-wins 覆盖路径
 * 碰不到它们;唯一的去重维度是 runId,收口在这里 + normalizeDelegateCards(reducer)。
 *
 * **热尾巴适配(archivedThroughSeq)**:行体积到顶前 server 会把最老的一截消息搬进归档 chunk,
 * full 同步返回的 `server` 可能**只含热尾巴**(`_orderSeq > archivedThroughSeq`)。此时本地缓存
 * 里 `_orderSeq ≤ archivedThroughSeq` 的行是"已归档的 server 行"——server 不再带回不代表它们被取代,
 * 只是被搬走了。故第三参 `archivedThroughSeq` 传入后,这些行**无条件保留**(④),绝不当"中段
 * server 不认识的陈旧数据"丢弃(否则 reopen 长会话整段旧历史蒸发,本次改造的主雷)。默认 0 =
 * 未归档,行为与旧版完全一致。
 *
 * **client-owned system 行(⑤)**:context_rebuilt 上下文重建提示是 role:'system' 的客户端行,
 * v5 server-authored 通道只写 assistant|thinking|tool、从不产出 system 行,故中段 system 行同
 * user/团队卡一样是"server 端根本没有的内容",一并保留(否则下次 sync 就把重建提示抹掉)。
 */
/**
 * 完成证据去重的删除判据:本地这一轮被 server 权威 tape 取代、应从本地移除的**生成内容行**。
 * 三要素全满足才删:
 *  ① 非 server-authored 本地行——权威标记是 `_source !== 'server'`,**不是** id 前缀 `srv-`。
 *     v7 起主 agent 的 live text/thinking/tool 直接采用引擎 messageId(形如 `srv-<peer>-<agent>-tN`),
 *     它们是 reducer 本地铸的乐观行(无 `_source`)却带 `srv-` 前缀 → `isServerAuthoredRow()` 因
 *     srv- 前缀兜底会把它们**误判成 server-authored**。若按 `isServerAuthoredRow=false` 过滤,恰好
 *     漏掉这批「采用引擎 messageId 的本地行」——而它们正是要清的重复源(turn finalize 后 server 把
 *     该轮展开成 `srv-…-tN-s{idx}` 分段行,id 不同 → server-wins 按 id 漏)。故这里用权威源 `_source`
 *     精确区分:server-loaded 行必带 `_source:'server'`(见 commercial pgSessionsBackend),本地乐观
 *     行永不带。
 *  ② `_clientMessageId` 命中已完成轮(由调用方 hasExactCompletionEvidence 断言 server 已回该轮的
 *     server-authored 行;server 未回完成证据时本地行必须保留,不误删落库失败降级场景)。
 *  ③ 角色 ∈ {assistant, thinking, tool}——只清生成内容行;user/system/agent-group/goal/
 *     delegate-progress 等 client-owned 行**绝不**因 `_clientMessageId` 命中被删(server-authored
 *     通道从不产出它们,server 无副本,删了就真丢)。
 */
function isSupersededLocalTurnRow(m: ChatMessage, completedClientMessageId: string): boolean {
  return (
    m._source !== "server" &&
    m._clientMessageId === completedClientMessageId &&
    (m.role === "assistant" || m.role === "thinking" || m.role === "tool")
  );
}

function isGeneratedRole(role: ChatMessage["role"] | undefined): boolean {
  return role === "assistant" || role === "thinking" || role === "tool";
}

/** Live presentation rows that have a one-for-one durable counterpart in a
 * finalized Agent tape. User/permission/system rows are deliberately absent:
 * they are not replaceable Agent-process UI. */
function isTapeBackedAgentProcessRole(role: ChatMessage["role"] | undefined): boolean {
  return role === "assistant" || role === "thinking" || role === "tool" ||
    role === "plan" || role === "goal" || role === "agent-group" ||
    role === "delegate-progress" || role === "runtime-event";
}

function turnOwnerId(message: ChatMessage): string | undefined {
  return typeof message._turnOwnerId === "string" && message._turnOwnerId
    ? message._turnOwnerId
    : typeof message._clientMessageId === "string" && message._clientMessageId
      ? message._clientMessageId
      : undefined;
}

function validHistoryOrder(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Lazily loaded process rows carry `_turnTapeProcessLoadedFrom` and are absent from ordinary timeline refreshes.
 * server 只回惰性游标、**从不回这些已加载页**,故它们在 full 载荷里"缺席"是**预期**而非删除信号 ——
 * 必须豁免 P1 缺席删除,否则每次 full sync 都把当前视口页清掉。(它们是 `_source:'server'`,天然不入
 * P2 的 isCoveredStaleLocalRow 非 server 行删除;此处只需闭合 P1。)
 */
function isLocallyExpandedTapeRow(m: ChatMessage): boolean {
  return typeof m._turnTapeProcessLoadedFrom === "string" && m._turnTapeProcessLoadedFrom.length > 0;
}

/**
 * Full merge 的排序轴信任边界：本地 reducer / IndexedDB 铸的行不得携带 `_orderSeq` 进入
 * durable axis；即使缓存被旧版本污染，也只能按原槽位锚定。显式 `_source:'server'` 的行是
 * 热尾归档或 tape 展开留下的 server-derived durable cache，必须保留冻结轴（不能退回客户端 ts）。
 */
function sanitizePreservedLocalRow(m: ChatMessage): ChatMessage {
  if (m._source === "server" || !("_orderSeq" in m)) return m;
  const { _orderSeq: _untrustedOrderSeq, ...safe } = m;
  void _untrustedOrderSeq;
  return safe as ChatMessage;
}

/**
 * **同步权威传播**(07-17 tail 洪水事故收尾根治):从 server 载荷自身推导"已被权威 tape 覆盖的
 * turn 集",据此删除本地残留的过期副本。此前完成证据只认调用方传入的 completedClientMessageId
 * (仅"刚完成的那一轮"),事故期间落进 IndexedDB 的历史脏行(旧代码铸的 live 行:无
 * _clientMessageId、id 为裸引擎 messageId)在老会话重开时**永远删不掉**——合并的尾段整段保留 +
 * 无序轴行锚到末尾 = "响应结束标记之后重现 turn 开头内容"。
 *
 * 证据构造是**证据为正**(presence-based):只有载荷里出现某 turn 的 server 生成行才认定该 turn
 * 被权威 tape 覆盖 —— 旧 full 快照缺某 turn 只会"不清理",绝不会误删(与 P1 的缺席判定不同,
 * 不需要版本护栏)。server 落库失败的降级场景(某 turn 服务端零行)自然无证据 → 本地行保留,
 * "已计费内容不得整条丢弃"红线不破。
 *
 * 双通道(命中其一即为过期副本):
 *  a. `_clientMessageId` ∈ 证据集(限定携带 `_turnTapeId` 的 v2 tape 展开行:单行即证明整 turn
 *     已原子落库;v1 逐行 writer 不具备该性质,不入证据集);
 *  b. id 落在证据 turn 前缀命名空间内。前缀**只从 assistant/thinking 展开行的受控后缀文法反推**
 *     (`<prefix>-s<idx>` / `<prefix>-thinking-s<idx>`,后缀完全受平台控制,无歧义);tool 展开行
 *     的 blockId 内容任意、不可靠反解析,**不参与前缀推导**。本地行匹配用"id === 前缀 或
 *     id.startsWith(前缀 + '-')"的成员判定 —— 不解析本地 id,turn 号数字边界(t1- vs t12)
 *     天然防跨 turn 误伤。
 * 活跃轮守卫:行的 `_clientMessageId` 等于当前活跃轮 → 双通道都不删(REST 已回终态、WS delta
 * 仍在途的竞态窗口);新代码给所有本地生成行盖 clientMessageId,活跃轮不存在无章行。
 * 角色守卫:user/system/agent-group/plan/goal 等 client-owned 行绝不触碰。
 */
interface ServerTurnEvidence {
  clientMessageIds: Set<string>;
  turnPrefixes: Set<string>;
}
const ASSISTANT_EXPANSION_ID_RE = /^(srv-.+-t\d+)-s\d+$/;
const THINKING_EXPANSION_ID_RE = /^(srv-.+-t\d+)-thinking-s\d+$/;

function buildServerTurnEvidence(serverRows: readonly ChatMessage[]): ServerTurnEvidence {
  const clientMessageIds = new Set<string>();
  const turnPrefixes = new Set<string>();
  for (const m of serverRows) {
    if (!m || m._source !== "server") continue;
    if (m._displayDegradeReason === "records_unpublished") continue;
    // 只有 **complete tape** 的展开行才有资格作证:_turnTapeId 在 rolling per-record 兼容路径
    // (pre-release 逐行 refs)上也会被盖,单独存在不构成"整 turn 已原子落库"证明(Codex R2
    // MAJOR);_turnTapeComplete 仅由 hydration 的 complete-anchor 分支盖章。
    if (typeof m._turnTapeId !== "string" || m._turnTapeId.length === 0) continue;
    if (m._turnTapeComplete !== true) continue;
    if (typeof m._clientMessageId === "string" && m._clientMessageId.length > 0) {
      clientMessageIds.add(m._clientMessageId);
    }
    if (!isGeneratedRole(m.role)) continue;
    if (typeof m.id === "string") {
      const hit =
        (m.role === "assistant" && ASSISTANT_EXPANSION_ID_RE.exec(m.id)) ||
        (m.role === "thinking" && THINKING_EXPANSION_ID_RE.exec(m.id));
      if (hit) turnPrefixes.add(hit[1]);
    }
  }
  return { clientMessageIds, turnPrefixes };
}

function matchesEvidenceTurnPrefix(id: unknown, turnPrefixes: Set<string>): boolean {
  if (typeof id !== "string" || !id.startsWith("srv-")) return false;
  for (const prefix of turnPrefixes) {
    if (id === prefix || id.startsWith(prefix + "-")) return true;
  }
  return false;
}

function isCoveredStaleLocalRow(
  m: ChatMessage,
  evidence: ServerTurnEvidence,
  activeClientMessageId: string | undefined,
): boolean {
  if (m._source === "server" || !isTapeBackedAgentProcessRole(m.role)) return false;
  const ownerId = turnOwnerId(m);
  if (
    activeClientMessageId !== undefined &&
    ownerId === activeClientMessageId
  ) {
    return false;
  }
  if (
    typeof ownerId === "string" &&
    evidence.clientMessageIds.has(ownerId)
  ) {
    return true;
  }
  return matchesEvidenceTurnPrefix(m.id, evidence.turnPrefixes);
}


export function mergeFullServerWins(
  server: ChatMessage[],
  local: ChatMessage[],
  archivedThroughSeq = 0,
  completedClientMessageId?: string,
  opts?: {
    /** P1 缺席删除授权:仅当调用方已过版本护栏(载荷带 updatedAt 且 ≥ 已应用水位;被证明过期
     *  的载荷在 applyServerMessages 已整体丢弃,不会走到这里)时为 true。fresh full 的缺席权威
     *  = 版本护栏 + id 缺席 + 归档水位保护,不做行级 seq 豁免(maxSeq 非单调且与 _orderSeq
     *  跨轴,Codex R2 BLOCKER;"增量先到旧 full 晚到"竞态由整体丢弃闭合)。 */
    deletionAuthority?: boolean;
    /** 当前活跃轮 clientMessageId(REST/WS 竞态守卫,活跃轮的行绝不被载荷自证清除)。 */
    activeClientMessageId?: string;
    /** A history revision change invalidates persisted rows absent from
     * the full payload. Archived rows are dropped for later rehydration;
     * hot rows with `_seq` propagate cross-device deletion. */
    invalidateHistoryCache?: boolean;
    /** First adoption of the unified timeline after an old bundle/IndexedDB
     * cache. Historical client process cards are refetchable substitutes and
     * must not coexist with exact rows; only the genuinely active turn stays. */
    adoptUnifiedTimeline?: boolean;
  },
): ChatMessage[] {
  local = repairPostFinalProcessOrder(local);
  const legacyActiveRows = new Set<ChatMessage>();
  if (opts?.adoptUnifiedTimeline === true && opts.activeClientMessageId) {
    let insideActiveTurn = false;
    local = local.map((message) => {
      if (message.role === "user") {
        insideActiveTurn = message.id === opts.activeClientMessageId;
      } else if (insideActiveTurn && isTapeBackedAgentProcessRole(message.role)) {
        // A predecessor bundle did not stamp plan/goal/team rows with an
        // owner. Preserve the genuinely active segment during first adoption,
        // but attach its user id now so the exact terminal tape can remove
        // every temporary live card instead of leaving permanent duplicates.
        const owned = turnOwnerId(message) === opts.activeClientMessageId
          ? message
          : { ...message, _turnOwnerId: opts.activeClientMessageId };
        legacyActiveRows.add(owned);
        return owned;
      }
      return message;
    });
  }
  const unpublishedFinalOwners = new Set<string>();
  for (const m of server) {
    if (
      m?._displayDegradeReason === "records_unpublished" &&
      m.role === "assistant" &&
      typeof m._clientMessageId === "string" &&
      m._clientMessageId.length > 0
    ) {
      unpublishedFinalOwners.add(m._clientMessageId);
    }
  }
  const hasExactCompletionEvidence =
    !!completedClientMessageId &&
    server.some(
      (m) =>
        isServerAuthoredRow(m) &&
        m._clientMessageId === completedClientMessageId &&
        m._displayDegradeReason !== "records_unpublished" &&
        (m.role === "assistant" || m.role === "thinking" || m.role === "tool"),
    );
  if (hasExactCompletionEvidence) {
    local = local.filter((m) => !isSupersededLocalTurnRow(m, completedClientMessageId));
  }
  if (unpublishedFinalOwners.size > 0) {
    // Phase-A degrade page is not a complete tape: keep local live
    // thinking/tool/plan, drop only the live assistant so the final can land.
    local = local.filter((m) => {
      const owner = turnOwnerId(m);
      if (
        m.role === "assistant" &&
        m._source !== "server" &&
        typeof owner === "string" &&
        unpublishedFinalOwners.has(owner)
      ) {
        return false;
      }
      return true;
    });
  }
  const serverIdsForAuthority = new Set<string>();
  for (const m of server) if (m?.id) serverIdsForAuthority.add(m.id);
  const evidence = buildServerTurnEvidence(server);
  const exactTimelineAgentGroupRunIds = collectExactTimelineAgentGroupRunIds(server);
  // 同步权威传播(见 buildServerTurnEvidence docstring):
  //  P1(缺席判定,需 deletionAuthority=调用方已过版本护栏)—— `_source:'server'` 的本地行,
  //    full 载荷不带且高于归档水位 → server 已删除(事故清理/终态行离场),本地跟删,否则
  //    服务端清理永远传播不到端上。无行级 seq 豁免(maxSeq 非单调且与 _orderSeq 跨轴;
  //    "增量先到旧 full 晚到"由 applyServerMessages 整体丢弃过期载荷闭合)。无授权时跳过:
  //    旧 full 快照的缺席不是删除证明(BLOCKER:晚到旧快照会把新行永久删丢——_maxSeq 游标
  //    单调,删了就再也增量不回来)。
  //  P2(证据为正,无需版本护栏)—— 已被载荷作证覆盖 turn 的本地过期副本 → 删。
  local = local.filter((m) => {
    if (!m) return false;
    if (
      opts?.adoptUnifiedTimeline === true &&
      m._timelineRecord !== true &&
      isTapeBackedAgentProcessRole(m.role)
    ) {
      const ownerId = turnOwnerId(m);
      const belongsToActiveTurn =
        typeof opts.activeClientMessageId === "string" &&
        (ownerId === opts.activeClientMessageId || legacyActiveRows.has(m));
      const unpublishedProcess =
        typeof ownerId === "string" &&
        unpublishedFinalOwners.has(ownerId) &&
        m.role !== "assistant";
      if (!belongsToActiveTurn && !unpublishedProcess) return false;
    }
    if (
      m._timelineRecord !== true &&
      m.role === "agent-group" &&
      exactTimelineAgentGroupRunIds.has(agentGroupRunId(m) ?? "")
    ) return false;
    if (opts?.invalidateHistoryCache === true) {
      if (isArchivedServerRow(m, archivedThroughSeq)) return false;
      const persisted = typeof m._seq === "number" && Number.isSafeInteger(m._seq) && m._seq > 0;
      const belongsToActiveTurn =
        typeof opts.activeClientMessageId === "string" &&
        (m.id === opts.activeClientMessageId || m._clientMessageId === opts.activeClientMessageId);
      if (persisted && m.id && !serverIdsForAuthority.has(m.id) && !belongsToActiveTurn) return false;
    }
    if (
      opts?.deletionAuthority === true &&
      m._source === "server" &&
      m.id &&
      !serverIdsForAuthority.has(m.id) &&
      !isArchivedServerRow(m, archivedThroughSeq) &&
      // 惰性过程记录不随会话首读返回，其缺席是预期。
      !isLocallyExpandedTapeRow(m) &&
      // Phase-A unpublished page is not absence proof for this turn's process rows.
      !(
        typeof turnOwnerId(m) === "string" &&
        unpublishedFinalOwners.has(turnOwnerId(m)!) &&
        isTapeBackedAgentProcessRole(m.role) &&
        m.role !== "assistant"
      )
    ) {
      return false;
    }
    return !isCoveredStaleLocalRow(m, evidence, opts?.activeClientMessageId);
  });
  // 债A：本地富卡拥有的 run → 丢弃 server 同 run 骨架行(local-wins,保住 childBlocks)。
  server = dropServerTeamSkeletonsOwnedLocally(server, local);
  const localById = new Map<string, ChatMessage>();
  for (const m of local) if (m?.id) localById.set(m.id, m);
  const serverMerged = server.map((m) => mergeLocalClientFields(
    m,
    m?.id ? localById.get(m.id) : undefined,
    opts?.invalidateHistoryCache !== true,
  ));
  const serverChanged = serverMerged.some((m, idx) => m !== server[idx]);
  const serverIds = new Set<string>();
  for (const m of server) if (m?.id) serverIds.add(m.id);
  let i = local.length;
  while (i > 0 && local[i - 1]?.id && !serverIds.has(local[i - 1].id)) i--;
  const tail = local.slice(i);
  const preservedMid = local
    .slice(0, i)
    .filter(
      (m) =>
        m?.id &&
        !serverIds.has(m.id) &&
        // ④ 已归档的 server 行(server 只回热尾巴时 _orderSeq ≤ 水位):无条件保留。
        (isArchivedServerRow(m, archivedThroughSeq) ||
          // ① user 行=客户端权威;② 团队卡=client-owned(见 docstring ③),被 adopt 吸收的
          // standalone progress 行(_adoptedInto)已并入 group,不重复保留。
          m.role === "user" ||
          (isTeamOwnedRole(m.role) && !m._adoptedInto) ||
          // ⑦ 引擎权限卡仍是 client-owned；detached ask_user 若已在 server 同 id 则走 server-wins。
          m.role === "permission" ||
          // ⑤ client-owned system 行(context_rebuilt 重建提示):server-authored 通道从不产出。
          (m.role === "system" && !isServerAuthoredRow(m)) ||
          // ⑥ Lazy process rows:the ordinary timeline returns the control + narrative, not fetched process pages.
          //    中段)时,须与 P1 缺席豁免一致地保留,否则 full sync 把中段展开态打回折叠。
          isLocallyExpandedTapeRow(m)),
    );
  if (!tail.length && !preservedMid.length) {
    return repairPostFinalProcessOrder(
      stableSortByTs(serverChanged ? serverMerged : server),
    );
  }
  const safeByOriginal = new Map<ChatMessage, ChatMessage>();
  for (const m of [...preservedMid, ...tail]) safeByOriginal.set(m, sanitizePreservedLocalRow(m));
  const safePreservedMid = preservedMid.map((m) => safeByOriginal.get(m)!);
  const safeTail = tail.map((m) => safeByOriginal.get(m)!);
  const hasDurableOrderAxis = serverMerged.some(
    (m) => typeof m._orderSeq === "number" && Number.isSafeInteger(m._orderSeq) && m._orderSeq > 0,
  );
  if (!hasDurableOrderAxis) {
    // 兼容尚无 `_orderSeq` 的旧 server 快照：沿用 server→mid→tail 插入序，再按 ts 排列。
    return repairPostFinalProcessOrder(
      stableSortByTs([...serverMerged, ...safePreservedMid, ...safeTail]),
    );
  }
  // 中段 client-owned 行若在拼接时离开本地原槽，会错误继承 server 尾行的排序锚点。
  // 一方面按原 local 插入序重建槽位；另一方面保留一次性 anchor override，明确冻结其
  // 最近一条可信耐久行。override 以去掉本地伪造 `_orderSeq` 后的对象为 key，不写回消息。
  const preservedMidSet = new Set(preservedMid);
  const preserved = new Set<ChatMessage>([...preservedMid, ...tail]);
  const serverMergedById = new Map<string, ChatMessage>();
  for (const m of serverMerged) if (m?.id) serverMergedById.set(m.id, m);
  const anchorOverrides = new Map<ChatMessage, number>();
  let localCarry = 0;
  for (let localIndex = 0; localIndex < i; localIndex++) {
    const original = local[localIndex]!;
    const safe = safeByOriginal.get(original) ?? original;
    const peer = original?.id ? serverMergedById.get(original.id) : undefined;
    const ownOrPeer = validHistoryOrder(peer?._orderSeq)
      ? peer._orderSeq
      : validHistoryOrder(safe?._orderSeq)
        ? safe._orderSeq
        : null;
    if (ownOrPeer !== null) localCarry = ownOrPeer;
    if (preservedMidSet.has(original) && !validHistoryOrder(safe._orderSeq) && localCarry > 0) {
      anchorOverrides.set(safe, localCarry);
    }
  }
  const emittedServerIds = new Set<string>();
  const inLocalOrder: ChatMessage[] = [];
  for (const m of local) {
    const serverRow = m?.id ? serverMergedById.get(m.id) : undefined;
    if (serverRow) {
      if (!emittedServerIds.has(serverRow.id)) {
        inLocalOrder.push(serverRow);
        emittedServerIds.add(serverRow.id);
      }
    } else if (preserved.has(m)) {
      inLocalOrder.push(safeByOriginal.get(m)!);
    }
  }
  // Full sync 可能首次带回 final；放到原 local 槽位重建之后，再由 durable order axis 归位。
  for (const m of serverMerged) {
    if (!m?.id || !emittedServerIds.has(m.id)) {
      inLocalOrder.push(m);
      if (m?.id) emittedServerIds.add(m.id);
    }
  }
  return repairPostFinalProcessOrder(
    stableSortByTs(inLocalOrder, anchorOverrides),
  );
}

/**
 * 增量合并（getSession ?since 返回的增量）：在 `local` 基础上，按 id 用 `incoming` 覆盖
 * 已有项（server-wins），并追加新 id；最后按 ts 稳定归位，避免低 `_seq` 本地"继续"
 * 后到的 server 消息被机械追加到整段尾部。团队/委派卡是 client-owned 展示结构：若
 * server 历史只带空壳同 id 行，合并时保留本地更完整的 childBlocks/entries/完成态。
 */
export function applyServerIncremental(
  local: ChatMessage[],
  incoming: ChatMessage[],
  completedClientMessageId?: string,
  opts?: {
    /** 当前活跃轮 clientMessageId(REST/WS 竞态守卫,同 mergeFullServerWins)。 */
    activeClientMessageId?: string;
  },
): ChatMessage[] {
  local = repairPostFinalProcessOrder(local);
  if (!incoming.length) return local;
  if (
    completedClientMessageId &&
    incoming.some(
      (m) =>
        isServerAuthoredRow(m) &&
        m._clientMessageId === completedClientMessageId &&
        (m.role === "assistant" || m.role === "thinking" || m.role === "tool"),
    )
  ) {
    local = local.filter((m) => !isSupersededLocalTurnRow(m, completedClientMessageId));
  }
  // 同步权威传播 P2(增量版,证据为正):增量带回某 turn 的 v2 tape 展开行 = 该 turn 已原子
  // 落权威库,同 turn 的本地过期副本一并清除——不依赖调用方恰好传 completedClientMessageId。
  // P1(缺席判定)不适用增量:增量载荷缺席不代表不存在。
  const incomingEvidence = buildServerTurnEvidence(incoming);
  const exactTimelineAgentGroupRunIds = collectExactTimelineAgentGroupRunIds(incoming);
  local = local.filter(
    (m) => m && !(
      m._timelineRecord !== true &&
      m.role === "agent-group" &&
      exactTimelineAgentGroupRunIds.has(agentGroupRunId(m) ?? "")
    ) && !isCoveredStaleLocalRow(m, incomingEvidence, opts?.activeClientMessageId),
  );
  // 债A：增量带回的 server 团队骨架行,若本地富卡已拥有同 run → 丢弃(local-wins,同 full 合并)。
  incoming = dropServerTeamSkeletonsOwnedLocally(incoming, local);
  if (!incoming.length) return local;
  const byId = new Map<string, ChatMessage>();
  for (const m of incoming) if (m?.id) byId.set(m.id, m);
  const merged = local.map((m) => (m?.id && byId.has(m.id) ? mergeLocalClientFields(byId.get(m.id)!, m) : m));
  const seen = new Set<string>();
  for (const m of local) if (m?.id) seen.add(m.id);
  for (const m of incoming) if (m?.id && !seen.has(m.id)) merged.push(m);
  return repairPostFinalProcessOrder(stableSortByTs(merged));
}

/**
 * 归档分页并入:把云端 getSessionArchive 拉回的更早归档消息(server-authored、srv-* id、
 * `_orderSeq` 升序)前插进本地 messages。**只前插 + 按 id 去重,绝不触发 server-wins 覆盖本地富卡**
 * (归档行 id 与本地 m-* 天然不撞;已在本地的归档 id 直接跳过,不重复插入)。合并后 stableSortByTs
 * 按 `_orderSeq` 归位。无新增时**返回原引用**(零拷贝,免无谓重渲)。
 */
export function mergeArchivedHistory(local: ChatMessage[], archived: ChatMessage[]): ChatMessage[] {
  local = repairPostFinalProcessOrder(local);
  if (!archived.length) return local;
  const existing = new Set<string>();
  for (const m of local) if (m?.id) existing.add(m.id);
  const add = archived.filter((m) => m?.id && !existing.has(m.id));
  if (!add.length) return local;
  return repairPostFinalProcessOrder(
    stableSortByTs([...add, ...local]),
  );
}

/** Merge one explicit unified-history page by its server logical identity.
 * Loaded rows are never rewritten, coalesced or evicted during the page
 * lifetime; virtualization alone controls DOM cost. */
export function mergeTimelineHistoryPage(
  local: ChatMessage[],
  older: ChatMessage[],
): ChatMessage[] {
  if (older.length === 0) return local;
  const keyOf = (message: ChatMessage): string =>
    message._timelineUnitKey ?? `id:${message.id}`;
  const existing = new Set(local.map(keyOf));
  const add = older.filter((message) => {
    const key = keyOf(message);
    if (existing.has(key)) return false;
    existing.add(key);
    return true;
  });
  if (add.length === 0) return local;
  return stableSortByTs([...add, ...local]);
}

type TimelineBashTailCandidate = {
  tail: BashTail;
  evidence: TimelineBashTailEvidence;
  parentToolUseId: string;
};

function compareTimelineBashTailCandidates(
  a: TimelineBashTailCandidate,
  b: TimelineBashTailCandidate,
): number {
  if (a.tail.totalBytes !== b.tail.totalBytes) return a.tail.totalBytes - b.tail.totalBytes;
  if (a.evidence.orderSeq !== b.evidence.orderSeq) return a.evidence.orderSeq - b.evidence.orderSeq;
  const tapeOrder = a.evidence.tapeId.localeCompare(b.evidence.tapeId);
  return tapeOrder !== 0 ? tapeOrder : a.evidence.ordinal - b.evidence.ordinal;
}

function shouldApplyTimelineBashTail(
  current: BashTail | undefined,
  currentEvidence: TimelineBashTailEvidence | undefined,
  candidate: TimelineBashTailCandidate,
): boolean {
  if (!current) return true;
  if (candidate.tail.totalBytes !== current.totalBytes) {
    return candidate.tail.totalBytes > current.totalBytes;
  }
  if (!currentEvidence) return true;
  const evidenceOrder = compareTimelineBashTailCandidates(candidate, {
    tail: current,
    evidence: currentEvidence,
    parentToolUseId: candidate.parentToolUseId,
  });
  if (evidenceOrder !== 0) return evidenceOrder > 0;
  return candidate.tail.tail !== current.tail ||
    candidate.tail.truncatedHead !== current.truncatedHead;
}

/** Merge hidden exact Bash-tail evidence into its real ToolCard. Auxiliary
 * rows remain resident so a later explicit older page can reveal the owning
 * tool; they never become cards or virtualization items themselves. */
export function reconcileTimelineBashTailAuxiliaries(
  messages: ChatMessage[],
): ChatMessage[] {
  const topCandidates = new Map<string, TimelineBashTailCandidate>();
  const childCandidates = new Map<string, Map<string, TimelineBashTailCandidate>>();
  for (const message of messages) {
    if (
      message._timelineAuxiliary !== "bash-tail" ||
      message._payloadDeferred === true ||
      message.role !== "runtime-event"
    ) continue;
    const event = message._runtimeEvent;
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const raw = event as Record<string, unknown>;
    if (
      raw.type !== "system" || raw.subtype !== "bash_output_tail" ||
      typeof raw.tool_use_id !== "string" || raw.tool_use_id.length === 0 ||
      typeof raw.total_bytes !== "number" || !Number.isFinite(raw.total_bytes) || raw.total_bytes < 0 ||
      typeof message._orderSeq !== "number" || !Number.isSafeInteger(message._orderSeq) ||
      typeof message._turnTapeId !== "string" || message._turnTapeId.length === 0 ||
      typeof message._recordOrdinal !== "number" || !Number.isSafeInteger(message._recordOrdinal)
    ) continue;
    const ownerTurnKey = typeof message._continuationOfTurnKey === "string" &&
        message._continuationOfTurnKey.length > 0
      ? message._continuationOfTurnKey
      : message._turnKey;
    if (typeof ownerTurnKey !== "string" || ownerTurnKey.length === 0) continue;
    const parentToolUseId = typeof raw.parent_tool_use_id === "string"
      ? raw.parent_tool_use_id
      : "";
    const candidate: TimelineBashTailCandidate = {
      tail: {
        tail: typeof raw.tail === "string" ? raw.tail : "",
        totalBytes: raw.total_bytes,
        truncatedHead: raw.truncated_head === true,
      },
      evidence: {
        orderSeq: message._orderSeq,
        tapeId: message._turnTapeId,
        ordinal: message._recordOrdinal,
      },
      parentToolUseId,
    };
    const targetKey = `${ownerTurnKey}\0${raw.tool_use_id}`;
    if (!parentToolUseId) {
      const previous = topCandidates.get(targetKey);
      if (!previous || compareTimelineBashTailCandidates(candidate, previous) > 0) {
        topCandidates.set(targetKey, candidate);
      }
      continue;
    }
    const byParent = childCandidates.get(targetKey) ?? new Map<string, TimelineBashTailCandidate>();
    const previous = byParent.get(parentToolUseId);
    if (!previous || compareTimelineBashTailCandidates(candidate, previous) > 0) {
      byParent.set(parentToolUseId, candidate);
    }
    childCandidates.set(targetKey, byParent);
  }
  if (topCandidates.size === 0 && childCandidates.size === 0) return messages;

  const childCandidate = (
    ownerTurnKey: string,
    toolUseId: string,
    parentIds: ReadonlySet<string>,
  ): TimelineBashTailCandidate | null => {
    const byParent = childCandidates.get(`${ownerTurnKey}\0${toolUseId}`);
    if (!byParent || byParent.size === 0) return null;
    let winner: TimelineBashTailCandidate | null = null;
    for (const [parentId, candidate] of byParent) {
      if (!parentIds.has(parentId)) continue;
      if (!winner || compareTimelineBashTailCandidates(candidate, winner) > 0) winner = candidate;
    }
    // Persisted delegate transcripts do not retain their gateway routing id.
    // A globally unique tool_use_id plus exactly one exact parent candidate is
    // still unambiguous; multiple unmatched parents fail closed.
    if (!winner && byParent.size === 1) winner = byParent.values().next().value ?? null;
    return winner;
  };
  const reconcileChildren = (
    blocks: ChildBlock[],
    ownerTurnKey: string,
    parentIds: ReadonlySet<string>,
  ): { blocks: ChildBlock[]; changed: boolean } => {
    let changed = false;
    const nextBlocks = blocks.map((block) => {
      let next = block;
      if (block.kind === "tool_use" && typeof block.blockId === "string") {
        const candidate = childCandidate(ownerTurnKey, block.blockId, parentIds);
        if (candidate && shouldApplyTimelineBashTail(
          block.bashTail,
          block._runtimeBashTailEvidence,
          candidate,
        )) {
          next = {
            ...next,
            bashTail: candidate.tail,
            _runtimeBashTailEvidence: candidate.evidence,
          };
          changed = true;
        }
      }
      if (Array.isArray(block.childBlocks) && block.childBlocks.length > 0) {
        const nestedParents = new Set(parentIds);
        if (typeof block.blockId === "string" && block.blockId.length > 0) {
          nestedParents.add(block.blockId);
        }
        const nested = reconcileChildren(block.childBlocks, ownerTurnKey, nestedParents);
        if (nested.changed) {
          next = { ...next, childBlocks: nested.blocks };
          changed = true;
        }
      }
      return next;
    });
    return { blocks: changed ? nextBlocks : blocks, changed };
  };

  let changed = false;
  const reconciled = messages.map((message) => {
    const ownerTurnKey = message._turnKey;
    if (typeof ownerTurnKey !== "string" || ownerTurnKey.length === 0) return message;
    let next = message;
    if (message.role === "tool" && typeof message.blockId === "string") {
      const candidate = topCandidates.get(`${ownerTurnKey}\0${message.blockId}`);
      if (candidate && shouldApplyTimelineBashTail(
        message.bashTail,
        message._runtimeBashTailEvidence,
        candidate,
      )) {
        next = {
          ...next,
          bashTail: candidate.tail,
          _runtimeBashTailEvidence: candidate.evidence,
        };
        changed = true;
      }
    }
    if (Array.isArray(message.childBlocks) && message.childBlocks.length > 0) {
      const rootParents = new Set<string>();
      for (const value of [message.blockId, message._delegateRunId, message.runId, message.id]) {
        if (typeof value === "string" && value.length > 0) rootParents.add(value);
      }
      const children = reconcileChildren(message.childBlocks, ownerTurnKey, rootParents);
      if (children.changed) {
        next = {
          ...next,
          childBlocks: children.blocks,
          _runtimeBashTailRevision: (message._runtimeBashTailRevision ?? 0) + 1,
        };
        changed = true;
      }
    }
    return next;
  });
  return changed ? reconciled : messages;
}

/** `_orderSeq ≤ 归档水位` = server 已把该行搬进归档 chunk。 */
function isArchivedServerRow(m: ChatMessage, archivedThroughSeq: number): boolean {
  const orderSeq = typeof m._orderSeq === "number" && Number.isFinite(m._orderSeq)
    ? m._orderSeq
    : m._seq; // rolling compatibility with pre-_orderSeq IndexedDB rows
  return (
    archivedThroughSeq > 0 &&
    typeof orderSeq === "number" &&
    Number.isFinite(orderSeq) &&
    orderSeq <= archivedThroughSeq
  );
}

function isTeamOwnedRole(role: ChatMessage["role"] | undefined): boolean {
  return role === "agent-group" || role === "delegate-progress";
}

/** 本地**富卡**(非 server-authored)agent-group 行拥有的 runId 集合(债A 去重键)。 */
function collectLocalRichAgentGroupRunIds(local: ChatMessage[]): Set<string> {
  const runIds = new Set<string>();
  for (const m of local) {
    if (m?.role === "agent-group" && !isServerAuthoredRow(m)) {
      const rid = agentGroupRunId(m);
      if (rid) runIds.add(rid);
    }
  }
  return runIds;
}

/** A unified timeline row is the exact server record, never a team-card
 * skeleton. Its run id authorizes removing the matching live client card so
 * the page shows one genuine record rather than a local substitute + duplicate. */
function collectExactTimelineAgentGroupRunIds(rows: ChatMessage[]): Set<string> {
  const runIds = new Set<string>();
  for (const message of rows) {
    if (message?._timelineRecord !== true || message.role !== "agent-group") continue;
    const runId = agentGroupRunId(message);
    if (runId) runIds.add(runId);
  }
  return runIds;
}

/**
 * 债A 去重:从 `rows` 中剔除「本地富卡已拥有同 runId」的 server-authored agent-group 骨架行。
 * 只针对 server 骨架(srv-* 或 _source:'server' 的 agent-group),不碰本地富卡,也不碰同 id 覆盖路径
 * (骨架 id 与本地富卡 id 天然不同,唯一去重维度是 runId)。无剔除时**返回原引用**,保住零拷贝
 * 语义(mergeFullServerWins 的 `.toBe(server)` / applyServerIncremental 空增量短路)。
 */
function dropServerTeamSkeletonsOwnedLocally(rows: ChatMessage[], local: ChatMessage[]): ChatMessage[] {
  const localRunIds = collectLocalRichAgentGroupRunIds(local);
  if (localRunIds.size === 0) return rows;
  const kept = rows.filter((m) => {
    if (m?.role !== "agent-group" || !isServerAuthoredRow(m)) return true;
    if (m._timelineRecord === true) return true;
    const rid = agentGroupRunId(m);
    return !(rid && localRunIds.has(rid));
  });
  return kept.length === rows.length ? rows : kept;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Team/delegate rows are rendered from client-owned UI state. Older server
 * rows may contain the same `m-*` id but lack the fields stripped by the
 * client-session write allow-list; letting that row win makes reopened team
 * turns look blank. Keep the server row as the base, but fill missing/poorer
 * display fields from the richer local IndexedDB row.
 */
function mergeLocalClientFields(
  serverMsg: ChatMessage,
  localMsg?: ChatMessage,
  preserveTapeProcessExpansion = true,
): ChatMessage {
  if (!localMsg || serverMsg.id !== localMsg.id) return serverMsg;
  // Unified timeline rows are exact persisted Agent records. Never transform
  // one back into a live client team card or enrich it with cached substitute
  // fields; server exact wins byte-for-byte at the semantic field layer.
  if (serverMsg._timelineRecord === true) return serverMsg;
  // A turn waiver is irreversible (pending→applied only). A live waiver frame
  // may beat an older REST full response with the same message id/version, so
  // keep the applied marker monotonic while every other usage field remains
  // server-wins. This affects presentation only; billing never trusts IndexedDB.
  if (localMsg.usage?.waived === true && serverMsg.usage?.waived !== true) {
    serverMsg = {
      ...serverMsg,
      usage: { ...(serverMsg.usage ?? {}), waived: true },
    };
  }
  // The process control's local loaded flag is view state:an ordinary server refresh must not clear
  // the section while the user is inspecting immutable records. 与 waived
  // 同款单调保留:仅保留展开标记 + 游标,anchor 其余字段仍 server-wins。展开行本体(独立 flat 行)由
  // mergeFullServerWins 的 P1 缺席豁免(isLocallyExpandedTapeRow)保护。
  if (
    preserveTapeProcessExpansion &&
    localMsg._turnTapeProcessExpanded === true &&
    serverMsg._turnTapeProcess === true
  ) {
    serverMsg = {
      ...serverMsg,
      _turnTapeProcessExpanded: true,
      ...(localMsg._turnTapeProcessCursor !== undefined ? { _turnTapeProcessCursor: localMsg._turnTapeProcessCursor } : {}),
    };
  }
  // server echo owns the durable user row, but these client-only fields are required to
  // faithfully retry that exact turn after a later turn changes the session routing.
  if (serverMsg.role === "user" && localMsg.role === "user") {
    const localFields = {
      ...(localMsg._media !== undefined ? { _media: localMsg._media } : {}),
      ...(localMsg._retryMedia !== undefined ? { _retryMedia: localMsg._retryMedia } : {}),
      ...(localMsg._imageEdit !== undefined ? { _imageEdit: localMsg._imageEdit } : {}),
      ...(localMsg._modelText !== undefined ? { _modelText: localMsg._modelText } : {}),
      ...(serverMsg._replyTo === undefined && localMsg._replyTo !== undefined
        ? { _replyTo: localMsg._replyTo }
        : {}),
      ...(localMsg._routing !== undefined ? { _routing: localMsg._routing } : {}),
      ...(localMsg._automaticRecoveryAttempted === true
        ? { _automaticRecoveryAttempted: true }
        : {}),
      ...((typeof serverMsg._recoveryOfClientMessageId !== "string" ||
        serverMsg._recoveryOfClientMessageId.length === 0) &&
      typeof localMsg._recoveryOfClientMessageId === "string" &&
      localMsg._recoveryOfClientMessageId.length > 0
        ? { _recoveryOfClientMessageId: localMsg._recoveryOfClientMessageId }
        : {}),
      ...(serverMsg._recoveryMode === undefined &&
      (localMsg._recoveryMode === "checkpoint" || localMsg._recoveryMode === "replay")
        ? { _recoveryMode: localMsg._recoveryMode }
        : {}),
      ...(serverMsg._automaticRecovery === undefined &&
      typeof localMsg._automaticRecovery === "boolean"
        ? { _automaticRecovery: localMsg._automaticRecovery }
        : {}),
    };
    return Object.keys(localFields).length > 0 ? { ...serverMsg, ...localFields } : serverMsg;
  }
  // 本地已把 delegate 工具行**原位转换**成 agent-group 富卡（normalizeDelegateToolRow），
  // server 同 id 仍是转换前的 tool 行。直接 server-wins 会把富卡打回裸工具行、丢掉流式期
  // 积累的 childBlocks。此时以本地富卡为底,只从 server 行回填完成态/结果预览（server 可能
  // 带着客户端离线期间才到达的最终输出）。
  if (localMsg.role === "agent-group" && localMsg._delegate === true && serverMsg.role === "tool") {
    let out: ChatMessage | null = null;
    const ensure = () => (out ??= { ...localMsg });
    const preview = friendlyDelegateResultPreview(serverMsg.output);
    if (preview && !localMsg._resultPreview) ensure()._resultPreview = preview.slice(0, 200);
    if (serverMsg.inputJson !== undefined) ensure().inputJson = serverMsg.inputJson;
    if (serverMsg.partialJson !== undefined) ensure().partialJson = serverMsg.partialJson;
    if (serverMsg.inputPreview !== undefined) ensure().inputPreview = serverMsg.inputPreview;
    if (serverMsg.output !== undefined) ensure().output = serverMsg.output;
    if (serverMsg.bashTail !== undefined) ensure().bashTail = serverMsg.bashTail;
    if (serverMsg.error && !localMsg._isError) ensure()._isError = true;
    if (serverMsg._completed && !localMsg._completed) ensure()._completed = true;
    return out ?? localMsg;
  }
  if (!isTeamOwnedRole(serverMsg.role) || serverMsg.role !== localMsg.role) return serverMsg;

  const server = serverMsg as unknown as Record<string, unknown>;
  const local = localMsg as unknown as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  const ensureOut = () => {
    if (!out) out = { ...server };
    return out;
  };
  const copyIfMissing = (key: keyof ChatMessage | "entries" | "summary" | "goal" | "error" | "_adoptedInto") => {
    const sk = String(key);
    if (hasOwn(server, sk)) return;
    if (!hasOwn(local, sk)) return;
    ensureOut()[sk] = local[sk];
  };
  const copyStringIfRicher = (key: keyof ChatMessage | "summary" | "goal" | "_adoptedInto") => {
    const sk = String(key);
    const lv = local[sk];
    if (!nonEmptyString(lv)) return;
    const sv = server[sk];
    if (!nonEmptyString(sv) || lv.length > sv.length) ensureOut()[sk] = lv;
  };
  const copyArrayIfRicher = (key: "childBlocks" | "entries") => {
    const la = Array.isArray(local[key]) ? (local[key] as unknown[]) : [];
    if (la.length === 0) return;
    const sa = Array.isArray(server[key]) ? (server[key] as unknown[]) : [];
    if (la.length > sa.length) ensureOut()[key] = local[key];
  };

  if (!nonEmptyString(server.text) && nonEmptyString(local.text)) ensureOut().text = local.text;
  copyArrayIfRicher("childBlocks");
  copyArrayIfRicher("entries");
  // 字段清单从 @openclaude/protocol/teamCards 单一权威派生(服务端 strip 白名单同源),
  // 新增团队展示字段只加在那里,两侧自然同步;数组字段上面已按"更富者胜"特判。
  for (const key of TEAM_CARD_CLIENT_DISPLAY_FIELDS) {
    if (key === "childBlocks" || key === "entries") continue;
    copyIfMissing(key);
  }
  for (const key of [
    "_delegateAgentId",
    "_delegateGoal",
    "_agentGroupOrigin",
    "_delegateRunId",
    "_resultPreview",
    "runId",
    "goal",
    "summary",
    "_adoptedInto",
  ] as const) {
    copyStringIfRicher(key);
  }
  if (localMsg._teamFallback === true && serverMsg._teamFallback !== true) {
    ensureOut()._teamFallback = true;
  }
  return (out as ChatMessage | null) ?? serverMsg;
}

/**
 * 历史全序稳定排序。展示主轴 = 冻结的 `_orderSeq`(首次持久化即定、任何 patch 不改);缺自身
 * `_orderSeq` 的本地乐观行**锚定到插入序里最近一条带 `_orderSeq` 的耐久行**(anchorOrderSeq
 * carry-forward),锚内再按 `(ts, 插入序 idx)` 定序 —— 这样耐久行位置绝对冻结,乐观窗只在锚点内
 * 浮动,server echo 后自然收敛。同一 tape 的展开行共享一个 `_orderSeq`，其内部再按持久的
 * `_turnTapeOrdinal` 排序，不能让各 record 的 wall clock 回拨把终答移到 thinking/tool 前。
 * 比较器是**单一字典序元组**
 * `(anchorOrderSeq, durableRank, intraRank, tapeOrdinal, ts, idx)`，末键全局唯一，保持全序。
 * `anchorOverrides` 只修复 full merge 重排出来的 preservedMid；override 不写回消息也不更新 carry。
 */
export function stableSortByTs(
  messages: ChatMessage[],
  anchorOverrides?: ReadonlyMap<ChatMessage, number>,
): ChatMessage[] {
  if (messages.length <= 1) return messages;
  let anchorOrderSeq = 0;
  const sorted = messages
    .map((m, idx) => {
      const ownOrderSeq = validHistoryOrder(m._orderSeq) ? m._orderSeq : null;
      if (ownOrderSeq !== null) anchorOrderSeq = ownOrderSeq;
      const override = validHistoryOrder(anchorOverrides?.get(m))
        ? anchorOverrides!.get(m)!
        : null;
      const tapeOrdinal =
        typeof m._turnTapeId === "string" && m._turnTapeId.length > 0 &&
        typeof m._turnTapeOrdinal === "number" &&
        Number.isSafeInteger(m._turnTapeOrdinal) && m._turnTapeOrdinal >= 0
          ? m._turnTapeOrdinal
          : null;
      const logicalOrdinal =
        typeof m._timelineLogicalOrdinal === "number" &&
        Number.isSafeInteger(m._timelineLogicalOrdinal) && m._timelineLogicalOrdinal >= 0
          ? m._timelineLogicalOrdinal
          : 0;
      return {
        m,
        idx,
        // override 刻意不写回 carry：tail 仍锚到合并载荷最后一条耐久行。
        anchorOrderSeq: ownOrderSeq ?? override ?? anchorOrderSeq,
        // 同一 _orderSeq 槽内**耐久行恒先于**锚定其上的本地乐观行:锚点语义是「该乐观行按
        // 插入序紧跟这条耐久行之后」,故即便时钟偏移让乐观行 ts 更小,也绝不得排到锚点耐久行
        // 之前。这条 tiebreak 还消除 anchor carry-forward 的**非幂等**——否则乐观行被更小的
        // ts 甩到锚点耐久行之前,下一趟排序会重新锚定到更靠前的耐久行 → 顺序反复漂移。
        durableRank: ownOrderSeq !== null ? 0 : 1,
        // 折叠标题先于展开正文；正文按 tape ordinal；无 ordinal 的 terminal/sentinel
        // 补充行置后。全是 legacy 无 ordinal 时 rank 相同，仍回退 ts/index。
        intraRank: m._turnTapeProcess === true ? 0 : tapeOrdinal !== null ? 1 : 2,
        tapeOrdinal: tapeOrdinal ?? 0,
        logicalOrdinal,
        ts: typeof m?.ts === "number" && Number.isFinite(m.ts) ? m.ts : 0,
      };
    })
    // One lexicographic tuple for every pair makes the comparator transitive.
    // Durable-first-within-slot keeps it idempotent; missing ts is a local
    // tie-breaker value, never a whole-sort bailout.
    .sort((a, b) =>
      a.anchorOrderSeq - b.anchorOrderSeq ||
      a.durableRank - b.durableRank ||
      a.intraRank - b.intraRank ||
      a.tapeOrdinal - b.tapeOrdinal ||
      a.logicalOrdinal - b.logicalOrdinal ||
      a.ts - b.ts ||
      a.idx - b.idx)
    .map((x) => x.m);
  return sorted.every((message, index) => message === messages[index]) ? messages : sorted;
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
  // 否则 live 会话会被重新写回刚清空的命名空间 → 击穿隐私 wipe。store 实例随即丢弃，
  // 同用户再登录会另建新实例（alive）。
  private dead = false;

  constructor(userId: string, factory?: IDBFactory) {
    this.userId = userId;
    // No explicit version: opening an existing v1 or v2 session cache never
    // attempts a downgrade. New databases get only the cache store.
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
    const { _pendingDispatches: legacyPending, _pendingControls: pendingControls, ...clean } = s;
    void legacyPending;
    void pendingControls;
    await this.sessionsKv.put(SESSION_STORE, s.id, clean);
  }
  /** Whole-session durable write. It deliberately cannot mutate the exact
   * pending-dispatch store. */
  async putSessionDurably(s: StoredSession): Promise<void> {
    if (this.dead) throw new Error("session store is closed");
    if (!s?.id) throw new Error("session id is required");
    const { _pendingDispatches: legacyPending, _pendingControls: pendingControls, ...clean } = s;
    void legacyPending;
    void pendingControls;
    await this.sessionsKv.putDurably(SESSION_STORE, s.id, clean);
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
    // Bridge releases can coexist with the earlier v2 store. The durable
    // tombstone above is the stale-writer fence; these are only cleanup.
    await this.sessionsKv.deleteDurably(PENDING_DISPATCH_STORE, key).catch(() => {});
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

  /** Exact control journal reuses the v1 dispatch stores so rolling back to an
   * older bundle can still open the DB. `kind` + key prefix keep message rows
   * and controls disjoint without an object-store migration. */
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
    await this.dispatchKv.settleDispatchDurably(
      pendingControlKey(sessId, controlId),
      Date.now(),
    );
  }

  private async collectPendingControls(): Promise<StoredPendingControl[]> {
    const [pending, settled] = await Promise.all([
      this.dispatchKv.getAll<StoredPendingControl>(PENDING_DISPATCH_STORE),
      this.dispatchKv.getAll<{ key?: string }>(SETTLED_DISPATCH_STORE),
    ]);
    const settledKeys = new Set(
      settled.flatMap((item) => typeof item?.key === "string" ? [item.key] : []),
    );
    return pending
      .filter((item) =>
        item?.kind === "control" &&
        typeof item.sessId === "string" && item.sessId.length > 0 &&
        typeof item.controlId === "string" && item.controlId.length > 0 &&
        !settledKeys.has(pendingControlKey(item.sessId, item.controlId)))
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }

  async getPendingControls(): Promise<StoredPendingControl[]> {
    if (this.dead) return [];
    return this.collectPendingControls();
  }

  private async collectPendingDispatches(
    sessions?: StoredSession[],
  ): Promise<StoredPendingDispatchRecord[]> {
    const sessionRows = sessions ?? await this.sessionsKv.getAll<StoredSession>(SESSION_STORE);
    const [pending, legacyV2, settled] = await Promise.all([
      this.dispatchKv.getAll<StoredPendingDispatchRecord>(PENDING_DISPATCH_STORE),
      this.sessionsKv.getAll<StoredPendingDispatchRecord>(PENDING_DISPATCH_STORE),
      this.dispatchKv.getAll<{ key?: string }>(SETTLED_DISPATCH_STORE),
    ]);
    const settledKeys = new Set(
      settled.flatMap((item) => typeof item?.key === "string" ? [item.key] : []),
    );
    const unresolved = new Map<string, StoredPendingDispatchRecord>();
    const add = (item: StoredPendingDispatchRecord) => {
      if (
        !item || typeof item.sessId !== "string" || !item.sessId ||
        typeof item.msgId !== "string" || !item.msgId
      ) return;
      const key = pendingDispatchKey(item.sessId, item.msgId);
      if (!settledKeys.has(key) && !unresolved.has(key)) unresolved.set(key, item);
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
    if (this.dead) return [];
    return this.collectPendingDispatches();
  }
  /** Hydration-only view: merge the independent journal into session values
   * in memory without ever writing it back into the sessions store. */
  async getAllForHydration(): Promise<StoredSession[]> {
    if (this.dead) return [];
    const sessions = await this.sessionsKv.getAll<StoredSession>(SESSION_STORE);
    const [pending, pendingControls] = await Promise.all([
      this.collectPendingDispatches(sessions),
      this.collectPendingControls(),
    ]);
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
    const hydrated = sessions.map((session) => {
      const items = bySession.get(session.id);
      const controls = controlsBySession.get(session.id);
      bySession.delete(session.id);
      controlsBySession.delete(session.id);
      const {
        _pendingDispatches: legacyPending,
        _pendingControls: legacyControls,
        ...clean
      } = session;
      void legacyPending;
      void legacyControls;
      if (items?.length) items.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
      if (controls?.length) controls.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
      return {
        ...clean,
        ...(items?.length ? { _pendingDispatches: items } : {}),
        ...(controls?.length ? { _pendingControls: controls } : {}),
      };
    });
    // The exact journal commits before the physical send and before the
    // best-effort whole-session cache write. A crash in that narrow window may
    // leave only journal rows; reconstruct the genuine user bubble directly
    // from their lossless payload so the replay remains visible and stoppable.
    for (const [sessId, items] of bySession) {
      items.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
      const first = items[0]!;
      const messages = items.map((item): ChatMessage => {
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
          ...(recovery
            ? {
                _recoveryOfClientMessageId: recovery.sourceClientMessageId,
                _recoveryMode: recovery.mode,
                _automaticRecovery: recovery.automatic,
              }
            : {}),
          _routing: {
            model: payload.model,
            teamMode: payload.teamMode === true,
            effortLevel: payload.effortLevel ?? null,
          },
          _sendAttempt: Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0,
        };
      });
      const firstPayload = first.payload;
      const firstText = firstPayload.content.displayText ?? firstPayload.content.text ?? "";
      const routing = messages.at(-1)!._routing!;
      hydrated.push({
        id: sessId,
        agentId: firstPayload.agentId ?? "main",
        title: sessionTitleFromText(firstText),
        messages,
        createdAt: first.enqueuedAt,
        lastAt: items.at(-1)!.enqueuedAt,
        _lastRouting: routing,
        ...(routing.model ? { _selectedModelId: routing.model } : {}),
        _pendingDispatches: items,
      });
    }
    for (const [sessId, controls] of controlsBySession) {
      const first = controls[0]!;
      hydrated.push({
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
      });
    }
    return hydrated;
  }
  getSession(id: string): Promise<StoredSession | undefined> {
    if (this.dead) return Promise.resolve(undefined);
    return this.sessionsKv.get<StoredSession>(SESSION_STORE, id).then((session) => {
      if (!session) return undefined;
      const { _pendingDispatches: legacyPending, _pendingControls: pendingControls, ...clean } = session;
      void legacyPending;
      void pendingControls;
      return clean;
    });
  }
  async getAll(): Promise<StoredSession[]> {
    if (this.dead) return [];
    const sessions = await this.sessionsKv.getAll<StoredSession>(SESSION_STORE);
    return sessions.map((session) => {
      const { _pendingDispatches: legacyPending, _pendingControls: pendingControls, ...clean } = session;
      void legacyPending;
      void pendingControls;
      return clean;
    });
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
    await Promise.allSettled([
      ...pending.map((item) =>
        this.dispatchKv.settleDispatchDurably(
          pendingDispatchKey(item.sessId, item.msgId),
          Date.now(),
        )),
      ...controls.map((item) =>
        this.dispatchKv.settleDispatchDurably(
          pendingControlKey(item.sessId, item.controlId),
          Date.now(),
        )),
    ]);
    // Settled identities contain no payload and deliberately survive logout:
    // an old v1 tab may still write an acknowledged inline journal back later.
    await Promise.all([
      this.sessionsKv.clearStores([SESSION_STORE, PENDING_DISPATCH_STORE]),
      this.dispatchKv.clearStores([PENDING_DISPATCH_STORE]),
    ]);
  }
  close(): void {
    this.sessionsKv.close();
    this.dispatchKv.close();
  }
}
