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
import type { ChatMessage, ChatRoutingSnapshot } from "./chat/model";
import { agentGroupRunId, isServerAuthoredRow } from "./chat/model";
import { friendlyDelegateResultPreview } from "./chat/reducer";

/** IndexedDB schema 版本 + 唯一对象存储名。*/
const DB_VERSION = 1;
const STORE = "sessions";

/**
 * 持久化的会话快照。**刻意只持久 reducer 产出的稳定数据 + 断点续传游标**，剥离流式
 * 指针 / Map 等运行期瞬态（注水后由 rebuildIndexes 重建，详见 socket.loadStored）。
 * `_lastFrameSeqByKey` / `_lastFrameSeq` 是断点续传游标（resume_failed 推进后必须落地，
 * 否则 reload 后 hello 仍发旧游标 → server 反复 resume 失败 → reload 死循环）。
 * `_sendingInFlight` / `_turnStartedAt` / `_lastFrameAt` 是 reload 恢复中的近期 turn
 * 活跃标记；loadStored 会按 THINKING_SAFETY_MS 丢弃过期标记，避免永久 loading。
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
  _turnStartedAt?: number;
  _lastFrameAt?: number;
  _maxSeq?: number;
  /** 归档水位(server 已把 `_seq ≤ 此值`的行搬进归档 chunk);full 合并时本地 ≤ 此值的行无条件保留。*/
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
 *  ③ **本地独有的团队/委派卡**（agent-group / delegate-progress，中段）——团队卡是
 *     client-owned 展示结构，v5 server-authored 通道只写 assistant|thinking|tool 三种
 *     role、从不产出团队行（ccbMessageParser 显式把 Agent 卡排除在 durable 快照外），
 *     所以「中段 server 不认识的团队行」不是被取代的脏数据，而是 server 端根本没有的
 *     内容；旧逻辑只保尾部会在「团队轮之后又有新轮」的 reopen 场景整卡丢失。保留后由
 *     normalizeDelegateCards（loadStored/applyServerMessages 收口处）按 blockId/runId
 *     兜底折叠,不会与 server 带回的 delegate 工具行形成重复卡。
 *
 * 其余角色（assistant/thinking/tool）乐观消息可能已被 server 以 `srv-*` 重写，中段保留
 * 会出现重复卡片，故仍只保尾部（非尾部=已被取代→丢弃）。
 * 合并后按 ts 稳定排序：user 气泡 ts < 其轮 server 助手 ts → 正确落到该轮助手之前；server
 * 本就 ts 有序、尾部乐观消息 ts 最大 → 各归其位。
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
 * full 同步返回的 `server` 可能**只含热尾巴**(`_seq > archivedThroughSeq` 的那截)。此时本地缓存
 * 里 `_seq ≤ archivedThroughSeq` 的行是"已归档的 server 行"——server 不再带回不代表它们被取代,
 * 只是被搬走了。故第三参 `archivedThroughSeq` 传入后,这些行**无条件保留**(④),绝不当"中段
 * server 不认识的陈旧数据"丢弃(否则 reopen 长会话整段旧历史蒸发,本次改造的主雷)。默认 0 =
 * 未归档,行为与旧版完全一致。
 *
 * **client-owned system 行(⑤)**:context_rebuilt 上下文重建提示是 role:'system' 的客户端行,
 * v5 server-authored 通道只写 assistant|thinking|tool、从不产出 system 行,故中段 system 行同
 * user/团队卡一样是"server 端根本没有的内容",一并保留(否则下次 sync 就把重建提示抹掉)。
 */
export function mergeFullServerWins(
  server: ChatMessage[],
  local: ChatMessage[],
  archivedThroughSeq = 0,
): ChatMessage[] {
  // 债A：本地富卡拥有的 run → 丢弃 server 同 run 骨架行(local-wins,保住 childBlocks)。
  server = dropServerTeamSkeletonsOwnedLocally(server, local);
  const localById = new Map<string, ChatMessage>();
  for (const m of local) if (m?.id) localById.set(m.id, m);
  const serverMerged = server.map((m) => mergeLocalClientFields(m, m?.id ? localById.get(m.id) : undefined));
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
        // ④ 已归档的 server 行(server 只回热尾巴时 _seq ≤ 水位的行不再带回):无条件保留。
        (isArchivedServerRow(m, archivedThroughSeq) ||
          // ① user 行=客户端权威;② 团队卡=client-owned(见 docstring ③),被 adopt 吸收的
          // standalone progress 行(_adoptedInto)已并入 group,不重复保留。
          m.role === "user" ||
          (isTeamOwnedRole(m.role) && !m._adoptedInto) ||
          // ⑤ client-owned system 行(context_rebuilt 重建提示):server-authored 通道从不产出。
          (m.role === "system" && !isServerAuthoredRow(m))),
    );
  if (!tail.length && !preservedMid.length) return serverChanged ? serverMerged : server;
  // 稳定排序（现代 JS Array.sort 稳定）：等 ts 时维持 server→preservedMid→tail 的插入序。
  return stableSortByTs([...serverMerged, ...preservedMid, ...tail]);
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
): ChatMessage[] {
  if (!incoming.length) return local;
  // 债A：增量带回的 server 团队骨架行,若本地富卡已拥有同 run → 丢弃(local-wins,同 full 合并)。
  incoming = dropServerTeamSkeletonsOwnedLocally(incoming, local);
  if (!incoming.length) return local;
  const byId = new Map<string, ChatMessage>();
  for (const m of incoming) if (m?.id) byId.set(m.id, m);
  const merged = local.map((m) => (m?.id && byId.has(m.id) ? mergeLocalClientFields(byId.get(m.id)!, m) : m));
  const seen = new Set<string>();
  for (const m of local) if (m?.id) seen.add(m.id);
  for (const m of incoming) if (m?.id && !seen.has(m.id)) merged.push(m);
  return stableSortByTs(merged);
}

/**
 * 归档分页并入:把云端 getSessionArchive 拉回的更早归档消息(server-authored、srv-* id、
 * `_seq` 升序)前插进本地 messages。**只前插 + 按 id 去重,绝不触发 server-wins 覆盖本地富卡**
 * (归档行 id 与本地 m-* 天然不撞;已在本地的归档 id 直接跳过,不重复插入)。合并后 stableSortByTs
 * 按 `_seq` 归位(归档行 `_seq` 低 → 落到最前)。无新增时**返回原引用**(零拷贝,免无谓重渲)。
 */
export function mergeArchivedHistory(local: ChatMessage[], archived: ChatMessage[]): ChatMessage[] {
  if (!archived.length) return local;
  const existing = new Set<string>();
  for (const m of local) if (m?.id) existing.add(m.id);
  const add = archived.filter((m) => m?.id && !existing.has(m.id));
  if (!add.length) return local;
  return stableSortByTs([...add, ...local]);
}

/** `_seq ≤ 归档水位` = server 已把该行搬进归档 chunk,full 同步只回热尾巴时不再带回它。 */
function isArchivedServerRow(m: ChatMessage, archivedThroughSeq: number): boolean {
  return (
    archivedThroughSeq > 0 &&
    typeof m._seq === "number" &&
    Number.isFinite(m._seq) &&
    m._seq <= archivedThroughSeq
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
function mergeLocalClientFields(serverMsg: ChatMessage, localMsg?: ChatMessage): ChatMessage {
  if (!localMsg || serverMsg.id !== localMsg.id) return serverMsg;
  // server echo owns the durable user row, but these client-only fields are required to
  // faithfully retry that exact turn after a later turn changes the session routing.
  if (serverMsg.role === "user" && localMsg.role === "user") {
    const localFields = {
      ...(localMsg._media !== undefined ? { _media: localMsg._media } : {}),
      ...(localMsg._modelText !== undefined ? { _modelText: localMsg._modelText } : {}),
      ...(localMsg._routing !== undefined ? { _routing: localMsg._routing } : {}),
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

function stableSortByTs(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 1) return messages;
  if (!messages.every((m) => typeof m?.ts === "number" && Number.isFinite(m.ts))) {
    return messages;
  }
  const seqOf = (m: ChatMessage): number | null =>
    typeof m._seq === "number" && Number.isFinite(m._seq) ? m._seq : null;
  return messages
    .map((m, idx) => ({ m, idx }))
    .sort((a, b) => {
      // 排序权威源 = server 单调序号 `_seq`(两行都携带时才用):纯 server 时钟域,免受客户端
      // 时钟偏移影响。修正「设备钟快于 server → user 气泡(客户端 ts,且 server 侧也按客户端
      // ts 存档)被排到本轮 server 助手行之后」的错序 —— 凡被 server echo 回、带 _seq 的行都
      // 恒按 server 顺序落位。任一行缺 _seq(本地乐观行在 echo 回来之前)→ 回退 ts(既有行为;
      // 同一域内的行仍正确,仅乐观窗内的短暂错序不可避免,echo 回后自愈)。
      const sa = seqOf(a.m);
      const sb = seqOf(b.m);
      if (sa !== null && sb !== null) return sa - sb || a.idx - b.idx;
      return a.m.ts - b.m.ts || a.idx - b.idx;
    })
    .map((x) => x.m);
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
