import { describe, expect, test } from "vitest";
import type { ChatMessage } from "./chat/model";
import {
  applyServerIncremental,
  dbNameForUser,
  mergeArchivedHistory,
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

  test("applyServerIncremental: _seq(server 权威序)优先于 ts,消客户端时钟偏移错序", () => {
    // 设备钟快 → user 气泡(server 侧也按客户端 ts 存档,ts=9000)大于本轮助手 server ts(1001),
    // 但两行都被 server echo 回、带单调 _seq(user=10 在前、助手=11 在后)。按 _seq 应回 user→助手;
    // 旧的纯 ts 排序会因 9000 > 1001 把 user 气泡错排到答案之后。
    const local = [
      { id: "srv-u", role: "user", text: "问", ts: 9000, _source: "server", _seq: 10 } as ChatMessage,
    ];
    const incoming = [
      { id: "srv-a", role: "assistant", text: "答", ts: 1001, _source: "server", _seq: 11 } as ChatMessage,
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

  // v5 真实 reopen 场景:server-authored 历史只有 assistant/tool 行,团队卡是 client-owned。
  // 团队轮之后又有新一轮 → 团队卡落在「最后一个 server 已知 id」之前(中段),旧逻辑整卡丢弃。
  test("mergeFullServerWins: 保留中段 local-only 团队卡(agent-group/delegate-progress 不随 server-wins 丢弃)", () => {
    const server = [
      { ...msg("srv-1", "第一轮答案"), ts: 100 },
      { ...msg("srv-2", "第二轮答案"), ts: 500 },
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
    // 中段还有一条非团队的 local-only assistant → 仍按旧语义丢弃(可能已被 srv-* 重写)。
    const staleAssistant = { ...msg("m-stale", "被取代的乐观助手行"), ts: 250 };
    const local = [server[0], group, staleAssistant, progress, server[1]];

    const merged = mergeFullServerWins(server, local);
    expect(merged.map((m) => m.id)).toEqual(["srv-1", "m-group", "m-prog", "srv-2"]);
    expect(merged.find((m) => m.id === "m-group")!.childBlocks?.length).toBe(1);
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
    const server = [{ ...msg("srv-a", "答"), ts: 100 }, serverSkeleton];
    const local = [{ ...msg("srv-a", ""), ts: 100 }, localRich];
    const merged = mergeFullServerWins(server, local);
    // 骨架行(srv-group-1)被丢弃,本地富卡(m-group)保留
    expect(merged.map((m) => m.id)).toEqual(["srv-a", "m-group"]);
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
