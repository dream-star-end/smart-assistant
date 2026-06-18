/**
 * V3 Phase 5 — VolumeContextReader 单元测试。
 *
 * 跑法: cd packages/commercial && npx tsx --test src/platform/__tests__/volumeContextReader.unit.test.ts
 *
 * 矩阵(plan §5.1 Step 7):
 *   - LOCAL.1-4 makeLocalVolumeReader 通过 `volumeBaseDir` hook 在 tmpdir 实跑
 *   - REMOTE.1-5 makeRemoteVolumeReader 通过 `toTarget` + `rpc` hook 注入 fake target
 *                  + AgentAppError 404 null 路径 + psk.fill(0) 安全 invariant
 *   - ROUTING.1-3 makeRoutingVolumeReader 通过 `findUserDataHost` + `getSelfHost` hook
 *                  分别走 self/remote/null-host 三条调度路径
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  makeLocalVolumeReader,
  makeRemoteVolumeReader,
  makeRoutingVolumeReader,
  type VolumeContextReader,
} from "../volumeContextReader.js";
import {
  AgentAppError,
  type NodeAgentTarget,
  type PlatformContextResponse,
} from "../../compute-pool/nodeAgentClient.js";
import type { ComputeHostRow, ComputeHostStatus } from "../../compute-pool/types.js";

// ─── LOCAL ──────────────────────────────────────────────────────────────

async function mkTmpVolumeBase(): Promise<string> {
  return fsp.mkdtemp(join(tmpdir(), "vcr-test-"));
}

async function writeUserVolume(
  baseDir: string,
  userId: bigint,
  files: {
    userMd?: string;
    memoryMd?: string;
    skills?: Array<{ dir: string; head: string }>;
  },
): Promise<string> {
  const vroot = join(baseDir, `oc-v3-data-u${userId.toString()}`, "_data");
  const agentMain = join(vroot, "agents", "main");
  await fsp.mkdir(agentMain, { recursive: true });
  if (files.userMd !== undefined) {
    // USER.md is user-level shared → volume root user.md
    await fsp.writeFile(join(vroot, "user.md"), files.userMd, "utf8");
  }
  if (files.memoryMd !== undefined) {
    // MEMORY.md stays per-agent (main)
    await fsp.writeFile(join(agentMain, "MEMORY.md"), files.memoryMd, "utf8");
  }
  if (files.skills) {
    // skills are user-level shared → volume root skills/
    const skillsDir = join(vroot, "skills");
    await fsp.mkdir(skillsDir, { recursive: true });
    for (const s of files.skills) {
      const sd = join(skillsDir, s.dir);
      await fsp.mkdir(sd, { recursive: true });
      await fsp.writeFile(join(sd, "SKILL.md"), s.head, "utf8");
    }
  }
  return vroot;
}

describe("makeLocalVolumeReader — fs 实跑(`volumeBaseDir` hook 注入 tmpdir)", () => {
  test("LOCAL.1 happy path:USER.md + MEMORY.md + 2 skills frontmatter 全部命中", async () => {
    const base = await mkTmpVolumeBase();
    try {
      await writeUserVolume(base, 100n, {
        userMd: "# user.md content\nhello",
        memoryMd: "# memory.md content\nworld",
        skills: [
          {
            dir: "alpha-skill",
            head: "---\nname: alpha\ndescription: first skill\n---\nbody...",
          },
          {
            dir: "beta-skill",
            head: '---\nname: "beta"\ndescription: "second skill"\n---\nbody...',
          },
        ],
      });
      const reader = makeLocalVolumeReader({ volumeBaseDir: base });
      const ctx = await reader.read(100n);
      assert.ok(ctx, "context must not be null");
      assert.equal(ctx.userMd, "# user.md content\nhello");
      assert.equal(ctx.memoryMd, "# memory.md content\nworld");
      // 排序保证多机一致:alpha < beta
      assert.deepEqual(ctx.skills, [
        { name: "alpha", description: "first skill" },
        { name: "beta", description: "second skill" },
      ]);
      assert.ok(ctx.volumeMtime instanceof Date);
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });

  test("LOCAL.2 volume 根整个不存在 → 返 null", async () => {
    const base = await mkTmpVolumeBase();
    try {
      const reader = makeLocalVolumeReader({ volumeBaseDir: base });
      const ctx = await reader.read(999n);
      assert.equal(ctx, null);
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });

  test("LOCAL.3 单文件 ENOENT(只缺 USER.md)→ 该字段空串,其它正常", async () => {
    const base = await mkTmpVolumeBase();
    try {
      await writeUserVolume(base, 200n, {
        // 不写 USER.md
        memoryMd: "memory only",
      });
      const reader = makeLocalVolumeReader({ volumeBaseDir: base });
      const ctx = await reader.read(200n);
      assert.ok(ctx);
      assert.equal(ctx.userMd, "");
      assert.equal(ctx.memoryMd, "memory only");
      assert.deepEqual(ctx.skills, []);
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });

  test("LOCAL.4 USER.md 超过 256 KiB → 截断到 cap", async () => {
    const base = await mkTmpVolumeBase();
    try {
      const huge = "A".repeat(300 * 1024); // 300 KiB,超 cap 44 KiB
      await writeUserVolume(base, 300n, { userMd: huge });
      const reader = makeLocalVolumeReader({ volumeBaseDir: base });
      const ctx = await reader.read(300n);
      assert.ok(ctx);
      // FILE_CAP_BYTES = 256 * 1024
      assert.equal(ctx.userMd.length, 256 * 1024);
      // 截断的部分一定是全 'A'(因为我们写的就是 'A' 重复)
      assert.ok(ctx.userMd.split("").every((c) => c === "A"));
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });
});

// ─── REMOTE ─────────────────────────────────────────────────────────────

/**
 * 造一个最小合法的 NodeAgentTarget;psk 用确定长度 buffer,
 * 让 REMOTE.5 能精确断言 fill(0)。
 */
function makeFakeTarget(opts: { psk?: Buffer } = {}): NodeAgentTarget {
  return {
    hostId: "host-uuid-fake",
    host: "10.0.0.1",
    agentPort: 9443,
    expectedFingerprint: null,
    psk: opts.psk ?? null,
  };
}

/** ComputeHostRow stub — REMOTE 测试只关心 `toTarget` 工作流,row 内容由 `toTarget` 自己消化。 */
const fakeRow = {} as ComputeHostRow;

describe("makeRemoteVolumeReader — rpc/toTarget hook 注入", () => {
  test("REMOTE.1 happy path:rpc 成功返回 → 映射到 PlatformContext", async () => {
    let called = false;
    const fakeResp: PlatformContextResponse = {
      userMd: "remote user.md",
      memoryMd: "remote memory.md",
      skills: [{ name: "remote-skill", description: "x" }],
      volumeMtime: "2026-05-21T12:34:56.789Z",
    };
    const target = makeFakeTarget();
    const reader = makeRemoteVolumeReader({
      loadHostRow: async () => fakeRow,
      hostUuid: "host-uuid",
      toTarget: () => target,
      rpc: async (t, uid) => {
        called = true;
        assert.equal(t, target);
        assert.equal(uid, 42n);
        return fakeResp;
      },
    });
    const ctx = await reader.read(42n);
    assert.ok(called);
    assert.ok(ctx);
    assert.equal(ctx.userMd, "remote user.md");
    assert.equal(ctx.memoryMd, "remote memory.md");
    assert.deepEqual(ctx.skills, [{ name: "remote-skill", description: "x" }]);
    assert.equal(ctx.volumeMtime?.toISOString(), "2026-05-21T12:34:56.789Z");
  });

  test("REMOTE.2 AgentAppError 404 → 返 null(volume 不存在路径)", async () => {
    const reader = makeRemoteVolumeReader({
      loadHostRow: async () => fakeRow,
      hostUuid: "host-uuid",
      toTarget: () => makeFakeTarget(),
      rpc: async () => {
        throw new AgentAppError("host-uuid", 404, "VOLUME_NOT_FOUND", "no volume");
      },
    });
    const ctx = await reader.read(50n);
    assert.equal(ctx, null);
  });

  test("REMOTE.3 网络错(generic Error)→ rethrow,reader 不静默", async () => {
    const reader = makeRemoteVolumeReader({
      loadHostRow: async () => fakeRow,
      hostUuid: "host-uuid",
      toTarget: () => makeFakeTarget(),
      rpc: async () => {
        throw new Error("ECONNRESET socket reset");
      },
    });
    await assert.rejects(() => reader.read(51n), /ECONNRESET/);
  });

  test("REMOTE.4 AgentAppError 500 → rethrow(非 404 不吞)", async () => {
    const reader = makeRemoteVolumeReader({
      loadHostRow: async () => fakeRow,
      hostUuid: "host-uuid",
      toTarget: () => makeFakeTarget(),
      rpc: async () => {
        throw new AgentAppError("host-uuid", 500, "INTERNAL", "node-agent 5xx");
      },
    });
    await assert.rejects(() => reader.read(52n), /node-agent 5xx/);
  });

  test("REMOTE.5 安全 invariant:返回前 psk.fill(0) 清零(无论成功 / 404 / throw)", async () => {
    // 三条路径分别验:成功、404、throw,psk 全部应清零
    for (const scenario of [
      "success" as const,
      "notFound" as const,
      "errorThrow" as const,
    ]) {
      const pskLen = 32;
      const psk = Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"); // 长度 32
      assert.equal(psk.length, pskLen);
      // 预校验:psk 进 reader 前不应已是全 0
      assert.notDeepEqual(psk, Buffer.alloc(pskLen));

      const target = makeFakeTarget({ psk });
      const reader = makeRemoteVolumeReader({
        loadHostRow: async () => fakeRow,
        hostUuid: "host-uuid",
        toTarget: () => target,
        rpc:
          scenario === "success"
            ? async () => ({
                userMd: "",
                memoryMd: "",
                skills: [],
                volumeMtime: null,
              })
            : scenario === "notFound"
              ? async () => {
                  throw new AgentAppError("host-uuid", 404, "VOLUME_NOT_FOUND", "x");
                }
              : async () => {
                  throw new Error("network down");
                },
      });
      try {
        await reader.read(60n);
      } catch {
        // errorThrow 路径会 rethrow,吞掉看后面 finally 是否真的清零
      }
      assert.deepEqual(
        psk,
        Buffer.alloc(pskLen),
        `psk must be zeroed in finally — scenario=${scenario}`,
      );
    }
  });

  test("REMOTE.6 loadHostRow 返 null → 抛错(数据库一致性异常)", async () => {
    const reader = makeRemoteVolumeReader({
      loadHostRow: async () => null,
      hostUuid: "host-uuid-missing",
      toTarget: () => makeFakeTarget(),
      rpc: async () => {
        throw new Error("should not reach rpc");
      },
    });
    await assert.rejects(
      () => reader.read(99n),
      /host-uuid-missing not found in compute_hosts/,
    );
  });
});

// ─── ROUTING ────────────────────────────────────────────────────────────

/** local/remote stub readers — 显式记录调用,断言路由命中正确实现。 */
function makeRecordingReader(
  label: string,
  result: Awaited<ReturnType<VolumeContextReader["read"]>> | "throw",
): VolumeContextReader & { calls: bigint[] } {
  const calls: bigint[] = [];
  const reader: VolumeContextReader = {
    async read(uid) {
      calls.push(uid);
      if (result === "throw") {
        throw new Error(`${label} should not be called`);
      }
      return result;
    },
  };
  return Object.assign(reader, { calls });
}

const selfHostStub = { id: "self-host-uuid" } as ComputeHostRow;

describe("makeRoutingVolumeReader — 调度路径", () => {
  test("ROUTING.1 host === self → 走 local reader", async () => {
    const local = makeRecordingReader("local", {
      userMd: "",
      memoryMd: "",
      skills: [],
      volumeMtime: null,
    });
    const remote = makeRecordingReader("remote", "throw");
    const reader = makeRoutingVolumeReader({
      local,
      makeRemote: () => remote,
      findUserDataHost: async () => ({
        hostUuid: "self-host-uuid",
        hostStatus: "ready" as ComputeHostStatus,
        containerId: 1,
        containerState: "active" as const,
      }),
      getSelfHost: async () => selfHostStub,
    });
    const ctx = await reader.read(70n);
    assert.deepEqual(local.calls, [70n]);
    assert.deepEqual(remote.calls, []);
    assert.ok(ctx);
  });

  test("ROUTING.2 host !== self → makeRemote(hostUuid) 现造 remote reader", async () => {
    const local = makeRecordingReader("local", "throw");
    const remote = makeRecordingReader("remote", {
      userMd: "remote",
      memoryMd: "",
      skills: [],
      volumeMtime: null,
    });
    let makeRemoteCalled: string | null = null;
    const reader = makeRoutingVolumeReader({
      local,
      makeRemote: (hostUuid) => {
        makeRemoteCalled = hostUuid;
        return remote;
      },
      findUserDataHost: async () => ({
        hostUuid: "other-host-uuid",
        hostStatus: "ready" as ComputeHostStatus,
        containerId: 1,
        containerState: "active" as const,
      }),
      getSelfHost: async () => selfHostStub,
    });
    const ctx = await reader.read(71n);
    assert.equal(makeRemoteCalled, "other-host-uuid");
    assert.deepEqual(remote.calls, [71n]);
    assert.deepEqual(local.calls, []);
    assert.equal(ctx?.userMd, "remote");
  });

  test("ROUTING.3 findUserDataHost 返 null → 不走任何 reader,直接 null", async () => {
    const local = makeRecordingReader("local", "throw");
    const remote = makeRecordingReader("remote", "throw");
    const reader = makeRoutingVolumeReader({
      local,
      makeRemote: () => remote,
      findUserDataHost: async () => null,
      getSelfHost: async () => selfHostStub,
    });
    const ctx = await reader.read(72n);
    assert.equal(ctx, null);
    assert.deepEqual(local.calls, []);
    assert.deepEqual(remote.calls, []);
  });

  test("ROUTING.4 selfHost 只查一次(cache 命中)— 多次 read 不重复 getSelfHost", async () => {
    const local = makeRecordingReader("local", {
      userMd: "",
      memoryMd: "",
      skills: [],
      volumeMtime: null,
    });
    let getSelfCalls = 0;
    const reader = makeRoutingVolumeReader({
      local,
      makeRemote: () => makeRecordingReader("remote", "throw"),
      findUserDataHost: async () => ({
        hostUuid: "self-host-uuid",
        hostStatus: "ready" as ComputeHostStatus,
        containerId: 1,
        containerState: "active" as const,
      }),
      getSelfHost: async () => {
        getSelfCalls += 1;
        return selfHostStub;
      },
    });
    await reader.read(80n);
    await reader.read(81n);
    await reader.read(82n);
    assert.equal(getSelfCalls, 1);
  });
});
