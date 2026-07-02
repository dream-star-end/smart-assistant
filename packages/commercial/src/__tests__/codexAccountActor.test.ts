// codexAccountActor.test.ts — v1.0.72 host fanout 单测。
//
// 覆盖:
//   1. host_uuid IS NULL → 走 writeFn(本地)
//   2. host_uuid == selfHostId → 走 writeFn(本地)
//   3. host_uuid != selfHostId → 走 writeRemoteFn(远端)
//   4. 远端 writeRemoteFn 抛错 → tx ROLLBACK + filesFailed += 1(单点计数)
//   5. 远端但 writeRemoteFn 未注入 → 抛错 + filesFailed += 1
//   6. 漂移(account_id 不匹配)→ filesSkipped += 1,既不调 writeFn 也不调 writeRemoteFn
//
// Mock 策略:用 deps.queryFn / deps.txFn / deps.refreshFn 注入,无真 DB / 无真网络。

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  startCodexRefreshActor,
  type CodexRefreshActorDeps,
} from "../account-pool/codexAccountActor.js";

const SELF_HOST = "11111111-1111-1111-1111-111111111111";
const REMOTE_HOST = "22222222-2222-2222-2222-222222222222";

interface FakeRow {
  id: string;
  codex_account_id: string | null;
  state: string;
  host_uuid: string | null;
}

interface Harness {
  rows: FakeRow[];
  writeLocalCalls: Array<{ containerId: string }>;
  writeRemoteCalls: Array<{ hostUuid: string; containerId: string }>;
  errors: Array<{ msg: string; err: unknown }>;
  /** 强制 writeRemoteFn 抛错(测 4) */
  remoteShouldThrow?: boolean;
  /** processAccount 按 rows 顺序对每行调一次 txFn,用栈维护 cid 顺序 */
  txCidStack: string[];
}

/** 用最小桩拼出一个能 runNow 的 actor handle。返回 stats + 收集器。 */
function buildActor(rows: FakeRow[], opts: {
  selfHostId?: string | null;
  withWriteRemoteFn?: boolean;
  remoteShouldThrow?: boolean;
}): { actor: ReturnType<typeof startCodexRefreshActor>; harness: Harness } {
  const harness: Harness = {
    rows,
    writeLocalCalls: [],
    writeRemoteCalls: [],
    errors: [],
    remoteShouldThrow: opts.remoteShouldThrow,
    // 维护 cid 顺序栈:processAccount 按 rows 顺序对每行调一次 txFn
    txCidStack: rows.map((r) => r.id),
  };

  // queryFn:第一次调 = 找待刷新账号(返回单个 acct);第二次调 = 容器枚举(返回 rows)
  let queryCallCount = 0;
  const queryFn = (async (sql: string, _params?: unknown[]) => {
    queryCallCount += 1;
    if (sql.includes("FROM claude_accounts")) {
      return { rows: [{ id: "100" }] } as never;
    }
    if (sql.includes("FROM agent_containers")) {
      return { rows: rows.map((r) => ({ id: r.id })) } as never;
    }
    throw new Error(`unexpected queryFn SQL: ${sql.slice(0, 60)}`);
  }) as CodexRefreshActorDeps["queryFn"];

  // txFn:每次 callback 拿到一个 mock client。client.query 第一次 = FOR UPDATE SELECT 该 cid 行
  const txFn = (async <T>(cb: (c: never) => Promise<T>) => {
    const cid = harness.txCidStack.shift();
    if (!cid) throw new Error("test bug: txCidStack underflow");
    const row = rows.find((r) => r.id === cid);
    const client = {
      query: async (_sql: string) => {
        if (!row) return { rows: [] };
        return {
          rows: [
            {
              codex_account_id: row.codex_account_id,
              state: row.state,
              host_uuid: row.host_uuid,
            },
          ],
        };
      },
    };
    return await cb(client as never);
  }) as CodexRefreshActorDeps["txFn"];

  // refreshFn / writeFn 的 prod 类型(RefreshedTokens / WriteCodexContainerAuthFileResult)
  // 在测试范围之外不需要复刻,经 unknown 桥接 cast 满足结构契约即可
  const refreshFn = (async () => ({
    token: Buffer.from("fake-access-token", "utf8"),
    refresh: undefined,
    expires_at: new Date(Date.now() + 60 * 60 * 1000),
    plan: null,
  })) as unknown as CodexRefreshActorDeps["refreshFn"];

  const writeFn = (async (args: { containerId: string }) => {
    harness.writeLocalCalls.push({ containerId: args.containerId });
    return undefined;
  }) as unknown as CodexRefreshActorDeps["writeFn"];

  const writeRemoteFn = opts.withWriteRemoteFn
    ? (async (hostUuid: string, containerId: string) => {
        if (harness.remoteShouldThrow) throw new Error("remote PUT 503");
        harness.writeRemoteCalls.push({ hostUuid, containerId });
      })
    : undefined;

  const actor = startCodexRefreshActor({
    codexContainerDir: "/tmp/codex",
    containerUid: 1000,
    containerGid: 1000,
    queryFn,
    txFn,
    refreshFn,
    writeFn,
    writeRemoteFn,
    selfHostId: opts.selfHostId,
    onError: (msg, err) => {
      harness.errors.push({ msg, err });
    },
  });
  // 使用 queryCallCount 避免未读 lint
  void queryCallCount;
  return { actor, harness };
}

describe("codexAccountActor v1.0.72 host fanout", () => {
  it("host_uuid IS NULL → writeFn (本地)", async () => {
    const { actor, harness } = buildActor(
      [{ id: "1", codex_account_id: "100", state: "active", host_uuid: null }],
      { selfHostId: SELF_HOST, withWriteRemoteFn: true },
    );
    const stats = await actor.runNow();
    actor.stop();
    assert.equal(stats.filesWritten, 1);
    assert.equal(stats.filesFailed, 0);
    assert.equal(harness.writeLocalCalls.length, 1);
    assert.equal(harness.writeRemoteCalls.length, 0);
  });

  it("host_uuid == selfHostId → writeFn (本地)", async () => {
    const { actor, harness } = buildActor(
      [{ id: "2", codex_account_id: "100", state: "active", host_uuid: SELF_HOST }],
      { selfHostId: SELF_HOST, withWriteRemoteFn: true },
    );
    const stats = await actor.runNow();
    actor.stop();
    assert.equal(stats.filesWritten, 1);
    assert.equal(harness.writeLocalCalls.length, 1);
    assert.equal(harness.writeRemoteCalls.length, 0);
  });

  it("host_uuid != selfHostId → writeRemoteFn (远端)", async () => {
    const { actor, harness } = buildActor(
      [{ id: "3", codex_account_id: "100", state: "active", host_uuid: REMOTE_HOST }],
      { selfHostId: SELF_HOST, withWriteRemoteFn: true },
    );
    const stats = await actor.runNow();
    actor.stop();
    assert.equal(stats.filesWritten, 1);
    assert.equal(stats.filesFailed, 0);
    assert.equal(harness.writeLocalCalls.length, 0);
    assert.deepEqual(harness.writeRemoteCalls, [
      { hostUuid: REMOTE_HOST, containerId: "3" },
    ]);
  });

  it("远端 writeRemoteFn 抛 → tx ROLLBACK + filesFailed += 1 (单点计数)", async () => {
    const { actor, harness } = buildActor(
      [{ id: "4", codex_account_id: "100", state: "active", host_uuid: REMOTE_HOST }],
      { selfHostId: SELF_HOST, withWriteRemoteFn: true, remoteShouldThrow: true },
    );
    const stats = await actor.runNow();
    actor.stop();
    assert.equal(stats.filesWritten, 0);
    assert.equal(stats.filesFailed, 1, "filesFailed 应该 = 1 (单点,不双计)");
    assert.equal(harness.errors.length, 1);
    assert.match(harness.errors[0].msg, /write per-container auth\.json failed/);
  });

  it("远端容器 + writeRemoteFn 未注入 → filesFailed += 1", async () => {
    const { actor, harness } = buildActor(
      [{ id: "5", codex_account_id: "100", state: "active", host_uuid: REMOTE_HOST }],
      { selfHostId: SELF_HOST, withWriteRemoteFn: false },
    );
    const stats = await actor.runNow();
    actor.stop();
    assert.equal(stats.filesWritten, 0);
    assert.equal(stats.filesFailed, 1);
    assert.equal(harness.writeLocalCalls.length, 0);
    assert.equal(harness.writeRemoteCalls.length, 0);
    assert.match(String((harness.errors[0]?.err as Error)?.message ?? ""), /writeRemoteFn not wired/);
  });

  it("漂移 (codex_account_id 不匹配) → filesSkipped, 不调 write*", async () => {
    const { actor, harness } = buildActor(
      [{ id: "6", codex_account_id: "999", state: "active", host_uuid: REMOTE_HOST }],
      { selfHostId: SELF_HOST, withWriteRemoteFn: true },
    );
    const stats = await actor.runNow();
    actor.stop();
    assert.equal(stats.filesWritten, 0);
    assert.equal(stats.filesSkipped, 1);
    assert.equal(stats.filesFailed, 0);
    assert.equal(harness.writeLocalCalls.length, 0);
    assert.equal(harness.writeRemoteCalls.length, 0);
  });
});
