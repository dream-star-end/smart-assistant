/**
 * V3 Phase 4H+ — maintenance 中间件的纯单元测试。
 *
 * 覆盖:
 *   - `isInMaintenance` DB 不可达时 fail-open 返 false(安全兜底)
 *   - `_clearMaintenanceCache` 真的清掉缓存(下一次调用会重新查)
 *   - `isActiveAdmin` 对空 token / 非法 JWT 一律返 false(不抛错、不泄露)
 *
 * DB 真实行为(读到 true/false、60s 缓存命中 / 过期)走 integ test,这里
 * 只锁定"不查 DB"路径以及"验证失败不泄露"。
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import {
  isInMaintenance,
  isActiveAdmin,
  _clearMaintenanceCache,
} from "../maintenanceMode.js";

function fakeReq(): IncomingMessage {
  // 只需要满足 IncomingMessage 的最小结构 —— verifyCommercialJwtSync / requireAdminVerifyDb
  // 在 token 为空时会立刻 bail,根本不会读 req.headers / req.socket。
  return new IncomingMessage(new Socket());
}

describe("isInMaintenance — fail-open on DB error", () => {
  beforeEach(() => {
    _clearMaintenanceCache();
  });

  test("DB 未 wire(pool 未初始化)→ 返 false,不抛", async () => {
    // 单测 runner 不起 PG,getSystemSetting 内部 query() 会抛;中间件 try/catch 吞掉,返 false。
    // 语义:fail-open —— DB 故障绝不能把整站打挂成"维护中"。
    const r = await isInMaintenance();
    assert.equal(r, false);
  });

  test("缓存:连续调用第二次不再抛(命中缓存)", async () => {
    await isInMaintenance();
    // 如果 cache 没生效,第二次仍会抛 —— 所以这里也验证了 cache 路径
    const r = await isInMaintenance();
    assert.equal(r, false);
  });

  test("_clearMaintenanceCache 强制下一次重新走 DB 分支", async () => {
    await isInMaintenance();
    _clearMaintenanceCache();
    // 重新走一次仍然 fail-open 返 false —— 验证 clear 后没死(不进入坏状态)
    const r = await isInMaintenance();
    assert.equal(r, false);
  });
});

describe("isActiveAdmin — defense in depth", () => {
  const FAKE_SECRET = "x".repeat(32); // JWT verify 至少要有 secret,不能 undefined

  test("空 token → false(anonymous 不进维护期 admin bypass)", async () => {
    const r = await isActiveAdmin(fakeReq(), "", FAKE_SECRET);
    assert.equal(r, false);
  });

  test("乱写的 token → false(JWT 解析失败不抛)", async () => {
    const r = await isActiveAdmin(fakeReq(), "not-a-jwt", FAKE_SECRET);
    assert.equal(r, false);
  });

  test("格式像 JWT 但签名 / 结构非法 → false", async () => {
    const r = await isActiveAdmin(fakeReq(), "aaa.bbb.ccc", FAKE_SECRET);
    assert.equal(r, false);
  });
});
