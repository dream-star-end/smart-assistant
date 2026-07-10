/**
 * v5 收口(2026-07-10)— admin 容器操作的 docker 句柄解析。
 *
 * 回归背景:v5 master 有意不装配 agentRuntime(容器面走 v3Supervisor),而
 * logs/restart/stop/remove 四个 admin handler 曾把 `deps.agentRuntime` 当硬门,
 * 导致 v5 管理后台所有容器操作 503 AGENT_NOT_READY(生产实锤:追踪号
 * e41f291afb…/48bd3f97…)。resolveAdminDockerHandle 是修复后的单一解析点:
 * agentRuntime.docker(v2 遗留优先,保持 v3 master 行为)?? v3Supervisor.docker。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type Docker from "dockerode";
import { resolveAdminDockerHandle } from "../http/admin/containers.js";

const agentDocker = { __tag: "agent" } as unknown as Docker;
const supervisorDocker = { __tag: "v3sup" } as unknown as Docker;

describe("resolveAdminDockerHandle — v5 agentRuntime 缺席不再 503", () => {
  test("agentRuntime 存在 → 优先其 docker(v3 master 行为不变)", () => {
    const got = resolveAdminDockerHandle({
      agentRuntime: { docker: agentDocker } as never,
      v3Supervisor: { docker: supervisorDocker } as never,
    });
    assert.equal(got, agentDocker);
  });

  test("agentRuntime 缺席(v5 形态)→ 回落 v3Supervisor.docker,不得判不可用", () => {
    const got = resolveAdminDockerHandle({
      agentRuntime: undefined,
      v3Supervisor: { docker: supervisorDocker } as never,
    });
    assert.equal(got, supervisorDocker);
  });

  test("两套运行时皆缺 → null(调用方据此 503)", () => {
    const got = resolveAdminDockerHandle({ agentRuntime: undefined, v3Supervisor: undefined });
    assert.equal(got, null);
  });
});
