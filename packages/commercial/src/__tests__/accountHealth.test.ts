/**
 * T-31 — health 模块单元测试:只测纯数据结构与 wrap 行为,不触 DB。
 *
 * DB / 熔断语义 / halfOpen / manualEnable/Disable 都在 accountHealth.integ.test.ts 里验证。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryHealthRedis,
  wrapIoredisForHealth,
  healthKey,
  failKey,
  DEFAULT_FAIL_THRESHOLD,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_HEALTH_TTL_SEC,
} from "../account-pool/health.js";

describe("key generators", () => {
  test("healthKey 格式", () => {
    assert.equal(healthKey(1n), "acct:health:1");
    assert.equal(healthKey("42"), "acct:health:42");
  });
  test("failKey 格式", () => {
    assert.equal(failKey(9n), "acct:fail:9");
  });
});

describe("常量暴露", () => {
  test("默认阈值和时长", () => {
    assert.equal(DEFAULT_FAIL_THRESHOLD, 3);
    assert.equal(DEFAULT_COOLDOWN_MS, 10 * 60 * 1000);
    assert.equal(DEFAULT_HEALTH_TTL_SEC, 60);
  });
});

describe("InMemoryHealthRedis", () => {
  test("get/set 基本往返", async () => {
    const r = new InMemoryHealthRedis();
    assert.equal(await r.get("x"), null);
    await r.set("x", "1");
    assert.equal(await r.get("x"), "1");
  });

  test("set 带 exSec → ttlMs 生效,过期后 get 返 null", async () => {
    const r = new InMemoryHealthRedis();
    await r.set("k", "v", { exSec: 0.05 }); // 50ms
    const ttl = r.ttlMs("k");
    assert.ok(ttl !== null && ttl > 0 && ttl <= 50);
    await new Promise((res) => setTimeout(res, 60));
    assert.equal(await r.get("k"), null);
  });

  test("incr 首次返 1,再次返 2,del 后清零", async () => {
    const r = new InMemoryHealthRedis();
    assert.equal(await r.incr("c"), 1);
    assert.equal(await r.incr("c"), 2);
    await r.del("c");
    assert.equal(await r.get("c"), null);
    assert.equal(await r.incr("c"), 1);
  });

  test("expire 对已存在 key 设 TTL;不存在 key 不报错", async () => {
    const r = new InMemoryHealthRedis();
    await r.set("a", "1");
    await r.expire("a", 0.05);
    const ttl = r.ttlMs("a");
    assert.ok(ttl !== null && ttl > 0 && ttl <= 50);
    await r.expire("nonexistent", 1);
    assert.equal(await r.get("nonexistent"), null);
  });

  test("snapshot 不返过期项", async () => {
    const r = new InMemoryHealthRedis();
    await r.set("live", "1");
    await r.set("dying", "2", { exSec: 0.02 });
    await new Promise((res) => setTimeout(res, 40));
    const snap = r.snapshot();
    assert.equal(snap["live"], "1");
    assert.equal(snap["dying"], undefined);
  });
});

describe("wrapIoredisForHealth", () => {
  test("set with exSec 调用 ioredis 的 (k,v,'EX',sec) 签名", async () => {
    const calls: unknown[][] = [];
    const fakeRedis = {
      get: async (_k: string): Promise<string | null> => null,
      set: async (...args: unknown[]): Promise<"OK" | null> => {
        calls.push(args);
        return "OK";
      },
      incr: async (_k: string): Promise<number> => 1,
      expire: async (_k: string, _sec: number): Promise<number> => 1,
      del: async (_k: string): Promise<number> => 1,
    };
    const h = wrapIoredisForHealth(fakeRedis as unknown as Parameters<typeof wrapIoredisForHealth>[0]);
    await h.set("k", "v", { exSec: 60 });
    assert.deepEqual(calls[0], ["k", "v", "EX", 60]);
  });

  test("set 无 exSec 不传 EX", async () => {
    const calls: unknown[][] = [];
    const fakeRedis = {
      get: async (): Promise<string | null> => null,
      set: async (...args: unknown[]): Promise<"OK" | null> => {
        calls.push(args);
        return "OK";
      },
      incr: async (): Promise<number> => 1,
      expire: async (): Promise<number> => 1,
      del: async (): Promise<number> => 1,
    };
    const h = wrapIoredisForHealth(fakeRedis as unknown as Parameters<typeof wrapIoredisForHealth>[0]);
    await h.set("k", "v");
    assert.deepEqual(calls[0], ["k", "v"]);
  });

  test("get/incr/expire/del 透传", async () => {
    const order: string[] = [];
    const fakeRedis = {
      get: async (k: string): Promise<string | null> => {
        order.push(`get:${k}`);
        return "42";
      },
      set: async (): Promise<"OK" | null> => "OK",
      incr: async (k: string): Promise<number> => {
        order.push(`incr:${k}`);
        return 5;
      },
      expire: async (k: string, s: number): Promise<number> => {
        order.push(`expire:${k}:${s}`);
        return 1;
      },
      del: async (k: string): Promise<number> => {
        order.push(`del:${k}`);
        return 1;
      },
    };
    const h = wrapIoredisForHealth(fakeRedis as unknown as Parameters<typeof wrapIoredisForHealth>[0]);
    assert.equal(await h.get("a"), "42");
    assert.equal(await h.incr("b"), 5);
    await h.expire("c", 99);
    await h.del("d");
    assert.deepEqual(order, ["get:a", "incr:b", "expire:c:99", "del:d"]);
  });
});
