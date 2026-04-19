import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ConnectionRegistry, DEFAULT_MAX_PER_USER, type Conn } from "../ws/connections.js";

function mkConn(
  overrides: Partial<Conn> & Pick<Conn, "id" | "user_id" | "opened_at">,
): Conn & { closed: string[] } {
  const closed: string[] = [];
  const conn: Conn & { closed: string[] } = {
    id: overrides.id,
    user_id: overrides.user_id,
    opened_at: overrides.opened_at,
    close: overrides.close ?? ((reason: string) => { closed.push(reason); }),
    closed,
  };
  return conn;
}

describe("ConnectionRegistry", () => {
  test("默认 maxPerUser = 3", () => {
    assert.equal(DEFAULT_MAX_PER_USER, 3);
  });

  test("constructor 拒绝 maxPerUser < 1", () => {
    assert.throws(() => new ConnectionRegistry({ maxPerUser: 0 }), RangeError);
    assert.throws(() => new ConnectionRegistry({ maxPerUser: -1 }), RangeError);
  });

  test("register 返回 unregister + evicted 空数组(未超额)", () => {
    const reg = new ConnectionRegistry();
    const c1 = mkConn({ id: "c1", user_id: 100n, opened_at: 1 });
    const { unregister, evicted } = reg.register(c1);
    assert.equal(evicted.length, 0);
    assert.equal(reg.count(100n), 1);
    assert.equal(typeof unregister, "function");
  });

  test("同用户开 4 条 → 最老的被 kick", () => {
    const reg = new ConnectionRegistry();
    const c1 = mkConn({ id: "c1", user_id: 100n, opened_at: 100 });
    const c2 = mkConn({ id: "c2", user_id: 100n, opened_at: 200 });
    const c3 = mkConn({ id: "c3", user_id: 100n, opened_at: 300 });
    const c4 = mkConn({ id: "c4", user_id: 100n, opened_at: 400 });

    reg.register(c1);
    reg.register(c2);
    reg.register(c3);
    const r4 = reg.register(c4);

    assert.equal(r4.evicted.length, 1);
    assert.equal(r4.evicted[0]?.id, "c1");
    assert.equal(c1.closed.length, 1);
    assert.ok(c1.closed[0].includes("kicked"));
    assert.equal(reg.count(100n), 3);
  });

  test("opened_at 乱序插入,仍然踢最老的", () => {
    const reg = new ConnectionRegistry();
    const c1 = mkConn({ id: "c1", user_id: 7n, opened_at: 500 });
    const c2 = mkConn({ id: "c2", user_id: 7n, opened_at: 100 }); // 这个才是最老
    const c3 = mkConn({ id: "c3", user_id: 7n, opened_at: 300 });
    const c4 = mkConn({ id: "c4", user_id: 7n, opened_at: 400 });

    reg.register(c1);
    reg.register(c2);
    reg.register(c3);
    const r4 = reg.register(c4);

    assert.deepEqual(r4.evicted.map((e) => e.id), ["c2"]);
    assert.equal(c2.closed.length, 1);
  });

  test("不同用户互不影响", () => {
    const reg = new ConnectionRegistry();
    const a1 = mkConn({ id: "a1", user_id: 1n, opened_at: 10 });
    const a2 = mkConn({ id: "a2", user_id: 1n, opened_at: 20 });
    const a3 = mkConn({ id: "a3", user_id: 1n, opened_at: 30 });
    const b1 = mkConn({ id: "b1", user_id: 2n, opened_at: 40 });
    const b2 = mkConn({ id: "b2", user_id: 2n, opened_at: 50 });

    reg.register(a1);
    reg.register(a2);
    reg.register(a3);
    reg.register(b1);
    reg.register(b2);

    assert.equal(reg.count(1n), 3);
    assert.equal(reg.count(2n), 2);
    assert.equal(reg.total(), 5);
    assert.equal(a1.closed.length, 0);
    assert.equal(b1.closed.length, 0);
  });

  test("unregister 幂等,重复调用不崩", () => {
    const reg = new ConnectionRegistry();
    const c1 = mkConn({ id: "c1", user_id: 9n, opened_at: 1 });
    const { unregister } = reg.register(c1);
    assert.equal(reg.count(9n), 1);
    unregister();
    assert.equal(reg.count(9n), 0);
    unregister(); // 不应崩
    assert.equal(reg.count(9n), 0);
  });

  test("最后一条连接 unregister 后,内部 Map 条目也删除", () => {
    const reg = new ConnectionRegistry();
    const c1 = mkConn({ id: "c1", user_id: 9n, opened_at: 1 });
    const { unregister } = reg.register(c1);
    assert.equal(reg.total(), 1);
    unregister();
    assert.equal(reg.total(), 0);
    // 再次 register 同用户不应受影响
    const c2 = mkConn({ id: "c2", user_id: 9n, opened_at: 2 });
    reg.register(c2);
    assert.equal(reg.count(9n), 1);
  });

  test("被 kick 的连接,其 unregister 调用不应影响 registry", () => {
    const reg = new ConnectionRegistry();
    const c1 = mkConn({ id: "c1", user_id: 1n, opened_at: 100 });
    const c2 = mkConn({ id: "c2", user_id: 1n, opened_at: 200 });
    const c3 = mkConn({ id: "c3", user_id: 1n, opened_at: 300 });
    const c4 = mkConn({ id: "c4", user_id: 1n, opened_at: 400 });

    const r1 = reg.register(c1);
    reg.register(c2);
    reg.register(c3);
    reg.register(c4); // c1 被踢,registry 已移除 c1

    assert.equal(reg.count(1n), 3);
    // c1 的 ws close 事件触发 unregister —— 应是 no-op(因为 c1 已不在 list 里)
    r1.unregister();
    assert.equal(reg.count(1n), 3); // 仍是 c2/c3/c4
  });

  test("close 回调抛错被吞掉", () => {
    const reg = new ConnectionRegistry();
    const c1: Conn = {
      id: "bad",
      user_id: 1n,
      opened_at: 1,
      close: () => { throw new Error("boom"); },
    };
    const c2 = mkConn({ id: "c2", user_id: 1n, opened_at: 2 });
    const c3 = mkConn({ id: "c3", user_id: 1n, opened_at: 3 });
    const c4 = mkConn({ id: "c4", user_id: 1n, opened_at: 4 });
    reg.register(c1);
    reg.register(c2);
    reg.register(c3);
    // 不应因 c1.close 抛错而让 register 失败
    assert.doesNotThrow(() => reg.register(c4));
    assert.equal(reg.count(1n), 3);
  });

  test("maxPerUser = 1 → 每次都踢上一条", () => {
    const reg = new ConnectionRegistry({ maxPerUser: 1 });
    const c1 = mkConn({ id: "c1", user_id: 1n, opened_at: 1 });
    const c2 = mkConn({ id: "c2", user_id: 1n, opened_at: 2 });
    const c3 = mkConn({ id: "c3", user_id: 1n, opened_at: 3 });

    reg.register(c1);
    const r2 = reg.register(c2);
    assert.deepEqual(r2.evicted.map((e) => e.id), ["c1"]);
    const r3 = reg.register(c3);
    assert.deepEqual(r3.evicted.map((e) => e.id), ["c2"]);
    assert.equal(reg.count(1n), 1);
  });

  test("closeAll 清空并调用每个 close", () => {
    const reg = new ConnectionRegistry();
    const c1 = mkConn({ id: "c1", user_id: 1n, opened_at: 1 });
    const c2 = mkConn({ id: "c2", user_id: 1n, opened_at: 2 });
    const c3 = mkConn({ id: "c3", user_id: 2n, opened_at: 3 });
    reg.register(c1);
    reg.register(c2);
    reg.register(c3);

    reg.closeAll("server shutdown");
    assert.equal(reg.total(), 0);
    assert.deepEqual(c1.closed, ["server shutdown"]);
    assert.deepEqual(c2.closed, ["server shutdown"]);
    assert.deepEqual(c3.closed, ["server shutdown"]);
  });

  test("user_id 兼容 bigint 和 string(同一用户按同一 key 归并)", () => {
    const reg = new ConnectionRegistry();
    const c1 = mkConn({ id: "c1", user_id: 42n, opened_at: 1 });
    const c2 = mkConn({ id: "c2", user_id: "42", opened_at: 2 });
    reg.register(c1);
    reg.register(c2);
    assert.equal(reg.count(42n), 2);
    assert.equal(reg.count("42"), 2);
  });
});
