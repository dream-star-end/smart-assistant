import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveControlPlaneLeader } from "../index.js";

/**
 * 控制面 leader 判定:leader 权威从 channel 解耦为显式信号 OC_CONTROL_PLANE_LEADER。
 *
 * 规约:
 *   - 未设标志 → 行为与旧代码完全一致(v3=leader、v5=follower、COMMERCIAL_CONTROL_PLANE_DISABLED 应急关)
 *   - OC_CONTROL_PLANE_LEADER="1" → 任何 channel 都是 leader(v3 退役后 v5 接管全部 shared mutator)
 *   - OC_CONTROL_PLANE_LEADER="0" → 任何 channel 都强制 follower(应急 kill-switch)
 *
 * 铁律:cutover 先停旧 leader 再给新实例设 =1,禁止双 leader(shared 全表 mutator 双跑)。
 */
describe("resolveControlPlaneLeader", () => {
  test("未设标志:v3 默认 leader、v5 默认 follower(行为与旧代码一致)", () => {
    assert.equal(resolveControlPlaneLeader({}, "v3"), true, "v3 默认 leader");
    assert.equal(resolveControlPlaneLeader({}, "v5"), false, "v5 默认 follower");
  });

  test("未设标志:非 v5 channel 受 COMMERCIAL_CONTROL_PLANE_DISABLED 应急关", () => {
    assert.equal(
      resolveControlPlaneLeader({ COMMERCIAL_CONTROL_PLANE_DISABLED: "1" }, "v3"),
      false,
      "v3 应急 kill-switch 生效",
    );
    // v5 未设显式标志时恒 follower,不受该 kill-switch 反向翻盘影响
    assert.equal(
      resolveControlPlaneLeader({ COMMERCIAL_CONTROL_PLANE_DISABLED: "0" }, "v5"),
      false,
      "v5 无显式 leader 标志时恒 follower",
    );
  });

  test("OC_CONTROL_PLANE_LEADER='1':任何 channel 都成 leader(v5 退役后接管)", () => {
    assert.equal(resolveControlPlaneLeader({ OC_CONTROL_PLANE_LEADER: "1" }, "v5"), true);
    assert.equal(resolveControlPlaneLeader({ OC_CONTROL_PLANE_LEADER: "1" }, "v3"), true);
    // 显式 leader 压过 v3 的应急 disable(显式意图优先)
    assert.equal(
      resolveControlPlaneLeader(
        { OC_CONTROL_PLANE_LEADER: "1", COMMERCIAL_CONTROL_PLANE_DISABLED: "1" },
        "v3",
      ),
      true,
    );
  });

  test("OC_CONTROL_PLANE_LEADER='0':任何 channel 都强制 follower(应急 kill-switch)", () => {
    assert.equal(resolveControlPlaneLeader({ OC_CONTROL_PLANE_LEADER: "0" }, "v3"), false);
    assert.equal(resolveControlPlaneLeader({ OC_CONTROL_PLANE_LEADER: "0" }, "v5"), false);
  });

  test("标志两侧空白被 trim,'1'/'0' 精确匹配,其它值回落 channel 派生", () => {
    assert.equal(resolveControlPlaneLeader({ OC_CONTROL_PLANE_LEADER: " 1 " }, "v5"), true);
    assert.equal(resolveControlPlaneLeader({ OC_CONTROL_PLANE_LEADER: " 0 " }, "v3"), false);
    // 不可识别值(如 "true")→ 回落 channel 派生,不误判为 leader
    assert.equal(resolveControlPlaneLeader({ OC_CONTROL_PLANE_LEADER: "true" }, "v5"), false);
    assert.equal(resolveControlPlaneLeader({ OC_CONTROL_PLANE_LEADER: "yes" }, "v3"), true);
  });
});
