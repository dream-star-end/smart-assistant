import { describe, expect, test } from "vitest";
import type { ChatMessage } from "./chat/model";
import {
  applyServerIncremental,
  dbNameForUser,
  dispatchDbNameForUser,
  mergeArchivedHistory,
  mergeFullServerWins,
  mergeTimelineHistoryPage,
  reconcileTimelineBashTailAuxiliaries,
  SessionStore,
  stableSortByTs,
  type StoredPendingDispatch,
  type StoredPendingDispatchRecord,
  type StoredPendingControl,
  type StoredSession,
} from "./persist";

// ---------------------------------------------------------------------------
// P6 持久层：IndexedDB 封装（按 user 命名空间）+ 历史合并纯函数。
//
// jsdom 不实现 IndexedDB，故 SessionStore 的 round-trip 用下方最小内存 IDBFactory 桩
// 注入（resolveFactory 接受显式 factory）；merge / 命名空间为纯函数，直接单测。
// ---------------------------------------------------------------------------

function msg(id: string, text = ""): ChatMessage {
  return { id, role: "assistant", text, ts: 1 };
}

type InspectableIDBFactory = IDBFactory & {
  seedV1: (name: string, sessions: StoredSession[]) => void;
  seedV2: (
    name: string,
    sessions: StoredSession[],
    pending?: StoredPendingDispatchRecord[],
  ) => void;
  rawPut: (name: string, storeName: string, key: string, value: unknown) => void;
  versionOf: (name: string) => number | undefined;
  values: (name: string, storeName: string) => unknown[];
};

// ─── 最小内存 IDBFactory（仅覆盖 IdbKV 用到的窄 API） ────────────────────────
function fakeIDBFactory(commitGate?: Promise<void>): InspectableIDBFactory {
  type Entry = { version: number; stores: Map<string, Map<string, unknown>> };
  const dbs = new Map<string, Entry>();
  // biome-ignore lint/suspicious/noExplicitAny: 测试桩，刻意松散
  const fire = (o: any, ev: string, ...a: any[]) => {
    const h = o[`on${ev}`];
    if (typeof h === "function") h.call(o, ...a);
  };
  function makeReq<T>(exec: () => T, settled?: (error?: unknown) => void) {
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩
    const req: any = { onsuccess: null, onerror: null, result: undefined };
    queueMicrotask(() => {
      try {
        req.result = exec();
        fire(req, "success");
        queueMicrotask(() => settled?.());
      } catch (e) {
        req.error = e;
        fire(req, "error");
        queueMicrotask(() => settled?.(e));
      }
    });
    return req;
  }
  function makeStore(map: Map<string, unknown>, settled?: (error?: unknown) => void) {
    return {
      get: (k: string) => makeReq(() => map.get(k), settled),
      getAll: () => makeReq(() => [...map.values()], settled),
      put: (v: unknown, k: string) => makeReq(() => void map.set(k, v), settled),
      delete: (k: string) => makeReq(() => void map.delete(k), settled),
      clear: () => makeReq(() => void map.clear(), settled),
      openCursor: () => {
        // biome-ignore lint/suspicious/noExplicitAny: 测试桩
        const req: any = { onsuccess: null, onerror: null, result: undefined };
        const keys = [...map.keys()];
        let index = 0;
        const advance = () => {
          const key = keys[index++];
          req.result = key === undefined
            ? null
            : {
                key,
                get value() { return map.get(key); },
                update: (value: unknown) => makeReq(() => void map.set(key, value)),
                continue: () => queueMicrotask(advance),
              };
          fire(req, "success");
        };
        queueMicrotask(advance);
        return req;
      },
    };
  }
  // biome-ignore lint/suspicious/noExplicitAny: 测试桩
  const factory: any = {
    open(name: string, version?: number) {
      // biome-ignore lint/suspicious/noExplicitAny: 测试桩
      const req: any = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      const isNew = !dbs.has(name);
      if (isNew) dbs.set(name, { version: 0, stores: new Map() });
      const entry = dbs.get(name)!;
      const oldVersion = entry.version;
      const requestedVersion = version ?? (oldVersion || 1);
      const upgrading = requestedVersion > oldVersion;
      // biome-ignore lint/suspicious/noExplicitAny: 测试桩
      const db: any = {
        get version() { return entry.version; },
        objectStoreNames: { contains: (n: string) => entry.stores.has(n) },
        createObjectStore: (n: string) => {
          entry.stores.set(n, new Map());
          return makeStore(entry.stores.get(n)!);
        },
        transaction: () => {
          // biome-ignore lint/suspicious/noExplicitAny: 测试桩
          const tx: any = { oncomplete: null, onabort: null, onerror: null, error: null };
          let finished = false;
          const settle = (error?: unknown) => {
            if (finished) return;
            finished = true;
            if (error) {
              tx.error = error;
              fire(tx, "error");
              fire(tx, "abort");
              return;
            }
            const complete = () => fire(tx, "complete");
            if (commitGate) void commitGate.then(complete);
            else queueMicrotask(complete);
          };
          tx.objectStore = (sn: string) => makeStore(entry.stores.get(sn)!, settle);
          return tx;
        },
        close: () => {},
      };
      req.result = db;
      queueMicrotask(() => {
        if (version !== undefined && version < oldVersion) {
          req.error = new Error("VersionError");
          fire(req, "error");
          return;
        }
        if (upgrading) {
          req.transaction = db.transaction();
          fire(req, "upgradeneeded", { oldVersion });
          entry.version = requestedVersion;
          setTimeout(() => fire(req, "success"), 0);
          return;
        }
        fire(req, "success");
      });
      return req;
    },
    seedV1(name: string, sessions: StoredSession[]) {
      const store = new Map<string, unknown>();
      for (const session of sessions) store.set(session.id, session);
      dbs.set(name, {
        version: 1,
        stores: new Map([["sessions", store]]),
      });
    },
    seedV2(
      name: string,
      sessions: StoredSession[],
      pending: StoredPendingDispatchRecord[] = [],
    ) {
      const sessionStore = new Map<string, unknown>();
      const pendingStore = new Map<string, unknown>();
      for (const session of sessions) sessionStore.set(session.id, session);
      for (const item of pending) {
        pendingStore.set(`${item.sessId}\0${item.msgId}`, item);
      }
      dbs.set(name, {
        version: 2,
        stores: new Map([
          ["sessions", sessionStore],
          ["pending_dispatches", pendingStore],
        ]),
      });
    },
    rawPut(name: string, storeName: string, key: string, value: unknown) {
      const entry = dbs.get(name);
      if (!entry) throw new Error(`missing db ${name}`);
      const store = entry.stores.get(storeName);
      if (!store) throw new Error(`missing store ${storeName}`);
      store.set(key, value);
    },
    versionOf(name: string) {
      return dbs.get(name)?.version;
    },
    values(name: string, storeName: string) {
      return [...(dbs.get(name)?.stores.get(storeName)?.values() ?? [])];
    },
  };
  return factory as InspectableIDBFactory;
}

function stored(id: string, over: Partial<StoredSession> = {}): StoredSession {
  return {
    id,
    agentId: "main",
    title: id,
    messages: [],
    createdAt: 1,
    lastAt: 1,
    ...over,
  };
}

describe("persist — 历史合并纯函数", () => {
  test("_orderSeq 是全序主轴：patch 后高 _seq 不移位，缺 ts 也不整趟放弃排序", () => {
    const server = [
      { id: "u2", role: "user", text: "two", ts: 300, _seq: 5, _orderSeq: 3 },
      { id: "a1", role: "assistant", text: "patched", _seq: 13, _orderSeq: 2, _source: "server" },
      { id: "u1", role: "user", text: "one", ts: 100, _seq: 5, _orderSeq: 1 },
    ] as ChatMessage[];

    const out = mergeFullServerWins(server, []);
    expect(out.map((row) => row.id)).toEqual(["u1", "a1", "u2"]);
  });

  test("full merge 保留中段 user 的原始锚点，不把它漂到后一条 server 行之后", () => {
    const a1 = { id: "a1", role: "assistant", text: "one", ts: 1, _source: "server", _orderSeq: 1 } as ChatMessage;
    const user = { id: "local-user", role: "user", text: "问", ts: 999 } as ChatMessage;
    const a2 = { id: "a2", role: "assistant", text: "two", ts: 2, _source: "server", _orderSeq: 2 } as ChatMessage;

    const out = mergeFullServerWins([a1, a2], [a1, user, a2]);

    expect(out.map((row) => row.id)).toEqual(["a1", "local-user", "a2"]);
    expect(user._orderSeq).toBeUndefined(); // 临时锚只参与本次排序，不伪造持久顺序轴。
  });

  test("exact terminal evidence replaces only that turn's m-* fallback, not a queued next turn", () => {
    const local: ChatMessage[] = [
      { id: "m-user-1", role: "user", text: "u1", ts: 1 },
      { id: "m-local-a1", role: "assistant", text: "fallback u1", ts: 2, _clientMessageId: "m-user-1" },
      { id: "m-user-2", role: "user", text: "u2 queued", ts: 3, status: "queued" },
      { id: "m-local-a2", role: "assistant", text: "fallback u2", ts: 4, _clientMessageId: "m-user-2" },
    ];
    const server: ChatMessage[] = [
      { id: "m-user-1", role: "user", text: "u1", ts: 1 },
      { id: "srv-u1", role: "assistant", text: "canonical u1", ts: 2, _source: "server", _clientMessageId: "m-user-1" },
      { id: "m-user-2", role: "user", text: "u2 queued", ts: 3, status: "queued" },
    ];
    const merged = mergeFullServerWins(server, local, 0, "m-user-1");
    expect(merged.some((m) => m.id === "m-local-a1")).toBe(false);
    expect(merged.some((m) => m.id === "srv-u1")).toBe(true);
    expect(merged.some((m) => m.id === "m-local-a2")).toBe(true);
  });

  test("another turn's server output is not completion evidence for the requested turn", () => {
    const local: ChatMessage[] = [
      { id: "m-user-1", role: "user", text: "u1", ts: 1 },
      { id: "m-local-a1", role: "assistant", text: "fallback u1", ts: 2, _clientMessageId: "m-user-1" },
    ];
    const server: ChatMessage[] = [
      { id: "m-user-1", role: "user", text: "u1", ts: 1 },
      { id: "srv-u2", role: "assistant", text: "canonical u2", ts: 3, _source: "server", _clientMessageId: "m-user-2" },
    ];
    const merged = mergeFullServerWins(server, local, 0, "m-user-1");
    expect(merged.some((m) => m.id === "m-local-a1")).toBe(true);
  });

  test("user-only history does not erase a streaming fallback before terminal tape exists", () => {
    const local: ChatMessage[] = [
      { id: "m-user-1", role: "user", text: "u1", ts: 1 },
      { id: "m-local-a1", role: "assistant", text: "still streaming", ts: 2, _clientMessageId: "m-user-1" },
    ];
    const server = [{ id: "m-user-1", role: "user", text: "u1", ts: 1 } satisfies ChatMessage];
    const merged = mergeFullServerWins(server, local, 0, "m-user-1");
    expect(merged.some((m) => m.id === "m-local-a1")).toBe(true);
  });

  // C2:采用引擎 messageId(srv- 前缀)的本地 live 行 —— 无 _source,turn finalize 后 server 把该轮
  // 展开成 `srv-…-tN-s{idx}` 分段行(id 不同,server-wins 按 id 漏)。完成证据去重必须按权威源
  // `_source !== 'server'` 清掉它,而不能按 `isServerAuthoredRow`(srv- 前缀兜底会把 live 行误判成
  // server-authored → 漏删 → 与 server 分段副本并存重复渲染)。
  test("finalize full 同步:采用引擎 messageId 的本地行被 srv-* 分段副本替换,不再双份", () => {
    const local: ChatMessage[] = [
      { id: "m-user-1", role: "user", text: "u1", ts: 1 },
      // v7 live 行直接采用引擎 messageId(srv- 前缀但本地铸,无 _source),已被 addMessage 盖 _clientMessageId。
      { id: "srv-peer-main-t1", role: "assistant", text: "答", ts: 2, _clientMessageId: "m-user-1" },
    ];
    const server: ChatMessage[] = [
      { id: "m-user-1", role: "user", text: "u1", ts: 1 },
      // finalize 后 server 把该轮展开成分段行(id 带 -s0 后缀,与 live 行不同)。
      { id: "srv-peer-main-t1-s0", role: "assistant", text: "答", ts: 2, _source: "server", _clientMessageId: "m-user-1" },
    ];
    const merged = mergeFullServerWins(server, local, 0, "m-user-1");
    const assistants = merged.filter((m) => m.role === "assistant");
    expect(assistants.map((m) => m.id)).toEqual(["srv-peer-main-t1-s0"]); // 只剩 server 分段行
    expect(merged.some((m) => m.id === "srv-peer-main-t1")).toBe(false); // live 引擎行被清
  });

  test("无完成证据(server 未回该轮 server 行)时引擎 messageId 本地行保留(落库失败降级不误删)", () => {
    const local: ChatMessage[] = [
      { id: "m-user-1", role: "user", text: "u1", ts: 1 },
      { id: "srv-peer-main-t1", role: "assistant", text: "答", ts: 2, _clientMessageId: "m-user-1" },
    ];
    // server 只回 user 行(该轮 tape 尚未落库)→ 无完成证据 → 本地生成行必须保留。
    const server: ChatMessage[] = [{ id: "m-user-1", role: "user", text: "u1", ts: 1 }];
    const merged = mergeFullServerWins(server, local, 0, "m-user-1");
    expect(merged.some((m) => m.id === "srv-peer-main-t1")).toBe(true);
  });

  test("user / agent-group 行永不因 _clientMessageId 命中被删(角色白名单收口)", () => {
    const local: ChatMessage[] = [
      { id: "m-user-1", role: "user", text: "u1", ts: 1, _clientMessageId: "m-user-1" },
      { id: "m-group-1", role: "agent-group", text: "团队", ts: 2, _clientMessageId: "m-user-1", _delegateRunId: "run-1" },
      { id: "srv-peer-main-t1", role: "assistant", text: "答", ts: 3, _clientMessageId: "m-user-1" },
    ];
    const server: ChatMessage[] = [
      { id: "srv-peer-main-t1-s0", role: "assistant", text: "答", ts: 3, _source: "server", _clientMessageId: "m-user-1" },
    ];
    const merged = mergeFullServerWins(server, local, 0, "m-user-1");
    expect(merged.some((m) => m.id === "m-user-1")).toBe(true); // user 保留
    expect(merged.some((m) => m.id === "m-group-1")).toBe(true); // agent-group 保留
    expect(merged.some((m) => m.id === "srv-peer-main-t1")).toBe(false); // 生成行被清
  });

  test("mergeFullServerWins: server 权威 + 保留末尾乐观尾（server 不认识）", () => {
    const server = [msg("a", "S-a"), msg("b", "S-b")];
    // a 重叠（取 server），末尾 c 是本地乐观尾（server 还没持久化）→ 保留。
    const local = [msg("a", "L-a"), msg("c", "L-c")];
    const merged = mergeFullServerWins(server, local);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(merged.find((m) => m.id === "a")!.text).toBe("S-a"); // server-wins
    expect(merged.find((m) => m.id === "c")!.text).toBe("L-c"); // 乐观尾保留
  });

  test("waived=true 在 full/incremental 同 id 合并中不可逆，其余字段仍 server-wins", () => {
    const localWaived: ChatMessage = {
      id: "srv-waived",
      role: "assistant",
      text: "local",
      ts: 1,
      usage: { costCredits: "259", waived: true },
    };
    const serverBeforeWaiver: ChatMessage = {
      id: "srv-waived",
      role: "assistant",
      text: "server-full",
      ts: 1,
      usage: { costCredits: "300" },
    };
    const full = mergeFullServerWins([serverBeforeWaiver], [localWaived]);
    expect(full[0].text).toBe("server-full");
    expect(full[0].usage).toEqual({ costCredits: "300", waived: true });

    const incremental = applyServerIncremental(
      [localWaived],
      [{ ...serverBeforeWaiver, text: "server-incremental", usage: { costCredits: "301", waived: false } }],
    );
    expect(incremental[0].text).toBe("server-incremental");
    expect(incremental[0].usage).toEqual({ costCredits: "301", waived: true });

    const serverUpgrade = applyServerIncremental(
      [{ ...localWaived, usage: { costCredits: "259", waived: false } }],
      [{ ...serverBeforeWaiver, usage: { costCredits: "259", waived: true } }],
    );
    expect(serverUpgrade[0].usage?.waived).toBe(true);
  });

  test("mergeFullServerWins: 丢弃历史中段的 local-only 陈旧消息（不在尾部）", () => {
    const server = [msg("a", "S-a"), msg("b", "S-b")];
    // stale 在中段（其后还有 server 认识的 b）→ 视为陈旧丢弃；末尾无本地独有 → 纯 server。
    const local = [msg("a"), msg("stale", "脏数据"), msg("b")];
    const merged = mergeFullServerWins(server, local);
    expect(merged.map((m) => m.id)).toEqual(["a", "b"]); // stale 被丢弃
    expect(merged).toBe(server); // 无乐观尾 → 返回 server 引用
  });

  test("mergeFullServerWins: 无本地乐观尾时返回原 server 引用（零拷贝）", () => {
    const server = [msg("a"), msg("b")];
    expect(mergeFullServerWins(server, [msg("a")])).toBe(server);
  });

  test("mergeFullServerWins: 保留中段本地独有的 user 气泡（server 无用户消息，按 ts 归位）", () => {
    const u = (id: string, text: string, ts: number): ChatMessage => ({ id, role: "user", text, ts });
    const a = (id: string, text: string, ts: number): ChatMessage => ({ id, role: "assistant", text, ts });
    // server 只含 server-authored 助手（v5 不把用户消息 PUT 上去）；本地有用户气泡(ts1)在助手(ts2)前。
    const server = [a("srv1", "S-答", 2)];
    const local = [u("usr1", "你好", 1), a("srv1", "L-答", 2)];
    const merged = mergeFullServerWins(server, local);
    expect(merged.map((m) => m.id)).toEqual(["usr1", "srv1"]); // 用户气泡保留 + ts 落到助手之前
    expect(merged.find((m) => m.id === "usr1")!.role).toBe("user");
    expect(merged.find((m) => m.id === "srv1")!.text).toBe("S-答"); // 重叠仍 server-wins
  });

  test("mergeFullServerWins: 中段本地独有的 assistant（非 user）仍丢弃（防 srv-* 重复卡）", () => {
    const a = (id: string, text: string, ts: number): ChatMessage => ({ id, role: "assistant", text, ts });
    const server = [a("x", "S-x", 1), a("y", "S-y", 3)];
    const local = [a("x", "", 1), a("ghost", "乐观助手", 2), a("y", "", 3)];
    const merged = mergeFullServerWins(server, local);
    expect(merged.map((m) => m.id)).toEqual(["x", "y"]); // ghost(assistant 中段)被丢
  });

  test("applyServerIncremental: 按 id 覆盖既有 + 追加新增，保持本地顺序", () => {
    const local = [msg("a", "L-a"), msg("b", "L-b")];
    const incoming = [msg("b", "S-b"), msg("c", "S-c")];
    const merged = applyServerIncremental(local, incoming);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(merged.find((m) => m.id === "b")!.text).toBe("S-b"); // 覆盖
    expect(merged[0].text).toBe("L-a"); // 顺序保持
  });

  // C2 同型逻辑:增量合并也按 `_source !== 'server'` 清掉采用引擎 messageId 的本地 live 行。
  test("applyServerIncremental: 完成证据下清掉引擎 messageId 本地行,只留 server 分段行", () => {
    const local: ChatMessage[] = [
      { id: "srv-peer-main-t1", role: "assistant", text: "答", ts: 2, _clientMessageId: "m-user-1" },
    ];
    const incoming: ChatMessage[] = [
      { id: "srv-peer-main-t1-s0", role: "assistant", text: "答", ts: 2, _source: "server", _clientMessageId: "m-user-1" },
    ];
    const merged = applyServerIncremental(local, incoming, "m-user-1");
    expect(merged.map((m) => m.id)).toEqual(["srv-peer-main-t1-s0"]);
  });

  test("user server echo preserves the original message-level retry routing", () => {
    const local = [
      {
        id: "u1",
        role: "user",
        text: "local",
        ts: 1,
        _routing: { model: "gpt-5.6-terra", effortLevel: "max", teamMode: true },
      } satisfies ChatMessage,
    ];
    const incoming = [
      { id: "u1", role: "user", text: "server", ts: 1, _source: "server" } satisfies ChatMessage,
    ];

    const [merged] = applyServerIncremental(local, incoming);

    expect(merged.text).toBe("server");
    expect(merged._routing).toEqual({
      model: "gpt-5.6-terra",
      effortLevel: "max",
      teamMode: true,
    });
  });

  test("user server echo 单调保留恢复血缘，不覆盖 server 真值", () => {
    const local = [
      {
        id: "u-recovery",
        role: "user",
        text: "local",
        ts: 1,
        _recoveryOfClientMessageId: "u-source",
        _recoveryMode: "checkpoint",
        _automaticRecovery: false,
      } satisfies ChatMessage,
    ];
    const incoming = [
      { id: "u-recovery", role: "user", text: "server", ts: 1, _source: "server" } satisfies ChatMessage,
    ];

    const [merged] = applyServerIncremental(local, incoming);

    expect(merged.text).toBe("server");
    expect(merged._recoveryOfClientMessageId).toBe("u-source");
    expect(merged._recoveryMode).toBe("checkpoint");
    expect(merged._automaticRecovery).toBe(false);

    const [serverWins] = applyServerIncremental(
      local,
      [{
        id: "u-recovery",
        role: "user",
        text: "server-lineage",
        ts: 1,
        _source: "server",
        _recoveryOfClientMessageId: "u-server-source",
        _recoveryMode: "replay",
        _automaticRecovery: true,
      } satisfies ChatMessage],
    );
    expect(serverWins._recoveryOfClientMessageId).toBe("u-server-source");
    expect(serverWins._recoveryMode).toBe("replay");
    expect(serverWins._automaticRecovery).toBe(true);
  });

  test("applyServerIncremental: 空增量返回原数组引用", () => {
    const local = [msg("a")];
    expect(applyServerIncremental(local, [])).toBe(local);
  });

  test("incremental exact completion evidence removes only that turn's local fallback", () => {
    const local: ChatMessage[] = [
      { id: "m-a1", role: "assistant", text: "fallback", ts: 1, _clientMessageId: "m-user-1" },
      { id: "m-a2", role: "assistant", text: "queued", ts: 2, _clientMessageId: "m-user-2" },
    ];
    const incoming: ChatMessage[] = [{
      id: "srv-a1",
      role: "assistant",
      text: "canonical",
      ts: 1,
      _source: "server",
      _clientMessageId: "m-user-1",
    }];
    const merged = applyServerIncremental(local, incoming, "m-user-1");
    expect(merged.some((m) => m.id === "m-a1")).toBe(false);
    expect(merged.some((m) => m.id === "srv-a1")).toBe(true);
    expect(merged.some((m) => m.id === "m-a2")).toBe(true);
  });

  test("mergeFullServerWins: stripped server team rows do not wipe rich local agent cards", () => {
    const localGroup: ChatMessage = {
      id: "g1",
      role: "agent-group",
      text: "审查草稿",
      ts: 10,
      toolName: "delegate_task",
      blockId: "call-1",
      _delegate: true,
      _delegateAgentId: "hidden-reviewer",
      _delegateGoal: "审查草稿",
      _delegateRunId: "run-1",
      _completed: true,
      _resultPreview: "PASS",
      childBlocks: [{ kind: "text", text: "审查结果正文" }],
    };
    const serverGroup: ChatMessage = {
      id: "g1",
      role: "agent-group",
      text: "审查草稿",
      ts: 10,
      toolName: "delegate_task",
      blockId: "call-1",
    };

    const merged = mergeFullServerWins([serverGroup], [localGroup]);
    const group = merged[0];
    expect(group._completed).toBe(true);
    expect(group._delegateAgentId).toBe("hidden-reviewer");
    expect(group._delegateGoal).toBe("审查草稿");
    expect(group._resultPreview).toBe("PASS");
    expect(group.childBlocks?.map((b) => b.text)).toEqual(["审查结果正文"]);
  });

  test("mergeFullServerWins: stripped server agent rows keep Codex fallback display markers", () => {
    const localGroup: ChatMessage = {
      id: "g-codex",
      role: "agent-group",
      text: "并行检查仓库",
      ts: 10,
      toolName: "Agent",
      blockId: "spawn-1",
      _agentGroupOrigin: "codex-collab",
      _teamFallback: true,
      _completed: true,
      childBlocks: [{ kind: "text", text: "检查完成" }],
    };
    const serverGroup: ChatMessage = {
      id: "g-codex",
      role: "agent-group",
      text: "并行检查仓库",
      ts: 10,
      toolName: "Agent",
      blockId: "spawn-1",
    };

    const merged = mergeFullServerWins([serverGroup], [localGroup]);
    const group = merged[0];
    expect(group._agentGroupOrigin).toBe("codex-collab");
    expect(group._teamFallback).toBe(true);
    expect(group.childBlocks?.map((b) => b.text)).toEqual(["检查完成"]);
  });

  test("applyServerIncremental: stripped delegate-progress keeps local entries and summary", () => {
    const localProgress: ChatMessage = {
      id: "dp1",
      role: "delegate-progress",
      text: "",
      ts: 20,
      runId: "run-1",
      agentId: "hidden-reviewer",
      goal: "审查草稿",
      _completed: true,
      entries: [{ phase: "text", text: "正在审查", ts: 21 }],
      summary: "PASS",
    };
    const incomingProgress: ChatMessage = {
      id: "dp1",
      role: "delegate-progress",
      text: "",
      ts: 20,
      agentId: "hidden-reviewer",
    };

    const merged = applyServerIncremental([localProgress], [incomingProgress]);
    expect(merged[0].runId).toBe("run-1");
    expect(merged[0]._completed).toBe(true);
    expect(merged[0].entries?.map((e) => e.text)).toEqual(["正在审查"]);
    expect(merged[0].summary).toBe("PASS");
  });

  test("applyServerIncremental: late server rows interleave by ts after multiple local continues", () => {
    const u = (id: string, ts: number): ChatMessage => ({ id, role: "user", text: "继续", ts });
    const a = (id: string, text: string, ts: number): ChatMessage => ({ id, role: "assistant", text, ts });
    const local = [a("old", "上一段", 100), u("u1", 200), u("u2", 400)];
    const incoming = [a("mid", "继续后的内容", 300), a("tail", "后续内容", 500)];

    const merged = applyServerIncremental(local, incoming);
    expect(merged.map((m) => m.id)).toEqual(["old", "u1", "mid", "u2", "tail"]);
  });

  test("applyServerIncremental: invalid ts uses 0 tie-breaker without abandoning the whole sort", () => {
    const local = [msg("a", "L-a"), { ...msg("b", "L-b"), ts: Number.NaN }];
    const incoming = [{ ...msg("c", "S-c"), ts: 0 }];
    const merged = applyServerIncremental(local, incoming);
    expect(merged.map((m) => m.id)).toEqual(["b", "c", "a"]);
  });

  test("applyServerIncremental: _orderSeq 冻结顺序优先于 ts/_seq,消客户端时钟偏移错序", () => {
    // 设备钟快 → user 气泡(server 侧也按客户端 ts 存档,ts=9000)大于本轮助手 server ts(1001),
    // 但两行都被 server echo 回、带单调 _seq(user=10 在前、助手=11 在后)。按 _seq 应回 user→助手;
    // 旧的纯 ts 排序会因 9000 > 1001 把 user 气泡错排到答案之后。
    const local = [
      { id: "srv-u", role: "user", text: "问", ts: 9000, _source: "server", _seq: 99, _orderSeq: 10 } as ChatMessage,
    ];
    const incoming = [
      { id: "srv-a", role: "assistant", text: "答", ts: 1001, _source: "server", _seq: 11, _orderSeq: 11 } as ChatMessage,
    ];
    const merged = applyServerIncremental(local, incoming);
    expect(merged.map((m) => m.id)).toEqual(["srv-u", "srv-a"]);
  });

  test("applyServerIncremental: 任一行缺 _seq(本地乐观行)→ 回退 ts 排序(既有行为保留)", () => {
    // 本地 user 气泡尚未 echo(无 _seq);incoming 助手带 _seq。混合对回退 ts,ts 100 < 200。
    const local = [{ id: "u-local", role: "user", text: "问", ts: 100 } as ChatMessage];
    const incoming = [
      { id: "srv-a", role: "assistant", text: "答", ts: 200, _source: "server", _seq: 5 } as ChatMessage,
    ];
    const merged = applyServerIncremental(local, incoming);
    expect(merged.map((m) => m.id)).toEqual(["u-local", "srv-a"]);
  });

  // v5 真实 reopen 场景:server-authored 历史带冻结 _orderSeq,团队卡是 client-owned。
  // 团队轮之后又有新一轮 → 团队卡落在「最后一个 server 已知 id」之前(中段),必须既保留
  // 又留在 final 前。旧测试没给 server fixture 加 _orderSeq,漏掉 durable order axis 上线后的回归。
  test("mergeFullServerWins: 保留中段 local-only 团队卡且不漂到 final 后", () => {
    const server = [
      { ...msg("srv-1", "本轮用户输入"), role: "user" as const, ts: 100, _orderSeq: 1 },
      { ...msg("srv-2", "本轮最终答案"), ts: 500, _orderSeq: 2, _source: "server" as const },
    ];
    const group: ChatMessage = {
      id: "m-group",
      role: "agent-group",
      text: "委托研究",
      ts: 200,
      _delegate: true,
      _delegateRunId: "run-9",
      _completed: true,
      childBlocks: [{ kind: "text", text: "子代理产出" }],
    };
    const progress: ChatMessage = {
      id: "m-prog",
      role: "delegate-progress",
      text: "",
      ts: 300,
      runId: "run-8",
      agentId: "coder",
      _completed: true,
      entries: [{ phase: "text", text: "进行中", ts: 301 }],
    };
    const permission: ChatMessage = {
      id: "m-permission",
      role: "permission",
      text: "AskUserQuestion",
      ts: 400,
      requestId: "req-1",
      _resolved: true,
      _behavior: "deny",
      _settledReason: "disconnect",
    };
    // 中段还有一条非团队的 local-only assistant → 仍按旧语义丢弃(可能已被 srv-* 重写)。
    const staleAssistant = { ...msg("m-stale", "被取代的乐观助手行"), ts: 250 };
    const local = [server[0], group, staleAssistant, progress, permission, server[1]];

    const merged = mergeFullServerWins(server, local);
    expect(merged.map((m) => m.id)).toEqual(["srv-1", "m-group", "m-prog", "m-permission", "srv-2"]);
    expect(merged.find((m) => m.id === "m-group")!.childBlocks?.length).toBe(1);
  });

  test("mergeFullServerWins: reconnect full 新增 final 后过程卡仍在 final 前且重复合并幂等", () => {
    const user: ChatMessage = {
      id: "srv-user",
      role: "user",
      text: "做一个异星探索游戏",
      ts: 100,
      _orderSeq: 1,
      _source: "server",
    };
    const final: ChatMessage = {
      id: "srv-final",
      role: "assistant",
      text: "最终方案",
      ts: 500,
      _orderSeq: 2,
      _source: "server",
    };
    const group: ChatMessage = {
      id: "m-group",
      role: "agent-group",
      text: "并行研究",
      ts: 200,
      _delegateRunId: "run-1",
      _completed: true,
      childBlocks: [{ kind: "text", text: "研究完成" }],
    };
    const permission: ChatMessage = {
      id: "m-permission",
      role: "permission",
      text: "AskUserQuestion",
      ts: 300,
      requestId: "req-1",
      _resolved: true,
      _behavior: "deny",
      _settledReason: "disconnect",
    };

    // reconnect 前 local 尚无 final；full sync 把 final 首次带回。
    const once = mergeFullServerWins([user, final], [user, group, permission]);
    expect(once.map((m) => m.id)).toEqual(["srv-user", "m-group", "m-permission", "srv-final"]);
    const twice = mergeFullServerWins([user, final], once);
    expect(twice.map((m) => m.id)).toEqual(once.map((m) => m.id));
  });

  test("mergeFullServerWins: 已污染缓存 final 在前时也能自愈并保持重复 full 幂等", () => {
    const user: ChatMessage = {
      id: "u-poison",
      role: "user",
      text: "继续排查",
      ts: 100,
      _orderSeq: 1,
      _source: "server",
    };
    const final: ChatMessage = {
      id: "a-poison",
      role: "assistant",
      text: "排查完成",
      ts: 500,
      _orderSeq: 2,
      _source: "server",
      _clientMessageId: user.id,
    };
    const group: ChatMessage = {
      id: "g-poison",
      role: "agent-group",
      text: "团队协作",
      ts: 200,
    };
    const permission: ChatMessage = {
      id: "p-poison",
      role: "permission",
      text: "AskUserQuestion",
      ts: 300,
      requestId: "req-poison",
      _resolved: true,
    };

    const once = mergeFullServerWins([user, final], [user, final, group, permission]);
    expect(once.map((message) => message.id)).toEqual([
      "u-poison",
      "g-poison",
      "p-poison",
      "a-poison",
    ]);
    expect(once.find((message) => message.id === "g-poison")?._turnOwnerId).toBe(user.id);
    expect(once.find((message) => message.id === "p-poison")?._turnOwnerId).toBe(user.id);
    const twice = mergeFullServerWins([user, final], once);
    expect(twice.map((message) => message.id)).toEqual(once.map((message) => message.id));
  });

  test("applyServerIncremental: empty ?since response repairs poison and then stays zero-copy", () => {
    const poisoned: ChatMessage[] = [
      { id: "u1", role: "user", text: "问", ts: 1, _orderSeq: 1, _source: "server" },
      {
        id: "a1",
        role: "assistant",
        text: "答",
        ts: 4,
        _orderSeq: 2,
        _source: "server",
        _clientMessageId: "u1",
      },
      { id: "g1", role: "agent-group", text: "团队协作", ts: 2 },
      { id: "p1", role: "permission", text: "用户问答", ts: 3, requestId: "req-1" },
    ];

    const repaired = applyServerIncremental(poisoned, []);
    expect(repaired.map((message) => message.id)).toEqual(["u1", "g1", "p1", "a1"]);
    expect(repaired).not.toBe(poisoned);
    expect(applyServerIncremental(repaired, [])).toBe(repaired);
  });

  test("mergeFullServerWins: 所有 local-only 行剥离伪造 _orderSeq,只有 server 可进入 durable axis", () => {
    const server: ChatMessage[] = [
      { id: "srv-1", role: "user", text: "一", ts: 100, _orderSeq: 1, _source: "server" },
      { id: "srv-2", role: "assistant", text: "二", ts: 200, _orderSeq: 2, _source: "server" },
      { id: "srv-3", role: "assistant", text: "三", ts: 300, _orderSeq: 3, _source: "server" },
    ];
    const local: ChatMessage[] = [
      // 同 id local 伪造值不能覆盖 server 的 1。
      { ...server[0], _orderSeq: 999 },
      { id: "m-user", role: "user", text: "local user", ts: 110, _orderSeq: 999 },
      { id: "m-team", role: "agent-group", text: "team", ts: 120, _delegateRunId: "run-x", _orderSeq: 1 },
      { id: "m-permission", role: "permission", text: "ask", ts: 130, requestId: "req-x", _orderSeq: 999 },
      server[1],
      // 最大 local-only 连续尾也不能携伪造排序轴。
      { id: "m-tail", role: "assistant", text: "optimistic tail", ts: 250, _orderSeq: 1 },
    ];

    const merged = mergeFullServerWins(server, local);
    expect(merged.map((m) => m.id)).toEqual([
      "srv-1",
      "m-user",
      "m-team",
      "m-permission",
      "srv-2",
      "m-tail",
      "srv-3",
    ]);
    expect(merged.filter((m) => m.id.startsWith("m-")).every((m) => m._orderSeq === undefined)).toBe(true);
    expect(merged.filter((m) => m.id.startsWith("srv-")).map((m) => m._orderSeq)).toEqual([1, 2, 3]);
  });

  test("mergeFullServerWins: 被 adopt 吸收的 standalone progress(_adoptedInto)不重复保留", () => {
    const server = [{ ...msg("srv-1", "答案"), ts: 100 }, { ...msg("srv-2", "尾"), ts: 500 }];
    const adopted: ChatMessage = {
      id: "m-adopted",
      role: "delegate-progress",
      text: "",
      ts: 200,
      runId: "run-1",
      _adoptedInto: "m-group",
    };
    const merged = mergeFullServerWins(server, [server[0], adopted, server[1]]);
    expect(merged.map((m) => m.id)).toEqual(["srv-1", "srv-2"]);
  });

  // 本地把 delegate 工具行原位转成 agent-group(同 id),server 同 id 仍是 tool 行:
  // 富卡为底,从 server 行回填完成态/结果预览,不被打回裸工具行。
  test("mergeFullServerWins: 同 id server tool 行 vs 本地 agent-group 富卡 → 富卡保留并回填完成态", () => {
    const serverTool: ChatMessage = {
      id: "srv-tool-1",
      role: "tool",
      text: "",
      ts: 100,
      toolName: "mcp__openclaude-memory__delegate_task",
      output: JSON.stringify({
        server: "openclaude-memory",
        tool: "delegate_task",
        result: { content: [{ text: "审查通过:PASS" }] },
      }),
      _completed: true,
    };
    const localGroup: ChatMessage = {
      id: "srv-tool-1",
      role: "agent-group",
      text: "审查草稿",
      ts: 100,
      _delegate: true,
      _delegateAgentId: "hidden-reviewer",
      childBlocks: [{ kind: "text", text: "审查过程输出" }],
    };
    const merged = mergeFullServerWins([serverTool], [localGroup]);
    const row = merged[0];
    expect(row.role).toBe("agent-group");
    expect(row.childBlocks?.map((b) => b.text)).toEqual(["审查过程输出"]);
    expect(row._completed).toBe(true); // 从 server 行回填
    expect(row._resultPreview).toBe("审查通过:PASS"); // friendlyDelegateResultPreview 语义
  });

  // ── 债A：server-authored 团队骨架行 按 runId 去重 ───────────────────────────
  // server 现会带回 agent-group 骨架行(id srv-*、_source:'server'、无 childBlocks 过程树)。
  // 去重维度是 runId(骨架 id 与本地富卡 id 天然不同,碰不到 id 维度 server-wins 覆盖)。
  test("mergeFullServerWins(债A): server 骨架与本地富卡同 runId → local-wins,骨架被丢、childBlocks 不被吞(2c73030d 回归)", () => {
    const localRich: ChatMessage = {
      id: "m-group",
      role: "agent-group",
      text: "研究任务",
      ts: 200,
      _delegate: true,
      _delegateAgentId: "coder",
      _delegateGoal: "研究任务",
      _delegateRunId: "run-1",
      _completed: true,
      _resultPreview: "本地富卡结果",
      childBlocks: [{ kind: "text", text: "子代理过程输出" }],
    };
    const serverSkeleton: ChatMessage = {
      id: "srv-group-1",
      role: "agent-group",
      text: "研究任务",
      ts: 210,
      _source: "server",
      _delegate: true,
      _delegateAgentId: "coder",
      _delegateGoal: "研究任务",
      _delegateRunId: "run-1",
      _completed: true,
      _delegateStatus: "ok",
      _resultPreview: "server 骨架摘要",
    };
    const final = { ...msg("srv-final", "最终答复"), ts: 300, _orderSeq: 3, _source: "server" as const };
    const server = [
      { ...msg("srv-a", "用户输入"), role: "user" as const, ts: 100, _orderSeq: 1 },
      { ...serverSkeleton, _orderSeq: 2 },
      final,
    ];
    const local = [{ ...server[0] }, localRich, final];
    const merged = mergeFullServerWins(server, local);
    // 骨架行(srv-group-1)被丢弃,本地富卡(m-group)保留
    expect(merged.map((m) => m.id)).toEqual(["srv-a", "m-group", "srv-final"]);
    const g = merged.find((m) => m.id === "m-group")!;
    // 2c73030d:server 行绝不吞本地富卡的 childBlocks / 展示字段
    expect(g.childBlocks?.map((b) => b.text)).toEqual(["子代理过程输出"]);
    expect(g._resultPreview).toBe("本地富卡结果");
  });

  test("mergeFullServerWins(债A): 跨设备(本地无此团队 run)→ 采用 server 骨架行渲染", () => {
    const serverSkeleton: ChatMessage = {
      id: "srv-g1",
      role: "agent-group",
      text: "跨设备研究",
      ts: 100,
      _source: "server",
      _delegate: true,
      _delegateAgentId: "coder",
      _delegateGoal: "跨设备研究",
      _delegateRunId: "run-x",
      _completed: true,
      _delegateStatus: "ok",
      _resultPreview: "跨设备摘要",
    };
    const server = [serverSkeleton];
    const merged = mergeFullServerWins(server, []); // 本地缺席
    expect(merged.map((m) => m.id)).toEqual(["srv-g1"]);
    expect(merged[0]._delegateRunId).toBe("run-x");
    expect(merged).toBe(server); // 无剔除 + 无乐观尾 → 零拷贝返回原引用
  });

  test("applyServerIncremental(债A): 增量 server 骨架与本地富卡同 runId → 丢弃骨架,富卡保留", () => {
    const localRich: ChatMessage = {
      id: "m-g",
      role: "agent-group",
      text: "x",
      ts: 10,
      _delegate: true,
      _delegateRunId: "run-2",
      _completed: true,
      childBlocks: [{ kind: "text", text: "富卡过程" }],
    };
    const incoming: ChatMessage = {
      id: "srv-g",
      role: "agent-group",
      text: "x",
      ts: 12,
      _source: "server",
      _delegateRunId: "run-2",
      _completed: true,
      _delegateStatus: "ok",
    };
    const merged = applyServerIncremental([localRich], [incoming]);
    expect(merged.map((m) => m.id)).toEqual(["m-g"]); // 骨架不追加
    expect(merged[0].childBlocks?.length).toBe(1);
  });

  test("applyServerIncremental(债A): 跨设备 server 骨架(本地无同 run)→ 追加渲染", () => {
    const localRich: ChatMessage = {
      id: "m-g",
      role: "agent-group",
      text: "已有",
      ts: 10,
      _delegate: true,
      _delegateRunId: "run-a",
      _completed: true,
    };
    const incoming: ChatMessage = {
      id: "srv-g2",
      role: "agent-group",
      text: "新 run",
      ts: 20,
      _source: "server",
      _delegateRunId: "run-b",
      _completed: true,
      _delegateStatus: "failed",
    };
    const merged = applyServerIncremental([localRich], [incoming]);
    expect(merged.map((m) => m.id)).toEqual(["m-g", "srv-g2"]);
  });
});

describe("persist — hidden Bash tail reconciliation", () => {
  const auxiliary = (
    id: string,
    over: Partial<ChatMessage> & { totalBytes: number; tail: string },
  ): ChatMessage => ({
    id,
    role: "runtime-event",
    text: "",
    ts: over.ts ?? 1,
    _source: "server",
    _timelineRecord: true,
    _timelineAuxiliary: "bash-tail",
    _timelineUnitKey: `aux:${id}`,
    _turnKey: over._turnKey ?? "turn-a",
    _turnTapeId: over._turnTapeId ?? "tape-a",
    _recordOrdinal: over._recordOrdinal ?? 1,
    _orderSeq: over._orderSeq ?? 1,
    _runtimeEvent: {
      type: "system",
      subtype: "bash_output_tail",
      tool_use_id: over.blockId ?? "tool-a",
      tail: over.tail,
      total_bytes: over.totalBytes,
      truncated_head: false,
    },
    ...over,
  });

  test("latest exact evidence updates one real top-level tool and remains hidden/resident", () => {
    const tool: ChatMessage = {
      id: "tool-row",
      role: "tool",
      text: "original",
      ts: 2,
      blockId: "tool-a",
      _turnKey: "turn-a",
      _timelineRecord: true,
      _timelineUnitKey: "tool-row",
    };
    const older = auxiliary("tail-old", {
      tail: "old",
      totalBytes: 10,
      _orderSeq: 2,
      _recordOrdinal: 2,
    });
    const latest = auxiliary("tail-new", {
      tail: "latest exact stdout",
      totalBytes: 20,
      _orderSeq: 3,
      _recordOrdinal: 3,
    });

    const reconciled = reconcileTimelineBashTailAuxiliaries([tool, latest, older]);
    const updated = reconciled.find((message) => message.id === tool.id)!;
    expect(updated.bashTail).toEqual({
      tail: "latest exact stdout",
      totalBytes: 20,
      truncatedHead: false,
    });
    expect(updated._runtimeBashTailEvidence).toEqual({
      orderSeq: 3,
      tapeId: "tape-a",
      ordinal: 3,
    });
    expect(reconciled.filter((message) => message._timelineAuxiliary === "bash-tail")).toHaveLength(2);
    expect(reconcileTimelineBashTailAuxiliaries(reconciled)).toBe(reconciled);
  });

  test("evidence loaded first reconciles only after its older owning tool is explicitly paged", () => {
    const tail = auxiliary("tail-first", {
      tail: "late output",
      totalBytes: 12,
      _continuationOfTurnKey: "turn-owner",
      _turnKey: "turn-continuation",
      _orderSeq: 20,
      _recordOrdinal: 9,
    });
    const wrongTurn: ChatMessage = {
      id: "wrong-turn-tool",
      role: "tool",
      text: "wrong",
      ts: 2,
      blockId: "tool-a",
      _turnKey: "turn-other",
      _timelineRecord: true,
      _timelineUnitKey: "wrong-turn-tool",
    };
    const beforeOwner = reconcileTimelineBashTailAuxiliaries([tail, wrongTurn]);
    expect(beforeOwner.find((message) => message.id === wrongTurn.id)?.bashTail).toBeUndefined();

    const owner: ChatMessage = {
      id: "owner-tool",
      role: "tool",
      text: "owner",
      ts: 1,
      blockId: "tool-a",
      _turnKey: "turn-owner",
      _timelineRecord: true,
      _timelineUnitKey: "owner-tool",
    };
    const paged = mergeTimelineHistoryPage(beforeOwner, [owner]);
    const reconciled = reconcileTimelineBashTailAuxiliaries(paged);
    expect(reconciled.find((message) => message.id === owner.id)?.bashTail?.tail).toBe("late output");
    expect(reconciled.find((message) => message.id === wrongTurn.id)?.bashTail).toBeUndefined();
  });

  test("nested delegate tool tail requires the same owning turn and reconciles recursively", () => {
    const group: ChatMessage = {
      id: "group-a",
      role: "agent-group",
      text: "",
      ts: 1,
      _turnKey: "turn-a",
      _delegateRunId: "parent-a",
      childBlocks: [{
        kind: "tool_use",
        blockId: "child-tool",
        childBlocks: [{ kind: "text", text: "kept" }],
      }],
    };
    const tail = auxiliary("child-tail", {
      tail: "delegate stdout",
      totalBytes: 8,
      blockId: "child-tool",
      _recordOrdinal: 4,
      _runtimeEvent: {
        type: "system",
        subtype: "bash_output_tail",
        tool_use_id: "child-tool",
        parent_tool_use_id: "parent-a",
        tail: "delegate stdout",
        total_bytes: 8,
        truncated_head: false,
      },
    });

    const reconciled = reconcileTimelineBashTailAuxiliaries([group, tail]);
    const child = reconciled[0]!.childBlocks?.[0];
    expect(child?.bashTail?.tail).toBe("delegate stdout");
    expect(child?.childBlocks).toEqual([{ kind: "text", text: "kept" }]);
    expect(reconciled[0]!._runtimeBashTailRevision).toBe(1);
  });
});

// ─── B4(b) stableSortByTs 全序不变量:property / fuzz ─────────────────────────
// 审计根因:旧比较器混排 _seq/ts 两域 + 缺 ts 整趟 bail-out → 非传递,V8 输出不可预测。
// 新比较器 = 单一字典序元组 (anchorOrderSeq, durableRank, ts, idx),此处随机构造大量
// {_orderSeq?, _seq?, ts?} 数组,断言:诱导全序(输出元组单调,无环)、幂等(fixed point)、
// 确定性、耐久行按 _orderSeq 单调(时间轴)、置换保元素、缺字段不抛。
describe("persist — stableSortByTs 全序 property/fuzz (B4b)", () => {
  // 可复现 PRNG(mulberry32),不引入外部依赖。
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 有效 _orderSeq 判据必须与实现一致(safe int > 0)。
  const validOrder = (v: unknown): v is number =>
    typeof v === "number" && Number.isSafeInteger(v) && v > 0;

  // 重放实现的锚点 carry-forward,得到每行参与排序的元组,用来独立验证「输出确实按元组单调」。
  function tuplesInInputOrder(msgs: ChatMessage[]): Array<{
    id: string;
    anchor: number;
    rank: number;
    ts: number;
    idx: number;
  }> {
    let anchor = 0;
    return msgs.map((m, idx) => {
      const own = validOrder(m._orderSeq) ? (m._orderSeq as number) : null;
      if (own !== null) anchor = own;
      return {
        id: m.id,
        anchor: own ?? anchor,
        rank: own !== null ? 0 : 1,
        ts: typeof m.ts === "number" && Number.isFinite(m.ts) ? m.ts : 0,
        idx,
      };
    });
  }

  const cmpTuple = (
    a: { anchor: number; rank: number; ts: number; idx: number },
    b: { anchor: number; rank: number; ts: number; idx: number },
  ): number => a.anchor - b.anchor || a.rank - b.rank || a.ts - b.ts || a.idx - b.idx;

  function randomMessages(rnd: () => number): ChatMessage[] {
    const n = Math.floor(rnd() * 9); // 0..8 条(含空/单元素边界)
    const out: ChatMessage[] = [];
    for (let i = 0; i < n; i++) {
      const m: ChatMessage = { id: `m${i}`, role: "assistant", text: "", ts: 0 };
      // ~65% 带 _orderSeq(小池子 → 制造碰撞/乱序/时钟偏移);其余为本地乐观行(无 _orderSeq)。
      if (rnd() < 0.65) m._orderSeq = 1 + Math.floor(rnd() * 6);
      if (rnd() < 0.5) m._seq = 1 + Math.floor(rnd() * 40); // 比较器应完全忽略 _seq
      const tsRoll = rnd();
      if (tsRoll < 0.15) {
        // Fuzz the malformed legacy-wire case without weakening ChatMessage.ts.
        delete (m as Partial<ChatMessage>).ts;
      } else if (tsRoll < 0.3) {
        m.ts = Number.NaN; // 非有限 ts → 实现按 0 兜底,不得整趟 bail-out
      } else {
        m.ts = Math.floor(rnd() * 8); // 小池子:与 _orderSeq 顺序刻意冲突(时钟偏移)
      }
      out.push(m);
    }
    return out;
  }

  test("2000 组随机输入:全序单调 + 幂等 + 确定性 + 耐久行 _orderSeq 单调 + 置换 + 不抛", () => {
    const rnd = mulberry32(0x51ede15);
    for (let trial = 0; trial < 2000; trial++) {
      const input = randomMessages(rnd);
      const inputIds = input.map((m) => m.id);

      const sorted = stableSortByTs(input.map((m) => ({ ...m })));
      const sortedIds = sorted.map((m) => m.id);

      // ① 置换保元素:输出是输入的排列(无丢、无增、无重)。
      expect([...sortedIds].sort()).toEqual([...inputIds].sort());

      // ② 诱导全序:输出按实现所用元组 (anchor, rank, ts, idx) 字典序**单调非降**。
      //    元组来自输入序的锚点重放,按输出 id 取回后逐对断言 → 证明存在一致全序(无环)。
      const tupleById = new Map(tuplesInInputOrder(input).map((t) => [t.id, t]));
      for (let k = 1; k < sorted.length; k++) {
        const prev = tupleById.get(sortedIds[k - 1])!;
        const cur = tupleById.get(sortedIds[k])!;
        expect(cmpTuple(prev, cur)).toBeLessThanOrEqual(0);
      }

      // ③ 幂等:对已排序结果再排一次,顺序不变(fixed point → 无 anchor 重锚漂移)。
      const twice = stableSortByTs(sorted.map((m) => ({ ...m })));
      expect(twice.map((m) => m.id)).toEqual(sortedIds);

      // ④ 确定性:同结构输入独立再排,结果相同(V8 不再"输出不可预测")。
      const again = stableSortByTs(input.map((m) => ({ ...m })));
      expect(again.map((m) => m.id)).toEqual(sortedIds);

      // ⑤ 时间轴单调:带有效 _orderSeq 的耐久行在输出中按 _orderSeq 非降(冻结顺序不被打乱)。
      const durable = sorted.filter((m) => validOrder(m._orderSeq)).map((m) => m._orderSeq as number);
      for (let k = 1; k < durable.length; k++) {
        expect(durable[k]).toBeGreaterThanOrEqual(durable[k - 1]);
      }
    }
  });

  test("审计原环三元组(以 _orderSeq 承载)确定且幂等:低 ts 乐观行不被甩到锚点耐久行之前", () => {
    // A(_orderSeq=5,ts=10)、B(本地乐观,无 _orderSeq,ts=20)、C(_orderSeq=2,ts=30):旧比较器
    // 混排 _seq/ts 会成环;新比较器下 B 锚定到插入序里它前面最近的耐久行 A(_orderSeq=5),
    // 且 durableRank 令 A 恒先于 B。
    const input: ChatMessage[] = [
      { id: "A", role: "assistant", text: "", _orderSeq: 5, ts: 10 },
      { id: "B", role: "assistant", text: "", ts: 20 },
      { id: "C", role: "user", text: "", _orderSeq: 2, ts: 30 },
    ];
    const once = stableSortByTs(input.map((m) => ({ ...m })));
    // C(_orderSeq=2) < A(_orderSeq=5);B 锚定 A 且排在 A 之后(durable-first) → [C, A, B]。
    expect(once.map((m) => m.id)).toEqual(["C", "A", "B"]);
    const twice = stableSortByTs(once.map((m) => ({ ...m })));
    expect(twice.map((m) => m.id)).toEqual(["C", "A", "B"]);
  });

  test("同一完整 tape 按 record ordinal 排序，时钟回拨不能把终答排到思考/工具前", () => {
    const input: ChatMessage[] = [
      { id: "thinking", role: "thinking", text: "想", ts: 300, _orderSeq: 5, _turnTapeId: "t-1", _turnTapeOrdinal: 0 },
      { id: "tool", role: "tool", text: "查", ts: 200, _orderSeq: 5, _turnTapeId: "t-1", _turnTapeOrdinal: 1 },
      { id: "answer", role: "assistant", text: "答", ts: 100, _orderSeq: 5, _turnTapeId: "t-1", _turnTapeOrdinal: 2 },
      { id: "terminal-note", role: "assistant", text: "终态证据", ts: 0, _orderSeq: 5, _turnTapeId: "t-1" },
      { id: "collapsed", role: "assistant", text: "本轮输出", ts: 400, _orderSeq: 5, _turnTapeId: "t-1", _turnTapeProcess: true },
    ];

    expect(stableSortByTs([...input]).map((m) => m.id)).toEqual([
      "collapsed", "thinking", "tool", "answer", "terminal-note",
    ]);
  });
});

// ─── 热尾巴 / 归档合并（SESSION_ARCHIVE_DESIGN §3.2/§3.3） ────────────────────
describe("persist — 热尾巴/归档合并", () => {
  const srv = (id: string, seq: number, text = "", role: ChatMessage["role"] = "assistant"): ChatMessage => ({
    id,
    role,
    text,
    ts: seq, // ts=seq 便于断言排序稳定
    _source: "server",
    _seq: seq,
  });

  test("mergeFullServerWins(热尾巴): 本地 _seq ≤ 水位的已归档行无条件保留(server 只回热尾巴)", () => {
    // 本地缓存有全量 [1..4];server 归档了 1、2(archivedThroughSeq=2),full 只回热尾巴 [3,4]。
    const local = [srv("a1", 1), srv("a2", 2), srv("a3", 3), srv("a4", 4)];
    const server = [srv("a3", 3, "S-3"), srv("a4", 4, "S-4")];
    const merged = mergeFullServerWins(server, local, 2);
    // 归档旧行(a1/a2)保留、不被"server 不认识 = 丢弃"误杀;热尾巴 server-wins。
    expect(merged.map((m) => m.id)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(merged.find((m) => m.id === "a3")!.text).toBe("S-3");
  });

  test("mergeFullServerWins(热尾巴): server-derived 归档缓存保留 _orderSeq,不被逆序 ts 打乱", () => {
    const local: ChatMessage[] = [
      { id: "a1", role: "assistant", text: "一", ts: 900, _source: "server", _seq: 1, _orderSeq: 1 },
      { id: "a2", role: "assistant", text: "二", ts: 100, _source: "server", _seq: 2, _orderSeq: 2 },
      { id: "a3", role: "assistant", text: "三", ts: 300, _source: "server", _seq: 3, _orderSeq: 3 },
    ];
    const server = [{ ...local[2], text: "S-3" }];
    const merged = mergeFullServerWins(server, local, 2);
    expect(merged.map((m) => m.id)).toEqual(["a1", "a2", "a3"]);
    expect(merged.map((m) => m._orderSeq)).toEqual([1, 2, 3]);
  });

  test("mergeFullServerWins(热尾巴): 水位=0(未归档)时旧版行为不变——中段 server 不认识的助手仍丢弃", () => {
    const local = [srv("a1", 1), srv("ghost", 2), srv("a3", 3)];
    const server = [srv("a1", 1), srv("a3", 3)];
    // archivedThroughSeq 缺省(0):ghost 不被"归档保留"覆盖,按旧规则中段陈旧助手丢弃。
    const merged = mergeFullServerWins(server, local);
    expect(merged.map((m) => m.id)).toEqual(["a1", "a3"]);
  });

  test("mergeFullServerWins: 保留中段 client-owned system 行(context_rebuilt 重建提示)", () => {
    const sys: ChatMessage = { id: "sys-ctxrebuild-s1-f7", role: "system", text: "已重新加载会话上下文", ts: 2, _source: "local" };
    const server = [srv("a1", 1, "S-1"), srv("a3", 3, "S-3")];
    // 本地在两条 server 助手之间夹了一条 system 重建提示(无 _seq),server 从不产出 system 行。
    const local = [srv("a1", 1), sys, srv("a3", 3)];
    const merged = mergeFullServerWins(server, local);
    expect(merged.map((m) => m.id)).toEqual(["a1", "sys-ctxrebuild-s1-f7", "a3"]); // system 行保留、按 ts 归位
    expect(merged.find((m) => m.id === "sys-ctxrebuild-s1-f7")!.role).toBe("system");
  });

  test("mergeArchivedHistory: 前插 + 按 id 去重 + 按 _seq 归位", () => {
    const local = [srv("a5", 5), srv("a6", 6)];
    const archived = [srv("a3", 3), srv("a4", 4), srv("a5", 5)]; // a5 与本地重叠 → 去重
    const merged = mergeArchivedHistory(local, archived);
    expect(merged.map((m) => m.id)).toEqual(["a3", "a4", "a5", "a6"]); // 前插 + _seq 升序,不重复 a5
  });

  test("mergeArchivedHistory: 空归档 / 全部已存在 → 返回原引用(零拷贝)", () => {
    const local = [srv("a5", 5), srv("a6", 6)];
    expect(mergeArchivedHistory(local, [])).toBe(local);
    expect(mergeArchivedHistory(local, [srv("a5", 5)])).toBe(local); // 全已在本地
  });
});

describe("persist — 命名空间", () => {
  test("dbNameForUser: sanitize 非法字符 + 不同 user 不同 DB", () => {
    expect(dbNameForUser("u1")).toBe("ocv5_sessions__u1");
    expect(dispatchDbNameForUser("u1")).toBe("ocv5_dispatches__u1");
    expect(dbNameForUser("a@b.com")).toBe("ocv5_sessions__a_b_com");
    expect(dbNameForUser("u1")).not.toBe(dbNameForUser("u2"));
    expect(dbNameForUser(null)).toBe("ocv5_sessions__anon");
  });
});

describe("persist — SessionStore（注入内存 IDB round-trip）", () => {
  const pending = (sessId: string, msgId: string): StoredPendingDispatch => ({
    msgId,
    enqueuedAt: 10,
    payload: {
      type: "inbound.message",
      idempotencyKey: `web:${msgId}:0`,
      channel: "webchat",
      peer: { id: sessId, kind: "dm" },
      agentId: "main",
      clientMessageId: msgId,
      content: { text: "exact" },
      ts: 10,
    },
  });

  const control = (sessId: string, controlId: string): StoredPendingControl => ({
    kind: "control",
    sessId,
    controlId,
    controlKind: "stop",
    clientMessageId: "m-active",
    agentId: "main",
    payload: {
      type: "inbound.control.stop",
      controlId,
      channel: "webchat",
      peer: { id: sessId, kind: "dm" },
      agentId: "main",
      clientMessageId: "m-active",
    },
    enqueuedAt: 10,
    attempt: 0,
  });

  test("control journal reuses v1 dispatch stores and survives reload until authoritative settle", async () => {
    const f = fakeIDBFactory();
    const store = new SessionStore("control-v1", f);
    await store.putSession(stored("s1"));
    await store.putPendingControl(control("s1", "control:stop:m-active"));

    expect(f.versionOf(dispatchDbNameForUser("control-v1"))).toBe(1);
    expect(await store.getPendingControls()).toEqual([
      expect.objectContaining({
        kind: "control",
        sessId: "s1",
        controlId: "control:stop:m-active",
      }),
    ]);
    expect((await store.getAllForHydration())[0]?._pendingControls).toEqual([
      expect.objectContaining({ controlId: "control:stop:m-active" }),
    ]);

    await store.deletePendingControl("s1", "control:stop:m-active");
    expect(await store.getPendingControls()).toEqual([]);
    expect((await store.getAllForHydration())[0]?._pendingControls).toBeUndefined();
  });

  test("durable put waits for readwrite transaction completion", async () => {
    let releaseCommit!: () => void;
    const gate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const store = new SessionStore("durable", fakeIDBFactory(gate));
    let resolved = false;
    const write = store.putSessionDurably(stored("pending")).then(() => { resolved = true; });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    releaseCommit();
    await write;
    expect(resolved).toBe(true);
  });

  test("wipe waits for an already-started journal commit before clearing its payload", async () => {
    let releaseCommit!: () => void;
    const gate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const f = fakeIDBFactory(gate);
    const store = new SessionStore("wipe-inflight", f);
    const write = store.putPendingDispatch("s1", pending("s1", "m-inflight"));
    await Promise.resolve();
    await Promise.resolve();

    let wiped = false;
    const wipe = store.wipe().then(() => { wiped = true; });
    await Promise.resolve();
    expect(wiped).toBe(false);

    releaseCommit();
    await Promise.all([write, wipe]);
    expect(f.values(dispatchDbNameForUser("wipe-inflight"), "pending_dispatches")).toEqual([]);
  });

  test("put → get → getAll → delete → wipe", async () => {
    const f = fakeIDBFactory();
    const store = new SessionStore("u1", f);
    await store.putSession(stored("s1", { title: "会话一" }));
    await store.putSession(stored("s2", { title: "会话二" }));

    expect((await store.getSession("s1"))?.title).toBe("会话一");
    const all = await store.getAll();
    expect(all.map((s) => s.id).sort()).toEqual(["s1", "s2"]);

    await store.deleteSession("s1");
    expect(await store.getSession("s1")).toBeUndefined();
    expect((await store.getAll()).map((s) => s.id)).toEqual(["s2"]);

    await store.wipe();
    expect(await store.getAll()).toEqual([]);
  });

  test("multi-tab stale session writes cannot erase or resurrect the exact journal", async () => {
    const f = fakeIDBFactory();
    const first = new SessionStore("tabs", f);
    const stale = new SessionStore("tabs", f);
    await first.putSession(stored("s1", { title: "fresh" }));
    await first.putPendingDispatch("s1", pending("s1", "m-exact"));

    // A stale tab overwrites the whole session cache without any journal.
    await stale.putSession(stored("s1", { title: "stale" }));
    expect(await first.getPendingDispatches()).toEqual([
      expect.objectContaining({ sessId: "s1", msgId: "m-exact" }),
    ]);
    expect((await first.getAllForHydration())[0]?._pendingDispatches).toEqual([
      expect.objectContaining({ msgId: "m-exact" }),
    ]);

    await first.deletePendingDispatch("s1", "m-exact");
    // Simulate an old v1 tab that still writes the inline journal after ACK.
    f.rawPut(
      dbNameForUser("tabs"),
      "sessions",
      "s1",
      stored("s1", { _pendingDispatches: [pending("s1", "m-exact")] }),
    );
    expect(await first.getPendingDispatches()).toEqual([]);
    expect((await first.getAllForHydration())[0]?._pendingDispatches).toBeUndefined();
  });

  test("v1 sessions stay v1 while inline pending hydrates into the separate journal view", async () => {
    const f = fakeIDBFactory();
    f.seedV1(dbNameForUser("migrate"), [
      stored("s1", { _pendingDispatches: [pending("s1", "m-v1")] }),
    ]);
    const store = new SessionStore("migrate", f);
    const hydrated = await store.getAllForHydration();
    expect(hydrated[0]?._pendingDispatches).toEqual([
      expect.objectContaining({ msgId: "m-v1" }),
    ]);
    expect((await store.getSession("s1"))?._pendingDispatches).toBeUndefined();
    expect(await store.getPendingDispatches()).toEqual([
      expect.objectContaining({ sessId: "s1", msgId: "m-v1" }),
    ]);
    await store.putPendingDispatch("s1", pending("s1", "m-new"));
    expect(f.versionOf(dbNameForUser("migrate"))).toBe(1);
    expect(f.versionOf(dispatchDbNameForUser("migrate"))).toBe(1);
  });

  test("an existing v2 session DB opens versionlessly and its legacy journal hydrates", async () => {
    const f = fakeIDBFactory();
    f.seedV2(
      dbNameForUser("existing-v2"),
      [stored("s1")],
      [{ sessId: "s1", ...pending("s1", "m-v2") }],
    );
    const store = new SessionStore("existing-v2", f);
    expect((await store.getAllForHydration())[0]?._pendingDispatches).toEqual([
      expect.objectContaining({ msgId: "m-v2" }),
    ]);
    expect(f.versionOf(dbNameForUser("existing-v2"))).toBe(2);
  });

  test("settling one legacy inline identity preserves its unresolved sibling", async () => {
    const f = fakeIDBFactory();
    f.seedV1(dbNameForUser("inline-siblings"), [
      stored("s1", {
        _pendingDispatches: [
          pending("s1", "m-done"),
          pending("s1", "m-still-pending"),
        ],
      }),
    ]);
    const store = new SessionStore("inline-siblings", f);
    await store.deletePendingDispatch("s1", "m-done");
    expect((await store.getAllForHydration())[0]?._pendingDispatches).toEqual([
      expect.objectContaining({ msgId: "m-still-pending" }),
    ]);
  });

  test("settled tombstones fence legacy v2, delete-session, and wipe stale writers", async () => {
    const f = fakeIDBFactory();
    const userId = "settled-fence";
    f.seedV2(
      dbNameForUser(userId),
      [stored("s1", { _pendingDispatches: [pending("s1", "m-settled")] })],
      [{ sessId: "s1", ...pending("s1", "m-settled") }],
    );
    const store = new SessionStore(userId, f);
    await store.deletePendingDispatch("s1", "m-settled");

    f.rawPut(
      dbNameForUser(userId),
      "pending_dispatches",
      "s1\0m-settled",
      { sessId: "s1", ...pending("s1", "m-settled") },
    );
    expect(await store.getPendingDispatches()).toEqual([]);

    await store.deleteSession("s1");
    f.rawPut(
      dbNameForUser(userId),
      "sessions",
      "s1",
      stored("s1", { _pendingDispatches: [pending("s1", "m-settled")] }),
    );
    expect((await new SessionStore(userId, f).getAllForHydration())[0]?._pendingDispatches)
      .toBeUndefined();

    const beforeWipe = new SessionStore("wipe-fence", f);
    await beforeWipe.putSession(stored("s2", {
      _pendingDispatches: [pending("s2", "m-wipe")],
    }));
    // New writes scrub inline journals, so seed the old-tab value directly.
    f.rawPut(
      dbNameForUser("wipe-fence"),
      "sessions",
      "s2",
      stored("s2", { _pendingDispatches: [pending("s2", "m-wipe")] }),
    );
    await beforeWipe.wipe();
    f.rawPut(
      dbNameForUser("wipe-fence"),
      "sessions",
      "s2",
      stored("s2", { _pendingDispatches: [pending("s2", "m-wipe")] }),
    );
    expect((await new SessionStore("wipe-fence", f).getAllForHydration())[0]?._pendingDispatches)
      .toBeUndefined();
  });

  test("journal-only crash window reconstructs the exact visible user turn", async () => {
    const store = new SessionStore("journal-only", fakeIDBFactory());
    await store.putPendingDispatch("s-orphan", pending("s-orphan", "m-orphan"));
    const hydrated = await store.getAllForHydration();
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]).toMatchObject({
      id: "s-orphan",
      agentId: "main",
      title: "exact",
      _pendingDispatches: [expect.objectContaining({ msgId: "m-orphan" })],
      messages: [{
        id: "m-orphan",
        role: "user",
        text: "exact",
        status: "queued",
      }],
    });
  });

  test("journal-only crash window restores durable recovery lineage on the reconstructed user row", async () => {
    const store = new SessionStore("journal-recovery", fakeIDBFactory());
    const item = pending("s-recovery", "u-recovery-child");
    item.payload.content = {
      text: "Continue from the exact checkpoint. Do not restart the whole task.",
      displayText: "↻ 从断点继续",
      recovery: {
        sourceClientMessageId: "u-source",
        mode: "checkpoint",
        automatic: false,
      },
    };
    await store.putPendingDispatch("s-recovery", item);
    const hydrated = await store.getAllForHydration();
    expect(hydrated[0]?.messages[0]).toMatchObject({
      id: "u-recovery-child",
      role: "user",
      text: "↻ 从断点继续",
      status: "queued",
      _recoveryOfClientMessageId: "u-source",
      _recoveryMode: "checkpoint",
      _automaticRecovery: false,
    });
  });

  test("journal-only 会话标题使用用户可见正文并与服务端 50 字规则一致", async () => {
    const store = new SessionStore("journal-title", fakeIDBFactory());
    const item = pending("s-title", "m-title");
    const displayText = `${"甲".repeat(50)}乙`;
    item.payload.content = { text: "隐藏的模型正文", displayText };
    await store.putPendingDispatch("s-title", item);

    const hydrated = await store.getAllForHydration();
    expect(hydrated[0]?.title).toBe(`${"甲".repeat(50)}…`);
    expect(hydrated[0]?.messages[0]?.text).toBe(displayText);
  });

  test("按 user 命名空间隔离：user B 读不到 user A 的会话（隐私）", async () => {
    const f = fakeIDBFactory();
    const a = new SessionStore("userA", f);
    const b = new SessionStore("userB", f);
    await a.putSession(stored("sa"));
    expect((await a.getAll()).map((s) => s.id)).toEqual(["sa"]);
    expect(await b.getAll()).toEqual([]); // 不同 DB，零泄漏
  });

  test("数据跨重开存活（reload 不丢）：同 factory 重建 store 仍读得到", async () => {
    const f = fakeIDBFactory();
    const s1 = new SessionStore("u1", f);
    await s1.putSession(stored("keep", { _lastFrameSeq: 42 }));
    s1.close();
    const s2 = new SessionStore("u1", f); // 模拟 reload 后重新打开
    expect((await s2.getSession("keep"))?._lastFrameSeq).toBe(42);
  });

  test("wipe 后写入 no-op（防登出 final flush 把会话写回已清空命名空间）", async () => {
    const f = fakeIDBFactory();
    const store = new SessionStore("u1", f);
    await store.putSession(stored("s1"));
    await store.wipe();
    // 模拟 teardown 的 final flush：wipe 后再 put 必须不生效。
    await store.putSession(stored("s2"));
    expect(await store.getAll()).toEqual([]);
  });

  test("无 IndexedDB 实现（jsdom 默认）优雅降级为 no-op，不抛", async () => {
    const store = new SessionStore("u1"); // 不注入 factory，jsdom 无 global indexedDB
    await expect(store.putSession(stored("x"))).resolves.toBeUndefined();
    await expect(store.putSessionDurably(stored("x"))).rejects.toThrow("indexeddb unavailable");
    await expect(store.putPendingDispatch("x", pending("x", "m-x"))).rejects.toThrow("indexeddb unavailable");
    expect(await store.getSession("x")).toBeUndefined();
    expect(await store.getAll()).toEqual([]);
    await expect(store.wipe()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 同步权威传播(07-17 tail 洪水事故收尾根治):P1 版本护栏下的缺席删除传播 +
// P2 载荷自证(证据为正)的过期副本清除。fixture 忠实还原事故手机缓存:老会话重开、
// 无 completedClientMessageId、本地残留旧代码铸的 live 行(裸引擎 messageId,无
// _clientMessageId/排序轴)+ 已被服务端清理的高 orderSeq tail 行。
// ---------------------------------------------------------------------------
describe("sync authority propagation", () => {
  const TAPE = { _source: "server" as const, _turnTapeId: "tape-1", _turnTapeComplete: true, _clientMessageId: "cm-1" };
  const cleanServer: ChatMessage[] = [
    { id: "u-1", role: "user", text: "复刻这个游戏", ts: 100, _seq: 1, _orderSeq: 1 },
    { id: "srv-peer-main-t1-thinking-s0", role: "thinking", text: "分析截图", ts: 200, _seq: 5, _orderSeq: 5, ...TAPE },
    { id: "srv-peer-main-t1-s0", role: "assistant", text: "我来复刻这个游戏。", ts: 210, _seq: 5, _orderSeq: 5, ...TAPE },
    { id: "srv-peer-main-t1-tool-tb1", role: "tool", text: "创建游戏目录", ts: 220, _seq: 5, _orderSeq: 5, ...TAPE },
    { id: "srv-peer-main-t1-s1", role: "assistant", text: "已复刻完成,规则如下…", ts: 400, _seq: 5, _orderSeq: 5, ...TAPE },
  ];
  const AUTH = { deletionAuthority: true };
  // 事故期缓存:旧代码铸的 live 行(无 _clientMessageId、无排序轴;含 bare 前缀 id 与 tool 后缀 id)
  const staleLiveRows: ChatMessage[] = [
    { id: "srv-peer-main-t1", role: "thinking", text: "分析截图", ts: 200 },
    { id: "srv-peer-main-t1", role: "assistant", text: "我来复刻这个游戏。", ts: 210 },
    { id: "srv-peer-main-t1-tool-oldtb", role: "tool", text: "创建游戏目录", ts: 220 },
  ];
  // 已被服务端事故清理删掉的 tail 折叠行(_source server)。事故真实形态:_seq 乱序且**高于**
  // 主 anchor(13,6,7…),部分行无 _orderSeq —— 版本护栏语义下缺席即删,无行级 seq 豁免。
  const deletedTailRows: ChatMessage[] = [
    { id: "srv-peer-tail_abc-t1-runtime-10528", role: "runtime-event" as ChatMessage["role"], text: "", ts: 300, _seq: 2, _orderSeq: 2, _source: "server" },
    { id: "srv-peer-tail_def-t1-runtime-10531", role: "runtime-event" as ChatMessage["role"], text: "", ts: 301, _seq: 13, _source: "server" },
    { id: "srv-peer-tail_ghi-t1-runtime-10532", role: "runtime-event" as ChatMessage["role"], text: "", ts: 302, _seq: 6, _source: "server" },
  ];
  const deletedTailRow = deletedTailRows[0];

  test("事故缓存全愈:P2 前缀证据清 legacy live 行(bare/thinking/tool 后缀),P1 授权下清 server 已删行,最终=server 序", () => {
    const local = [cleanServer[0], ...staleLiveRows, ...deletedTailRows];
    const merged = mergeFullServerWins(cleanServer, local, 0, undefined, AUTH);
    expect(merged.map((m) => m.id)).toEqual(cleanServer.map((m) => m.id));
  });

  test("P2 证据为正,无授权也生效:clientMessageId 与前缀双通道都不依赖 deletionAuthority", () => {
    const local = [
      cleanServer[0],
      { id: "srv-peer-main-t1", role: "assistant", text: "旧副本A", ts: 210 } as ChatMessage,
      { id: "srv-x", role: "assistant", text: "旧副本B", ts: 215, _clientMessageId: "cm-1" } as ChatMessage,
    ];
    const merged = mergeFullServerWins(cleanServer, local);
    expect(merged.some((m) => m.text.startsWith("旧副本"))).toBe(false);
  });

  test("P1 无版本授权不删(BLOCKER 竞态):旧 full 快照晚到时 server 行缺席≠删除", () => {
    const merged = mergeFullServerWins(cleanServer, [cleanServer[0], deletedTailRow]);
    expect(merged.some((m) => m.id === deletedTailRow.id)).toBe(true);
  });

  test("活跃轮守卫:REST 已回终态、WS 仍在途——活跃 clientMessageId 的行双通道都不清", () => {
    const activeRow: ChatMessage = { id: "srv-peer-main-t1", role: "assistant", text: "流式中…", ts: 210, _clientMessageId: "cm-1" };
    const merged = mergeFullServerWins(cleanServer, [cleanServer[0], activeRow], 0, undefined, {
      ...AUTH, activeClientMessageId: "cm-1",
    });
    expect(merged.some((m) => m.text === "流式中…")).toBe(true);
  });

  test("未覆盖 turn 的 live 行保留(活跃/降级保存安全):server 只回 t1,本地 t2 行原样存活;t1 前缀不误伤 t12", () => {
    const otherRows: ChatMessage[] = [
      { id: "srv-peer-main-t2", role: "assistant", text: "好,正在改…", ts: 510 },
      { id: "srv-peer-main-t12-s0", role: "assistant", text: "t12 的行", ts: 520 },
    ];
    const merged = mergeFullServerWins(cleanServer, [cleanServer[0], ...otherRows], 0, undefined, AUTH);
    expect(merged.some((m) => m.text === "好,正在改…")).toBe(true);
    expect(merged.some((m) => m.text === "t12 的行")).toBe(true);
  });

  test("v1 逐行 writer 不作证:无 _turnTapeId 的 server 行不入证据集,legacy live 行保留", () => {
    const v1Server = cleanServer.map((m) => {
      const { _turnTapeId: _drop, ...rest } = m as ChatMessage & { _turnTapeId?: string };
      void _drop;
      return rest as ChatMessage;
    });
    const merged = mergeFullServerWins(v1Server, [cleanServer[0], staleLiveRows[0]]);
    expect(merged.some((m) => m.id === "srv-peer-main-t1")).toBe(true);
  });

  test("client-owned 行与归档行永不清:user/system/团队卡/plan + 水位下 server 行", () => {
    const archivedRow: ChatMessage = { id: "srv-peer-main-t0-s0", role: "assistant", text: "更早的归档回复", ts: 10, _seq: 3, _orderSeq: 3, _source: "server" };
    const teamCard: ChatMessage = { id: "m-team-1", role: "agent-group" as ChatMessage["role"], text: "", ts: 250, _clientMessageId: "cm-1" };
    const sysRow: ChatMessage = { id: "m-sys-1", role: "system" as ChatMessage["role"], text: "上下文已重建", ts: 260 };
    const planRow: ChatMessage = { id: "plan:tb:g0", role: "plan" as ChatMessage["role"], text: "任务列表", ts: 215 };
    const merged = mergeFullServerWins(cleanServer, [archivedRow, cleanServer[0], teamCard, sysRow, planRow], 4, undefined, AUTH);
    for (const id of ["srv-peer-main-t0-s0", "m-team-1", "m-sys-1", "plan:tb:g0"]) {
      expect(merged.some((m) => m.id === id)).toBe(true);
    }
  });

  test("增量版 P2:incoming 的 v2 tape 展开行自证覆盖,过期 live 副本清除(不传 completedClientMessageId)", () => {
    const merged = applyServerIncremental([cleanServer[0], ...staleLiveRows], cleanServer.slice(1));
    expect(merged.filter((m) => m.role !== "user").map((m) => m.id)).toEqual(cleanServer.slice(1).map((m) => m.id));
  });

  test("增量缺席不代表删除 + 活跃轮守卫在增量同样生效", () => {
    const activeRow: ChatMessage = { id: "srv-peer-main-t1", role: "assistant", text: "流式中…", ts: 210, _clientMessageId: "cm-1" };
    const merged = applyServerIncremental([cleanServer[0], deletedTailRow, activeRow], [cleanServer[4]], undefined, {
      activeClientMessageId: "cm-1",
    });
    expect(merged.some((m) => m.id === deletedTailRow.id)).toBe(true);
    expect(merged.some((m) => m.text === "流式中…")).toBe(true);
  });
});

describe("mergeFullServerWins — records_unpublished degrade page", () => {
  test("keeps local live thinking/tool/plan and adds the Phase-A final assistant", () => {
    const cmid = "u-degrade";
    const user: ChatMessage = { id: cmid, role: "user", text: "q", ts: 1 };
    const thinking: ChatMessage = {
      id: "live-th", role: "thinking", text: "reason", ts: 2, _clientMessageId: cmid,
    };
    const tool: ChatMessage = {
      id: "live-tool", role: "tool", text: "", ts: 3, _clientMessageId: cmid, toolName: "Bash",
    };
    const plan: ChatMessage = {
      id: "live-plan", role: "plan", text: "plan", ts: 4, _clientMessageId: cmid,
    };
    const final: ChatMessage = {
      id: "answer-1",
      role: "assistant",
      text: "final",
      ts: 5,
      _source: "server",
      _clientMessageId: cmid,
      _turnTapeId: "tape-1",
      _turnTapeComplete: true,
      _displayDegraded: true,
      _displayDegradeReason: "records_unpublished",
    };
    const merged = mergeFullServerWins([user, final], [user, thinking, tool, plan], 0, cmid, {
      deletionAuthority: true,
    });
    expect(merged.map((m) => m.role)).toEqual(["user", "thinking", "tool", "plan", "assistant"]);
    expect(merged.some((m) => m.id === "live-th")).toBe(true);
    expect(merged.some((m) => m.id === "live-tool")).toBe(true);
    expect(merged.some((m) => m.id === "live-plan")).toBe(true);
  });

  test("a complete tape without degrade replaces the live process rows", () => {
    const cmid = "u-exact";
    const user: ChatMessage = { id: cmid, role: "user", text: "q", ts: 1, _source: "server" };
    const liveThinking: ChatMessage = {
      id: "live-th", role: "thinking", text: "reason", ts: 2, _clientMessageId: cmid,
    };
    const tapeThinking: ChatMessage = {
      id: "tape-th",
      role: "thinking",
      text: "reason",
      ts: 2,
      _source: "server",
      _clientMessageId: cmid,
      _turnTapeId: "tape-1",
      _turnTapeComplete: true,
    };
    const tapeAssistant: ChatMessage = {
      id: "tape-as",
      role: "assistant",
      text: "final",
      ts: 5,
      _source: "server",
      _clientMessageId: cmid,
      _turnTapeId: "tape-1",
      _turnTapeComplete: true,
    };
    const merged = mergeFullServerWins(
      [user, tapeThinking, tapeAssistant],
      [user, liveThinking],
      0,
      cmid,
      { deletionAuthority: true },
    );
    expect(merged.some((m) => m.id === "live-th")).toBe(false);
    expect(merged.some((m) => m.id === "tape-th")).toBe(true);
    expect(merged.some((m) => m.id === "tape-as")).toBe(true);
  });

  test("late Phase-B tape with high _seq and no clientMessageId stays in the frozen order slot (webmt2kp2ry3lamba)", () => {
    // Production: t2 tape finalized minutes after dispatch terminal. The
    // assistant got _seq=7 and no _clientMessageId. Display must keep the
    // Phase A slot (_orderSeq=4), not sort after the later user (_seq=6).
    const t2User: ChatMessage = {
      id: "m-mt2lapr1-3w-0fv2",
      role: "user",
      text: "把任务面板端到端跑通",
      ts: 100,
      _source: "server",
      _seq: 4,
      _orderSeq: 3,
    };
    const liveThinking: ChatMessage = {
      id: "live-t2-th",
      role: "thinking",
      text: "reason",
      ts: 110,
    };
    const phaseA: ChatMessage = {
      id: "srv-webmt2kp2ry3lamba-main-t2-s5",
      role: "assistant",
      text: "final",
      ts: 120,
      _source: "server",
      _seq: 5,
      _orderSeq: 4,
      _turnTapeId: "tape-t2",
      _turnTapeComplete: true,
      _displayDegradeReason: "records_unpublished",
    };
    const laterUser: ChatMessage = {
      id: "m-mt2m451t-g6-fnwp",
      role: "user",
      text: "我选择:发布到自用 V5",
      ts: 200,
      _source: "server",
      _seq: 6,
      _orderSeq: 5,
    };
    const tapeThinking: ChatMessage = {
      id: "t-th",
      role: "thinking",
      text: "reason",
      ts: 110,
      _source: "server",
      _seq: 7,
      _orderSeq: 4,
      _turnTapeId: "tape-t2",
      _turnTapeComplete: true,
      _turnTapeOrdinal: 0,
    };
    const tapeAssistant: ChatMessage = {
      id: "t-as",
      role: "assistant",
      text: "final",
      ts: 120,
      _source: "server",
      _seq: 7,
      _orderSeq: 4,
      _turnTapeId: "tape-t2",
      _turnTapeComplete: true,
      _turnTapeOrdinal: 1,
    };
    const merged = mergeFullServerWins(
      [t2User, tapeThinking, tapeAssistant, laterUser],
      [t2User, liveThinking, phaseA, laterUser],
      0,
      undefined,
      { deletionAuthority: true },
    );
    expect(merged.map((m) => m.id)).toEqual([
      "m-mt2lapr1-3w-0fv2",
      "t-th",
      "t-as",
      "m-mt2m451t-g6-fnwp",
    ]);
    expect(merged.find((m) => m.id === "t-as")?._clientMessageId).toBeUndefined();
    expect(merged.find((m) => m.id === "t-as")?._seq).toBe(7);
  });
});
