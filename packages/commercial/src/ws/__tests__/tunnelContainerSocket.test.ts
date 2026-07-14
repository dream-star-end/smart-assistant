/**
 * CG4 — tunnelContainerSocket header 构造单测。
 *
 * 直接单测 `_buildTunnelHeaders` 模块内部 seam(pure helper):
 *   - X-Connection-Trace-Id 头写入(必需,合同 A 数据面)
 *   - Authorization 头条件写入(pskHex null / empty → 不写,有效 hex → 写)
 *
 * 为什么不端到端测 createTunnelContainerSocket 实际发送的 WS upgrade headers:
 *   - 该函数走 dialNodeAgentVerifiedTls(mTLS + SPIFFE URI + cert pin)+ ws 库
 *     createConnection hijack,真实 wire 测试要拉起本地 mock node-agent + CA + leaf 全套
 *   - Node 20 + tsx --test 没可靠的 module mock 机制(`t.mock.module()` Node 22.3+ 实验);
 *     静态 ESM `import { WebSocket } from "ws"` / `import { dialNodeAgentVerifiedTls }` 已绑定
 *   - headers 构造从 createTunnelContainerSocket 抽到 _buildTunnelHeaders pure helper,
 *     seam 测过来再加端到端只会重复同一断言
 *
 * 端到端 trace 贯穿契约由 CG10 跨语言契约测(master TS 出帧 + Go agent fixture)兜底。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { _buildTunnelHeaders } from "../tunnelContainerSocket.js";

describe("_buildTunnelHeaders — CG4 connection trace 头注入", () => {
  test("connectionTraceId 写入 X-Connection-Trace-Id 头,值原样透传", () => {
    const connId = "01234567-89ab-cdef-0123-456789abcdef"; // 36-char UUID
    const headers = _buildTunnelHeaders(null, connId);
    assert.equal(headers["X-Connection-Trace-Id"], connId);
  });

  test("pskHex 有效 hex → 写 Authorization: Bearer <hex>", () => {
    const pskHex = "deadbeefcafebabe1234567890abcdef";
    const headers = _buildTunnelHeaders(pskHex, "11111111-1111-1111-1111-111111111111");
    assert.equal(headers.Authorization, `Bearer ${pskHex}`);
    // trace 头同时写入,不应被 Authorization 路径互斥掉
    assert.equal(
      headers["X-Connection-Trace-Id"],
      "11111111-1111-1111-1111-111111111111",
    );
  });

  test("pskHex === null → 不写 Authorization 头", () => {
    const headers = _buildTunnelHeaders(null, "22222222-2222-2222-2222-222222222222");
    assert.equal(
      Object.prototype.hasOwnProperty.call(headers, "Authorization"),
      false,
      "无 psk 场景必须不写 Authorization,避免中间层接到无内容 Bearer 头",
    );
    // X-Connection-Trace-Id 仍必须写
    assert.equal(
      headers["X-Connection-Trace-Id"],
      "22222222-2222-2222-2222-222222222222",
    );
  });

  test("pskHex === '' → 不写 Authorization 头(防 `Bearer ` 空值)", () => {
    const headers = _buildTunnelHeaders("", "33333333-3333-3333-3333-333333333333");
    assert.equal(
      Object.prototype.hasOwnProperty.call(headers, "Authorization"),
      false,
      "空 hex 等价无 PSK;`Bearer ` 空值会被严格中间层 reject",
    );
    assert.equal(
      headers["X-Connection-Trace-Id"],
      "33333333-3333-3333-3333-333333333333",
    );
  });

  test("preview assertion is forwarded only through the explicit preview seam", () => {
    const assertion = "signed_preview_assertion";
    const headers = _buildTunnelHeaders(
      "deadbeef",
      "44444444-4444-4444-4444-444444444444",
      assertion,
    );
    assert.equal(headers["X-OpenClaude-Preview-Assertion"], assertion);
    assert.equal(headers.Authorization, "Bearer deadbeef");
  });
});
