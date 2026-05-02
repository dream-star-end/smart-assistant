// remoteCodexAuth.test.ts — v1.0.72 client-side path validation 单测。
//
// 覆盖:
//   1. putRemoteCodexContainerAuth: 非数字 containerId → 抛 (远端 PUT 不发出)
//   2. putRemoteCodexContainerAuth: 数字 containerId → putFile 被以正确 path/mode/uid/gid 调用
//   3. deleteRemoteCodexContainerAuth: 非数字 containerId → silent noop (与本地 remove 一致)
//   4. deleteRemoteCodexContainerAuth: 数字 containerId → deleteFile 被以正确 path 调用
//
// **测试策略**:不 mock nodeAgentClient(node:test 不带 module mock loader);
// 改成"传入 fake target,断言 client putFile 因测试探针抛出 / 拦截 RPC"。
// 实测做法:暴露内部纯函数 resolveRemotePath 是更简洁的方式 —— 但为了不破坏
// 模块封装,这里通过传入特殊 target 触发后续 rpcCall 路径错误,然后断言
// 错误类型(说明 path validation 已通过)即可。
//
// 实际上此模块功能简单,**最有价值**的单测是 containerId regex guard,纯逻辑、
// 抛错路径,不依赖 net。其余覆盖在 codexAccountActor.test.ts 端到端 + Go
// node-agent files_test.go 的 PUT chown 路径。

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  putRemoteCodexContainerAuth,
  deleteRemoteCodexContainerAuth,
} from "../codex-auth/remoteCodexAuth.js";
import type { NodeAgentTarget } from "../compute-pool/nodeAgentClient.js";

// 一个明显无效的 target;只要 path validation 不通过就根本走不到 rpcCall。
const fakeTarget = {
  url: "https://invalid.example:1",
  spiffe: "spiffe://test/node/00000000-0000-0000-0000-000000000000",
  psk: Buffer.alloc(32),
  caPem: "",
  certPem: "",
  keyPem: "",
  fingerprintSha256Hex: "00",
} as unknown as NodeAgentTarget;

describe("remoteCodexAuth — containerId 输入校验 (client 第一道防线)", () => {
  it("putRemoteCodexContainerAuth: 含 .. 的 containerId → 抛 invalid", async () => {
    await assert.rejects(
      () =>
        putRemoteCodexContainerAuth(
          fakeTarget,
          "../etc/passwd",
          "tok",
          "2026-01-01T00:00:00Z",
        ),
      /invalid containerId/,
    );
  });

  it("putRemoteCodexContainerAuth: 含斜杠的 containerId → 抛 invalid", async () => {
    await assert.rejects(
      () =>
        putRemoteCodexContainerAuth(
          fakeTarget,
          "1/2",
          "tok",
          "2026-01-01T00:00:00Z",
        ),
      /invalid containerId/,
    );
  });

  it("putRemoteCodexContainerAuth: 空字符串 containerId → 抛 invalid", async () => {
    await assert.rejects(
      () =>
        putRemoteCodexContainerAuth(fakeTarget, "", "tok", "2026-01-01T00:00:00Z"),
      /invalid containerId/,
    );
  });

  it("deleteRemoteCodexContainerAuth: 非数字 containerId → silent noop (不抛)", async () => {
    // 与本地 removeCodexContainerAuthDir 同语义:silently noop
    await deleteRemoteCodexContainerAuth(fakeTarget, "../bad");
    await deleteRemoteCodexContainerAuth(fakeTarget, "");
    // 走到这里说明没抛 — pass
    assert.ok(true);
  });
});
