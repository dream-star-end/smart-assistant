import { describe, expect, test } from "vitest";
import type { ChatMessage } from "./chat/model";
import {
  applyServerIncremental,
  dbNameForUser,
  mergeFullServerWins,
  SessionStore,
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

// ─── 最小内存 IDBFactory（仅覆盖 IdbKV 用到的窄 API） ────────────────────────
function fakeIDBFactory(): IDBFactory {
  type Entry = { stores: Map<string, Map<string, unknown>> };
  const dbs = new Map<string, Entry>();
  // biome-ignore lint/suspicious/noExplicitAny: 测试桩，刻意松散
  const fire = (o: any, ev: string, ...a: any[]) => {
    const h = o[`on${ev}`];
    if (typeof h === "function") h.call(o, ...a);
  };
  function makeReq<T>(exec: () => T) {
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩
    const req: any = { onsuccess: null, onerror: null, result: undefined };
    queueMicrotask(() => {
      try {
        req.result = exec();
        fire(req, "success");
      } catch (e) {
        req.error = e;
        fire(req, "error");
      }
    });
    return req;
  }
  function makeStore(map: Map<string, unknown>) {
    return {
      get: (k: string) => makeReq(() => map.get(k)),
      getAll: () => makeReq(() => [...map.values()]),
      put: (v: unknown, k: string) => makeReq(() => void map.set(k, v)),
      delete: (k: string) => makeReq(() => void map.delete(k)),
      clear: () => makeReq(() => void map.clear()),
    };
  }
  // biome-ignore lint/suspicious/noExplicitAny: 测试桩
  const factory: any = {
    open(name: string) {
      // biome-ignore lint/suspicious/noExplicitAny: 测试桩
      const req: any = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      const isNew = !dbs.has(name);
      if (isNew) dbs.set(name, { stores: new Map() });
      const entry = dbs.get(name)!;
      // biome-ignore lint/suspicious/noExplicitAny: 测试桩
      const db: any = {
        objectStoreNames: { contains: (n: string) => entry.stores.has(n) },
        createObjectStore: (n: string) => {
          entry.stores.set(n, new Map());
          return makeStore(entry.stores.get(n)!);
        },
        transaction: (n: string) => ({ objectStore: (sn: string) => makeStore(entry.stores.get(sn)!) }),
        close: () => {},
      };
      req.result = db;
      queueMicrotask(() => {
        if (isNew) fire(req, "upgradeneeded");
        fire(req, "success");
      });
      return req;
    },
  };
  return factory as IDBFactory;
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
  test("mergeFullServerWins: server 权威 + 保留末尾乐观尾（server 不认识）", () => {
    const server = [msg("a", "S-a"), msg("b", "S-b")];
    // a 重叠（取 server），末尾 c 是本地乐观尾（server 还没持久化）→ 保留。
    const local = [msg("a", "L-a"), msg("c", "L-c")];
    const merged = mergeFullServerWins(server, local);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(merged.find((m) => m.id === "a")!.text).toBe("S-a"); // server-wins
    expect(merged.find((m) => m.id === "c")!.text).toBe("L-c"); // 乐观尾保留
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

  test("applyServerIncremental: 空增量返回原数组引用", () => {
    const local = [msg("a")];
    expect(applyServerIncremental(local, [])).toBe(local);
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

  test("applyServerIncremental: invalid ts falls back to original merge order", () => {
    const local = [msg("a", "L-a"), { ...msg("b", "L-b"), ts: Number.NaN }];
    const incoming = [{ ...msg("c", "S-c"), ts: 0 }];
    const merged = applyServerIncremental(local, incoming);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
});

describe("persist — 命名空间", () => {
  test("dbNameForUser: sanitize 非法字符 + 不同 user 不同 DB", () => {
    expect(dbNameForUser("u1")).toBe("ocv5_sessions__u1");
    expect(dbNameForUser("a@b.com")).toBe("ocv5_sessions__a_b_com");
    expect(dbNameForUser("u1")).not.toBe(dbNameForUser("u2"));
    expect(dbNameForUser(null)).toBe("ocv5_sessions__anon");
  });
});

describe("persist — SessionStore（注入内存 IDB round-trip）", () => {
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
    expect(await store.getSession("x")).toBeUndefined();
    expect(await store.getAll()).toEqual([]);
    await expect(store.wipe()).resolves.toBeUndefined();
  });
});
