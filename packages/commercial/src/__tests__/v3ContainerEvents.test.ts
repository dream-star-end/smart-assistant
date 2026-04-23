/**
 * v3containerEvents.ts 纯单元 —— 核心判定函数,不 spin up docker。
 *
 * 覆盖:
 *   - uidFromContainerName:合法 / 带 / 前缀 / 非数字 / 非 v3 的拒绝 / 前导 0
 *   - handleContainerEvent:
 *       * OOM action 直接 emit
 *       * die + 137 + OOMKilled=true → emit
 *       * die + 137 + OOMKilled=false → skip(supervisor cleanup)
 *       * die + 137 + OOMKilled=null(inspect 挂) → skip(保守不误报)
 *       * die + 137 + 没 inspect 函数 → skip
 *       * die + 非 137 不发
 *       * 非 v3 容器名不发
 *       * 不是 container type 不发
 *       * dedupe_cache 命中同 bucket 第二条跳过
 *   - createDedupeCache:命中 / 过期后重新允许
 *
 * 不 mock outbox —— safeEnqueueAlert 是 fire-and-forget void-return,
 * 测试只看 handleContainerEvent 返回的 {emitted, reason}。outbox 的副作用
 * 在 alertOutbox integ test 覆盖。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  uidFromContainerName,
  handleContainerEvent,
  createDedupeCache,
  type DockerContainerEvent,
  type OomInspectFn,
} from "../agent-sandbox/v3containerEvents.js";

describe("uidFromContainerName", () => {
  test("合法 uid → 正整数", () => {
    assert.equal(uidFromContainerName("oc-v3-u1"), 1);
    assert.equal(uidFromContainerName("oc-v3-u42"), 42);
    assert.equal(uidFromContainerName("oc-v3-u999999"), 999999);
  });

  test("开头带 / 也接受(docker legacy)", () => {
    assert.equal(uidFromContainerName("/oc-v3-u7"), 7);
  });

  test("非 v3 容器 → null", () => {
    assert.equal(uidFromContainerName("openclaude-runtime"), null);
    assert.equal(uidFromContainerName("oc-v2-u1"), null);
    assert.equal(uidFromContainerName("ocv3u1"), null);
    assert.equal(uidFromContainerName(""), null);
    assert.equal(uidFromContainerName(undefined), null);
  });

  test("非纯数字尾 → null(避免 oc-v3-u<uid>-tmp 等伪造)", () => {
    assert.equal(uidFromContainerName("oc-v3-u1-tmp"), null);
    assert.equal(uidFromContainerName("oc-v3-u-abc"), null);
    assert.equal(uidFromContainerName("oc-v3-u"), null);
  });

  test("前导 0 → null(oc-v3-u01 不允许被解析成 uid=1)", () => {
    assert.equal(uidFromContainerName("oc-v3-u01"), null);
    assert.equal(uidFromContainerName("oc-v3-u007"), null);
    assert.equal(uidFromContainerName("oc-v3-u0042"), null);
  });

  test("0 或负数 uid → null(v3 supervisor 要求正整数)", () => {
    assert.equal(uidFromContainerName("oc-v3-u0"), null);
  });
});

describe("handleContainerEvent", () => {
  function makeEv(partial: Partial<DockerContainerEvent>): DockerContainerEvent {
    return {
      Type: "container",
      ...partial,
    };
  }

  /** inspect 永远返 true —— 模拟真 OOM */
  const mockInspectTrue: OomInspectFn = async () => true;
  /** inspect 永远返 false —— 模拟 supervisor cleanup */
  const mockInspectFalse: OomInspectFn = async () => false;
  /** inspect 返 null —— 模拟容器已 rm 或 inspect 挂 */
  const mockInspectNull: OomInspectFn = async () => null;

  test("action='oom' + v3 容器名 → emitted(不需 inspect)", async () => {
    const r = await handleContainerEvent(
      makeEv({
        Action: "oom",
        Actor: {
          ID: "c".repeat(64),
          Attributes: { name: "oc-v3-u42", exitCode: "" },
        },
      }),
    );
    assert.equal(r.emitted, true);
    assert.ok(r.reason.includes("oom"));
  });

  test("die + 137 + OOMKilled=true → emitted", async () => {
    const r = await handleContainerEvent(
      makeEv({
        Action: "die",
        Actor: {
          ID: "c".repeat(64),
          Attributes: { name: "oc-v3-u7", exitCode: "137" },
        },
      }),
      { inspectOom: mockInspectTrue },
    );
    assert.equal(r.emitted, true);
    assert.ok(r.reason.includes("137"));
    assert.ok(r.reason.includes("OOMKilled=true"));
  });

  test("die + 137 + OOMKilled=false → skip(docker kill / cleanup SIGKILL)", async () => {
    const r = await handleContainerEvent(
      makeEv({
        Action: "die",
        Actor: {
          ID: "c".repeat(64),
          Attributes: { name: "oc-v3-u7", exitCode: "137" },
        },
      }),
      { inspectOom: mockInspectFalse },
    );
    assert.equal(r.emitted, false);
    assert.ok(r.reason.startsWith("die_137_not_oom_killed"));
  });

  test("die + 137 + inspect 返 null(容器已 rm)→ skip(保守不误报)", async () => {
    const r = await handleContainerEvent(
      makeEv({
        Action: "die",
        Actor: {
          ID: "c".repeat(64),
          Attributes: { name: "oc-v3-u7", exitCode: "137" },
        },
      }),
      { inspectOom: mockInspectNull },
    );
    assert.equal(r.emitted, false);
    assert.ok(r.reason.startsWith("die_137_not_oom_killed"));
  });

  test("die + 137 但没传 inspect → skip(避免无 docker client 环境误报)", async () => {
    const r = await handleContainerEvent(
      makeEv({
        Action: "die",
        Actor: {
          ID: "c".repeat(64),
          Attributes: { name: "oc-v3-u7", exitCode: "137" },
        },
      }),
    );
    assert.equal(r.emitted, false);
    assert.equal(r.reason, "die_137_no_inspect");
  });

  test("action='die' 但 exitCode=0 → 不 emit", async () => {
    const r = await handleContainerEvent(
      makeEv({
        Action: "die",
        Actor: {
          Attributes: { name: "oc-v3-u7", exitCode: "0" },
        },
      }),
    );
    assert.equal(r.emitted, false);
  });

  test("action='die' 但 exitCode=143(SIGTERM) → 不 emit(正常 graceful)", async () => {
    const r = await handleContainerEvent(
      makeEv({
        Action: "die",
        Actor: {
          Attributes: { name: "oc-v3-u7", exitCode: "143" },
        },
      }),
    );
    assert.equal(r.emitted, false);
  });

  test("action='start' 不 emit(只关心死亡事件)", async () => {
    const r = await handleContainerEvent(
      makeEv({
        Action: "start",
        Actor: { Attributes: { name: "oc-v3-u7" } },
      }),
    );
    assert.equal(r.emitted, false);
    assert.ok(r.reason.includes("start"));
  });

  test("非 v3 容器名 → 不 emit,reason=not_v3_container", async () => {
    const r = await handleContainerEvent(
      makeEv({
        Action: "oom",
        Actor: { Attributes: { name: "some-postgres-container", exitCode: "137" } },
      }),
    );
    assert.equal(r.emitted, false);
    assert.equal(r.reason, "not_v3_container");
  });

  test("Type!='container' 直接跳过", async () => {
    const r = await handleContainerEvent({
      Type: "network",
      Action: "destroy",
    } as DockerContainerEvent);
    assert.equal(r.emitted, false);
    assert.equal(r.reason, "not_container");
  });

  test("老字段 status(无 Action)也能识别 OOM", async () => {
    // 某些 docker 17.x 的 event 只填 status 不填 Action
    const r = await handleContainerEvent({
      Type: "container",
      status: "oom",
      Actor: { Attributes: { name: "oc-v3-u3" } },
    });
    assert.equal(r.emitted, true);
  });

  test("容器名缺失 → 不 emit", async () => {
    const r = await handleContainerEvent(
      makeEv({
        Action: "oom",
        Actor: { Attributes: {} },
      }),
    );
    assert.equal(r.emitted, false);
  });

  test("dedupe cache:同 bucket 内第二条跳过", async () => {
    const cache = createDedupeCache();
    const ev = makeEv({
      Action: "oom",
      Actor: { ID: "c".repeat(64), Attributes: { name: "oc-v3-u7" } },
    });
    const r1 = await handleContainerEvent(ev, { dedupeCache: cache });
    assert.equal(r1.emitted, true);
    const r2 = await handleContainerEvent(ev, { dedupeCache: cache });
    assert.equal(r2.emitted, false);
    assert.equal(r2.reason, "in_memory_dedupe");
  });
});

describe("createDedupeCache", () => {
  test("同 key 同时间 → 第二次 false", () => {
    const c = createDedupeCache(60_000);
    const t = 1_000_000;
    assert.equal(c.remember("k", t), true);
    assert.equal(c.remember("k", t), false);
  });

  test("同 key 过了 TTL → 再次允许", () => {
    const c = createDedupeCache(60_000);
    const t = 1_000_000;
    assert.equal(c.remember("k", t), true);
    assert.equal(c.remember("k", t + 60_001), true);
  });

  test("不同 key 互不影响", () => {
    const c = createDedupeCache(60_000);
    assert.equal(c.remember("a", 0), true);
    assert.equal(c.remember("b", 0), true);
    assert.equal(c.remember("a", 1), false);
    assert.equal(c.remember("b", 1), false);
  });
});
