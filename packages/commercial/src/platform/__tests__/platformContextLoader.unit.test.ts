/**
 * V3 Phase 5 — platformContextLoader 单元测试。
 *
 * 跑法: cd packages/commercial && npx tsx --test src/platform/__tests__/platformContextLoader.unit.test.ts
 *
 * 矩阵(plan §5.1 Step 7):
 *   - LOADER.1 happy miss → fetchAndCache → 命中后续 hit 不打 reader
 *   - LOADER.2 LRU 容量边界 — 超容量按 insertion order 驱逐
 *   - LOADER.3 soft TTL 过期 → 返 stale + 后台 refresh
 *   - LOADER.4 hard expiry → 强制同步 refresh
 *   - LOADER.5 reader throw → 返 null + 不 negative-cache(Codex 明确订正)
 *   - LOADER.6 reader 返 null(volume 不存在)→ negative cache 命中 30s
 *   - LOADER.7 invalidate 命令清缓存,下次 miss 重新打 reader
 *   - LOADER.8 并发同 userId → inflight dedupe,只发一次 reader.read
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { makePlatformContextLoader } from "../platformContextLoader.js";
import type {
  PlatformContext,
  VolumeContextReader,
} from "../volumeContextReader.js";

// ─── helpers ──────────────────────────────────────────────────────────

function ctx(label: string): PlatformContext {
  return {
    userMd: `user-${label}`,
    memoryMd: `memory-${label}`,
    skills: [],
    volumeMtime: new Date("2026-05-21T00:00:00.000Z"),
  };
}

interface RecordingReader extends VolumeContextReader {
  /** 每次 reader.read 的 userId */
  calls: bigint[];
}

function recordingReader(
  responses:
    | PlatformContext
    | null
    | ((uid: bigint) => Promise<PlatformContext | null>),
): RecordingReader {
  const calls: bigint[] = [];
  const reader: VolumeContextReader = {
    async read(uid) {
      calls.push(uid);
      if (typeof responses === "function") {
        return responses(uid);
      }
      return responses;
    },
  };
  return Object.assign(reader, { calls });
}

/** 简易 fake clock — 测 TTL / hard-expiry 用 */
function fakeClock(initial = 0): { now: () => number; advance: (ms: number) => void } {
  let t = initial;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

// ─── tests ────────────────────────────────────────────────────────────

describe("platformContextLoader — 基础语义", () => {
  test("LOADER.1 happy miss → fetch + cache → 后续 hit 不再打 reader", async () => {
    const reader = recordingReader(ctx("u1"));
    const loader = makePlatformContextLoader({ reader });
    const a = await loader.load(1n);
    const b = await loader.load(1n);
    assert.deepEqual(a, ctx("u1"));
    assert.deepEqual(b, ctx("u1"));
    assert.deepEqual(reader.calls, [1n]); // 只打一次
  });

  test("LOADER.2 LRU 容量边界:超容量按 insertion order 驱逐最老条目", async () => {
    const reader = recordingReader(async (uid) => ctx(`u${uid}`));
    const loader = makePlatformContextLoader({ reader, lruMax: 2 });
    await loader.load(1n); // [1]
    await loader.load(2n); // [1, 2]
    await loader.load(3n); // [2, 3] — 1 被驱逐
    assert.deepEqual(reader.calls, [1n, 2n, 3n]);
    // 1 已被驱逐,再 load 应重新打 reader
    await loader.load(1n);
    assert.deepEqual(reader.calls, [1n, 2n, 3n, 1n]);
  });

  test("LOADER.3 soft TTL 过期 → 返 stale + 后台 refresh(hot path 不阻塞)", async () => {
    const clk = fakeClock(0);
    let nthCall = 0;
    const reader = recordingReader(async () => {
      nthCall += 1;
      return ctx(`gen${nthCall}`);
    });
    const loader = makePlatformContextLoader({
      reader,
      now: clk.now,
      softTtlMs: 60_000,
    });
    // t=0: miss → fetch gen1
    const r1 = await loader.load(1n);
    assert.equal(r1?.userMd, "user-gen1");

    // t=70s: stale → 返 gen1(stale) + 异步触发 fetch gen2
    clk.advance(70_000);
    const r2 = await loader.load(1n);
    assert.equal(r2?.userMd, "user-gen1", "hot path 仍拿 stale,不阻塞");

    // 等后台 refresh 完成(microtask flush)
    await new Promise((r) => setImmediate(r));

    // 再 load:此时缓存已被 refresh,且 clk 没动 → 不 stale,命中 gen2
    const r3 = await loader.load(1n);
    assert.equal(r3?.userMd, "user-gen2");
    assert.equal(reader.calls.length, 2);
  });

  test("LOADER.4 hard expiry → 强制同步 refresh,旧数据被丢弃", async () => {
    const clk = fakeClock(0);
    let nthCall = 0;
    const reader = recordingReader(async () => {
      nthCall += 1;
      return ctx(`gen${nthCall}`);
    });
    const loader = makePlatformContextLoader({
      reader,
      now: clk.now,
      softTtlMs: 60_000,
      hardExpiryMs: 600_000,
    });
    await loader.load(1n); // gen1
    clk.advance(700_000); // 超 hard expiry
    const r = await loader.load(1n);
    // hard expired 应该走同步 fetch,直接拿 gen2(不是 stale gen1)
    assert.equal(r?.userMd, "user-gen2");
  });

  test("LOADER.5 reader throw → loader 返 null + log warn,不 negative-cache(Codex 订正)", async () => {
    let throwOnce = true;
    const reader = recordingReader(async () => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("ECONNRESET");
      }
      return ctx("eventually");
    });
    const loader = makePlatformContextLoader({ reader });
    // 第一次 throw → 返 null
    const r1 = await loader.load(1n);
    assert.equal(r1, null);
    assert.equal(reader.calls.length, 1);
    // 立即再 load:没 negative-cache,应再打 reader(这次成功)
    const r2 = await loader.load(1n);
    assert.equal(r2?.userMd, "user-eventually");
    assert.equal(reader.calls.length, 2);
  });

  test("LOADER.6 reader 返 null(volume 不存在)→ negative-cache 命中 30s", async () => {
    const clk = fakeClock(0);
    const reader = recordingReader(null);
    const loader = makePlatformContextLoader({
      reader,
      now: clk.now,
      negativeTtlMs: 30_000,
    });
    const r1 = await loader.load(1n);
    assert.equal(r1, null);
    assert.equal(reader.calls.length, 1);

    // 5s 后再 load:negative cache 命中,不打 reader
    clk.advance(5_000);
    const r2 = await loader.load(1n);
    assert.equal(r2, null);
    assert.equal(reader.calls.length, 1, "negative cache 命中,不应该打 reader");

    // 35s 后:negative cache 过期 → stale 返 null + 后台 refresh
    clk.advance(30_000);
    const r3 = await loader.load(1n);
    assert.equal(r3, null);
    // hot path 应立即返(stale 也是 null),但后台已触发 refresh
    await new Promise((r) => setImmediate(r));
    assert.equal(reader.calls.length, 2, "negative TTL 过期后后台 refresh 应触发");
  });

  test("LOADER.7 invalidate 清缓存,下次 load 重新打 reader", async () => {
    let nth = 0;
    const reader = recordingReader(async () => {
      nth += 1;
      return ctx(`gen${nth}`);
    });
    const loader = makePlatformContextLoader({ reader });
    const r1 = await loader.load(1n);
    assert.equal(r1?.userMd, "user-gen1");
    loader.invalidate(1n);
    const r2 = await loader.load(1n);
    assert.equal(r2?.userMd, "user-gen2");
    assert.equal(reader.calls.length, 2);
  });

  test("LOADER.8 并发同 userId → inflight dedupe,只打一次 reader.read", async () => {
    let resolveOnce: ((v: PlatformContext) => void) | null = null;
    const blocking = new Promise<PlatformContext>((res) => {
      resolveOnce = res;
    });
    const reader = recordingReader(async () => blocking);
    const loader = makePlatformContextLoader({ reader });

    // 同时发 3 个 load,reader 应只调 1 次
    const p1 = loader.load(1n);
    const p2 = loader.load(1n);
    const p3 = loader.load(1n);

    // 让 microtask 先跑一轮,inflight 入栈
    await new Promise((r) => setImmediate(r));
    assert.equal(reader.calls.length, 1, "并发同 key 应 dedupe");

    resolveOnce!(ctx("dedupe-ok"));
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.equal(r1?.userMd, "user-dedupe-ok");
    assert.equal(r2?.userMd, "user-dedupe-ok");
    assert.equal(r3?.userMd, "user-dedupe-ok");
  });

  test("LOADER.9 userId <= 0 防御性 → 直接返 null,不打 reader", async () => {
    const reader = recordingReader(ctx("nope"));
    const loader = makePlatformContextLoader({ reader });
    const r1 = await loader.load(0n);
    const r2 = await loader.load(-1n);
    assert.equal(r1, null);
    assert.equal(r2, null);
    assert.deepEqual(reader.calls, []);
  });
});
