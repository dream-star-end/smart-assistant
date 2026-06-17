/**
 * egressDispatcher 缓存行为单测(plain proxy 路径)。
 *
 * mTLS 路径需要 master TLS material(读 ./certs)+ KMS key + ProxyAgent 真发握手,
 * 走 e2e/集成测试更合适;此处只覆盖 plain HTTP proxy 与 cache LRU 行为。
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getDispatcherForAccount,
  resolveAccountEgressDispatcher,
  directEgressDispatcher,
  _clearEgressDispatcherCacheForTest,
  _egressDispatcherCacheSizeForTest,
  EGRESS_DISPATCHER_CACHE_MAX,
  type EgressTarget,
} from "../account-pool/egressDispatcher.js";
import type { Dispatcher } from "undici";

beforeEach(() => {
  _clearEgressDispatcherCacheForTest();
});

describe("directEgressDispatcher (静态/国内 provider 直连出口)", () => {
  test("返回稳定单例,defined,且不进 account egress LRU 缓存", () => {
    const d1 = directEgressDispatcher();
    const d2 = directEgressDispatcher();
    assert.ok(d1, "must return a defined dispatcher (绕开全局 EnvHttpProxyAgent/日本)");
    assert.strictEqual(d1, d2, "进程级单例:多次调用返同一实例");
    // 直连出口与账号专属 egress dispatcher 隔离,绝不进 LRU cache。
    assert.equal(_egressDispatcherCacheSizeForTest(), 0);
  });
});

describe("egressDispatcher (plain proxy)", () => {
  test("null / 空字符串 / undefined egressProxy + null egressTarget → undefined", async () => {
    assert.equal(await getDispatcherForAccount(1n, null, null), undefined);
    assert.equal(await getDispatcherForAccount(1n, "", null), undefined);
    assert.equal(await getDispatcherForAccount(1n, undefined, null), undefined);
    assert.equal(_egressDispatcherCacheSizeForTest(), 0);
  });

  test("同 account + 同 URL → 二次调用返同一实例(命中缓存)", async () => {
    const url = "http://proxy.example.com:8080";
    const d1 = await getDispatcherForAccount(7n, url, null);
    const d2 = await getDispatcherForAccount(7n, url, null);
    assert.ok(d1, "first call must build dispatcher");
    assert.strictEqual(d1, d2, "second call must reuse the same instance");
    assert.equal(_egressDispatcherCacheSizeForTest(), 1);
  });

  test("同 account 切 URL → 老实例下线,新实例换上,cache size=1", async () => {
    const oldUrl = "http://proxy-a.example.com:8080";
    const newUrl = "http://proxy-b.example.com:8080";
    const d1 = await getDispatcherForAccount(42n, oldUrl, null);
    const d2 = await getDispatcherForAccount(42n, newUrl, null);
    assert.ok(d1);
    assert.ok(d2);
    assert.notStrictEqual(d1, d2, "URL change must build a fresh dispatcher");
    assert.equal(_egressDispatcherCacheSizeForTest(), 1, "old entry must be evicted");
  });

  test("不同 account 各持 1 份(各算各的连接池)", async () => {
    const url = "http://shared.example.com:8080";
    const d1 = await getDispatcherForAccount(1n, url, null);
    const d2 = await getDispatcherForAccount(2n, url, null);
    assert.notStrictEqual(d1, d2);
    assert.equal(_egressDispatcherCacheSizeForTest(), 2);
  });

  test("切回 null → 同 account 旧 dispatcher 下线", async () => {
    const url = "http://proxy.example.com:8080";
    await getDispatcherForAccount(99n, url, null);
    assert.equal(_egressDispatcherCacheSizeForTest(), 1);
    const d2 = await getDispatcherForAccount(99n, null, null);
    assert.equal(d2, undefined);
    assert.equal(_egressDispatcherCacheSizeForTest(), 0);
  });

  test("非法 URL → undefined + 不进缓存(不抛,不阻塞 chat)", async () => {
    const d = await getDispatcherForAccount(11n, "this is not a url", null);
    assert.equal(d, undefined);
    assert.equal(_egressDispatcherCacheSizeForTest(), 0);
  });

  test("LRU evict:超过 MAX 后 size 不会无限增长", async () => {
    for (let i = 0; i < EGRESS_DISPATCHER_CACHE_MAX + 5; i += 1) {
      await getDispatcherForAccount(BigInt(i), `http://p${i}.example.com:8080`, null);
    }
    const size = _egressDispatcherCacheSizeForTest();
    assert.ok(
      size <= EGRESS_DISPATCHER_CACHE_MAX + 1,
      `cache size ${size} must stay within MAX (${EGRESS_DISPATCHER_CACHE_MAX})`,
    );
  });

  test("重复读最近的不会被 LRU 踢:稳定老 account 上的 dispatcher 一直在", async () => {
    const oldAccountUrl = "http://stable.example.com:8080";
    const stable = await getDispatcherForAccount(1000n, oldAccountUrl, null);
    assert.ok(stable);
    for (let i = 0; i < EGRESS_DISPATCHER_CACHE_MAX + 5; i += 1) {
      await getDispatcherForAccount(BigInt(2000 + i), `http://p${i}.example.com:8080`, null);
      await getDispatcherForAccount(1000n, oldAccountUrl, null);
    }
    const stillThere = await getDispatcherForAccount(1000n, oldAccountUrl, null);
    assert.strictEqual(stillThere, stable, "stable account must survive LRU pressure");
  });

  test("plain 优先于 mtls:同时给 egressProxy 和 egressTarget,走 plain", async () => {
    // 即使给了一个看起来合法的 mTLS target,plain URL 非空就走 plain
    const fakeTarget = {
      kind: "mtls" as const,
      hostUuid: "11111111-1111-1111-1111-111111111111",
      host: "10.0.0.1",
      port: 9444,
      fingerprint: "deadbeef".repeat(8),
      pskNonce: Buffer.alloc(12),
      pskCt: Buffer.alloc(48),
    };
    const d = await getDispatcherForAccount(
      555n,
      "http://manual.example.com:8080",
      fakeTarget,
    );
    assert.ok(d, "plain proxy must be used when egressProxy is non-empty");
    assert.equal(_egressDispatcherCacheSizeForTest(), 1);
  });
});

// ─── resolveAccountEgressDispatcher (A2 优先级状态机 + fail-closed) ─────────
describe("resolveAccountEgressDispatcher", () => {
  const STUB = { stub: "dispatcher" } as unknown as Dispatcher;
  const mtlsTarget: EgressTarget = {
    kind: "mtls",
    hostUuid: "h-1",
    host: "10.0.0.1",
    port: 9444,
    fingerprint: "ab".repeat(32),
    pskNonce: Buffer.alloc(12),
    pskCt: Buffer.alloc(16),
  };
  // 记录 getDispatcher 调用参数的 stub 工厂
  function spy(ret: Dispatcher | undefined) {
    const calls: Array<{ proxy: unknown; target: unknown }> = [];
    const fn = (async (
      _id: bigint | string,
      proxy: string | null | undefined,
      target: EgressTarget | null | undefined,
    ) => {
      calls.push({ proxy, target });
      return ret;
    }) as typeof getDispatcherForAccount;
    return { fn, calls };
  }

  test("全空(真正未绑)→ unbound;仍调一次 getDispatcher(null,null) 做 evict", async () => {
    const s = spy(undefined);
    const r = await resolveAccountEgressDispatcher(
      1n,
      { egressProxy: null, egressTarget: null, egressProxyId: null, egressHostUuid: null },
      s.fn,
    );
    assert.deepEqual(r, { kind: "unbound" });
    assert.equal(s.calls.length, 1);
    assert.deepEqual(s.calls[0], { proxy: null, target: null });
  });

  test("proxy 绑定 + 解析成功 → ready;只传 proxy,target 强制 null", async () => {
    const s = spy(STUB);
    const r = await resolveAccountEgressDispatcher(
      1n,
      { egressProxy: "http://p:8080", egressTarget: mtlsTarget, egressProxyId: 9n, egressHostUuid: "h-1" },
      s.fn,
    );
    assert.equal(r.kind, "ready");
    if (r.kind !== "ready") return;
    assert.equal(r.dispatcher, STUB);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].proxy, "http://p:8080");
    assert.equal(s.calls[0].target, null); // 绝不把 target 传下去
  });

  test("proxy 绑定 + 解析失败(undefined)→ unavailable", async () => {
    const s = spy(undefined);
    const r = await resolveAccountEgressDispatcher(
      1n,
      { egressProxy: "http://p:8080", egressTarget: null, egressProxyId: 9n, egressHostUuid: null },
      s.fn,
    );
    assert.equal(r.kind, "unavailable");
  });

  test("proxy 权威(id 在)但 proxy 被 disabled(URL=null)+ host ready → unavailable,绝不回落 host", async () => {
    const s = spy(STUB);
    const r = await resolveAccountEgressDispatcher(
      1n,
      { egressProxy: null, egressTarget: mtlsTarget, egressProxyId: 9n, egressHostUuid: "h-1" },
      s.fn,
    );
    assert.equal(r.kind, "unavailable");
    assert.equal(s.calls.length, 0, "proxy 解析为空即 fail-closed,绝不调 getDispatcher 走 host");
  });

  test("legacy raw(egressProxy 有 + id=null)→ 视作 proxy 绑定 → ready", async () => {
    const s = spy(STUB);
    const r = await resolveAccountEgressDispatcher(
      1n,
      { egressProxy: "http://raw:8080", egressTarget: null, egressProxyId: null, egressHostUuid: null },
      s.fn,
    );
    assert.equal(r.kind, "ready");
    assert.equal(s.calls[0].proxy, "http://raw:8080");
  });

  test("仅 mTLS 绑定 + target ready → ready;只传 target,proxy 强制 null", async () => {
    const s = spy(STUB);
    const r = await resolveAccountEgressDispatcher(
      1n,
      { egressProxy: null, egressTarget: mtlsTarget, egressProxyId: null, egressHostUuid: "h-1" },
      s.fn,
    );
    assert.equal(r.kind, "ready");
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].proxy, null);
    assert.equal(s.calls[0].target, mtlsTarget);
  });

  test("仅 mTLS 绑定 + host 未 ready(target=null)→ unavailable,不调 getDispatcher", async () => {
    const s = spy(undefined);
    const r = await resolveAccountEgressDispatcher(
      1n,
      { egressProxy: null, egressTarget: null, egressProxyId: null, egressHostUuid: "h-2" },
      s.fn,
    );
    assert.equal(r.kind, "unavailable");
    assert.equal(s.calls.length, 0);
  });
});
