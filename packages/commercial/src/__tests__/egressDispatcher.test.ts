/**
 * HIGH#5 — egressDispatcher 缓存行为单测。
 *
 * 不连真代理:只验证 cache hit/miss / evict / 同 account 切 URL / 空值。
 * ProxyAgent 实例化本身不会发包,验证"返回相同实例"等同于"复用同一连接池"。
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getDispatcherForAccount,
  _clearEgressDispatcherCacheForTest,
  _egressDispatcherCacheSizeForTest,
  EGRESS_DISPATCHER_CACHE_MAX,
} from "../account-pool/egressDispatcher.js";

beforeEach(() => {
  _clearEgressDispatcherCacheForTest();
});

describe("egressDispatcher (HIGH#5)", () => {
  test("null / 空字符串 → undefined,不进缓存", () => {
    assert.equal(getDispatcherForAccount(1n, null), undefined);
    assert.equal(getDispatcherForAccount(1n, ""), undefined);
    assert.equal(getDispatcherForAccount(1n, undefined), undefined);
    assert.equal(_egressDispatcherCacheSizeForTest(), 0);
  });

  test("同 account + 同 URL → 二次调用返同一实例(命中缓存)", () => {
    const url = "http://proxy.example.com:8080";
    const d1 = getDispatcherForAccount(7n, url);
    const d2 = getDispatcherForAccount(7n, url);
    assert.ok(d1, "first call must build dispatcher");
    assert.strictEqual(d1, d2, "second call must reuse the same instance");
    assert.equal(_egressDispatcherCacheSizeForTest(), 1);
  });

  test("同 account 切 URL → 老实例下线,新实例换上,cache size=1", () => {
    const oldUrl = "http://proxy-a.example.com:8080";
    const newUrl = "http://proxy-b.example.com:8080";
    const d1 = getDispatcherForAccount(42n, oldUrl);
    const d2 = getDispatcherForAccount(42n, newUrl);
    assert.ok(d1);
    assert.ok(d2);
    assert.notStrictEqual(d1, d2, "URL change must build a fresh dispatcher");
    assert.equal(_egressDispatcherCacheSizeForTest(), 1, "old entry must be evicted");
  });

  test("不同 account 各持 1 份(各算各的连接池)", () => {
    const url = "http://shared.example.com:8080";
    const d1 = getDispatcherForAccount(1n, url);
    const d2 = getDispatcherForAccount(2n, url);
    assert.notStrictEqual(d1, d2);
    assert.equal(_egressDispatcherCacheSizeForTest(), 2);
  });

  test("切回 null → 同 account 旧 dispatcher 下线", () => {
    const url = "http://proxy.example.com:8080";
    getDispatcherForAccount(99n, url);
    assert.equal(_egressDispatcherCacheSizeForTest(), 1);
    const d2 = getDispatcherForAccount(99n, null);
    assert.equal(d2, undefined);
    assert.equal(_egressDispatcherCacheSizeForTest(), 0);
  });

  test("非法 URL → undefined + 不进缓存(不抛,不阻塞 chat)", () => {
    const d = getDispatcherForAccount(11n, "this is not a url");
    assert.equal(d, undefined);
    assert.equal(_egressDispatcherCacheSizeForTest(), 0);
  });

  test("LRU evict:超过 MAX 后 size 不会无限增长", () => {
    // MAX+1 个不同账号,每个不同 URL → 触发 evict
    for (let i = 0; i < EGRESS_DISPATCHER_CACHE_MAX + 5; i += 1) {
      getDispatcherForAccount(BigInt(i), `http://p${i}.example.com:8080`);
    }
    // 不严格 == MAX(我们只 evict 一个 / 调用),但绝不能突破 MAX 太多
    const size = _egressDispatcherCacheSizeForTest();
    assert.ok(
      size <= EGRESS_DISPATCHER_CACHE_MAX + 1,
      `cache size ${size} must stay within MAX (${EGRESS_DISPATCHER_CACHE_MAX})`,
    );
  });

  test("重复读最近的不会被 LRU 踢:稳定老 account 上的 dispatcher 一直在", () => {
    const oldAccountUrl = "http://stable.example.com:8080";
    const stable = getDispatcherForAccount(1000n, oldAccountUrl);
    assert.ok(stable);
    // 灌满缓存,期间反复"用"老 account,刷新它的 lastUsed
    for (let i = 0; i < EGRESS_DISPATCHER_CACHE_MAX + 5; i += 1) {
      getDispatcherForAccount(BigInt(2000 + i), `http://p${i}.example.com:8080`);
      // 重新访问保持 LRU 新鲜
      getDispatcherForAccount(1000n, oldAccountUrl);
    }
    const stillThere = getDispatcherForAccount(1000n, oldAccountUrl);
    assert.strictEqual(stillThere, stable, "stable account must survive LRU pressure");
  });
});
