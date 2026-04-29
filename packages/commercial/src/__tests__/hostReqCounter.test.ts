/**
 * hostReqCounter 单测 — 滑动 5min 窗口正确性 + prune 行为。
 *
 * 设置 `NODE_ENV=test` 即可禁用 60s GC tick(模块加载时检查),保证测试无残留。
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  recordHostRequest,
  getHostReqCount5m,
  _snapshotAll,
  _resetForTests,
} from "../compute-pool/hostReqCounter.js";

// 5min = 300_000ms;测试用一个固定 t0 起算
const T0 = 1_700_000_000_000;

beforeEach(() => {
  _resetForTests();
});

describe("hostReqCounter", () => {
  test("empty host returns 0", () => {
    assert.equal(getHostReqCount5m("h-empty", T0), 0);
  });

  test("single record visible at same instant", () => {
    recordHostRequest("h-1", T0);
    assert.equal(getHostReqCount5m("h-1", T0), 1);
  });

  test("records within 5min window all counted", () => {
    recordHostRequest("h-1", T0);
    recordHostRequest("h-1", T0 + 60_000);
    recordHostRequest("h-1", T0 + 240_000);
    assert.equal(getHostReqCount5m("h-1", T0 + 240_000), 3);
  });

  test("records older than 5min pruned on read", () => {
    recordHostRequest("h-1", T0);
    recordHostRequest("h-1", T0 + 100_000);
    recordHostRequest("h-1", T0 + 280_000);
    // T0 + 350_000 ms 时,T0 那条已超 300_000 窗口
    assert.equal(getHostReqCount5m("h-1", T0 + 350_000), 2);
  });

  test("boundary: exactly 5min ago is pruned (cutoff = now - WINDOW_MS)", () => {
    // 恰好 5min 前的请求按 < cutoff 规则会被剪掉(now - 300_000 既是 cutoff,
    // 严格小于即剪。严格小于 vs 小于等于的语义在文档里写 "< cutoff",所以
    // 边界值保留。这里同时验:边界保留 + 再老 1ms 剪掉。
    recordHostRequest("h-1", T0);
    recordHostRequest("h-1", T0 + 1);
    // now = T0 + 300_000 → cutoff = T0;arr[0]=T0 不 < T0,保留
    assert.equal(getHostReqCount5m("h-1", T0 + 300_000), 2);
    // now = T0 + 300_001 → cutoff = T0 + 1;arr[0]=T0 < cutoff 剪;arr[1]=T0+1 不 <
    assert.equal(getHostReqCount5m("h-1", T0 + 300_001), 1);
  });

  test("multiple hosts isolated", () => {
    recordHostRequest("h-a", T0);
    recordHostRequest("h-a", T0 + 100);
    recordHostRequest("h-b", T0 + 200);
    assert.equal(getHostReqCount5m("h-a", T0 + 200), 2);
    assert.equal(getHostReqCount5m("h-b", T0 + 200), 1);
    assert.equal(getHostReqCount5m("h-c", T0 + 200), 0);
  });

  test("_snapshotAll returns all hosts with counts", () => {
    recordHostRequest("h-a", T0);
    recordHostRequest("h-b", T0 + 100);
    recordHostRequest("h-b", T0 + 200);
    const snap = _snapshotAll(T0 + 200);
    assert.equal(snap.size, 2);
    assert.equal(snap.get("h-a"), 1);
    assert.equal(snap.get("h-b"), 2);
  });

  test("prune-on-write at threshold keeps memory bounded for hot host", () => {
    // 写 1100 条,300ms 内累积。每次 push 触发 prune 检查只在数组到 1000 时执行。
    // 全在窗口内(差 < 300_000ms),所以都不该被剪 — 仅验不报错。
    for (let i = 0; i < 1100; i++) {
      recordHostRequest("h-hot", T0 + i);
    }
    assert.equal(getHostReqCount5m("h-hot", T0 + 1100), 1100);
  });

  test("prune-on-write actually trims when old entries exist", () => {
    // 先写老数据:T0 起 50 条
    for (let i = 0; i < 50; i++) recordHostRequest("h-mix", T0 + i);
    // 跳到 T0 + 400_000(老 50 条都已超窗口)再写 1000 条新的(T0 + 400_000..)
    // 写到第 1000 条时 push 后 length=1050,触发 prune;cutoff = (T0+400_999)−300_000 =
    // T0 + 100_999,老 50 条全 < 100_999 → 全剪。
    for (let i = 0; i < 1000; i++) recordHostRequest("h-mix", T0 + 400_000 + i);
    // 再写一条触发更深一层(虽不必要)
    recordHostRequest("h-mix", T0 + 400_999);
    // 全在新窗口内,应是 1001(50 老的已剪)
    assert.equal(getHostReqCount5m("h-mix", T0 + 400_999), 1001);
  });
});
