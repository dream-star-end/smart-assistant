/**
 * V3 D.5 — compute-pool/containerService.ts HostAwareContainerService 单测。
 *
 * 覆盖:
 *   - self host → LocalDockerBackend
 *   - 非 self host → RemoteNodeAgentBackend
 *   - getRow 缓存:同 hostId 第二次访问不再查 DB(60s 内)
 *   - invalidate(hostId) 后重新查 DB
 *   - resolveBaselinePaths 依 host 名选择不同 baseline 根路径
 *   - unknown hostId → SupervisorError("InvalidArgument")
 *
 * 不测的(归 integ / containerService.ts 的 backend 内部自测):
 *   - 真实 docker 行为(LocalDockerBackend 内部调 dockerode)
 *   - 真实 mTLS + nodeAgentClient http 调用
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";

import {
  HostAwareContainerService,
  type ContainerService,
  type ContainerSpec,
  type ContainerInspect,
} from "../compute-pool/containerService.js";
import { SupervisorError } from "../agent-sandbox/types.js";
import type { ComputeHostRow, ComputeHostStatus } from "../compute-pool/types.js";
import { setPoolOverride, resetPool } from "../db/index.js";

// ───────────────────────────────────────────────────────────────────────
//  FakePool — 只处理 getHostById(containerService.getRow 唯一用到的 SQL)
// ───────────────────────────────────────────────────────────────────────

class FakePool {
  hosts: ComputeHostRow[] = [];
  queryCount = 0;
  addHost(h: ComputeHostRow): void { this.hosts.push(h); }
  async end(): Promise<void> {}
  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    this.queryCount++;
    const s = sql.trim();
    if (/FROM compute_hosts\s+WHERE id = \$1\s+LIMIT 1/.test(s)) {
      const id = params[0] as string;
      const row = this.hosts.find((h) => h.id === id) ?? null;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    throw new Error(`FakePool: unhandled SQL:\n${s}`);
  }
}

function mkHost(id: string, name: string, status: ComputeHostStatus = "ready"): ComputeHostRow {
  const now = new Date();
  return {
    id, name, host: `${name}.ex`, ssh_port: 22, ssh_user: "root", agent_port: 9443,
    ssh_password_nonce: null, ssh_password_ct: null, ssh_fingerprint: null,
    agent_psk_nonce: null, agent_psk_ct: null,
    agent_cert_pem: null, agent_cert_fingerprint_sha256: null,
    agent_cert_not_before: null, agent_cert_not_after: null,
    status, last_bootstrap_at: null, last_bootstrap_err: null,
    last_health_at: null, last_health_ok: null, last_health_err: null,
    consecutive_health_fail: 0, consecutive_health_ok: 0,
    max_containers: 20, created_at: now, updated_at: now,
  } as unknown as ComputeHostRow;
}

// ───────────────────────────────────────────────────────────────────────
//  Fake backends —— 记录调用目标以验证路由
// ───────────────────────────────────────────────────────────────────────

interface Call { method: string; hostId?: string; name?: string; cid?: string; }

function makeLocalFake(): {
  backend: {
    ensureVolume: (name: string) => Promise<void>;
    removeVolume: (name: string) => Promise<void>;
    inspectVolume: (name: string) => Promise<{ exists: boolean }>;
    createAndStart: (spec: ContainerSpec) => Promise<{ containerInternalId: string }>;
    stop: (cid: string) => Promise<void>;
    remove: (cid: string) => Promise<void>;
    inspect: (cid: string) => Promise<ContainerInspect>;
  };
  calls: Call[];
} {
  const calls: Call[] = [];
  const backend = {
    async ensureVolume(name: string) { calls.push({ method: "local.ensureVolume", name }); },
    async removeVolume(name: string) { calls.push({ method: "local.removeVolume", name }); },
    async inspectVolume(name: string) { calls.push({ method: "local.inspectVolume", name }); return { exists: true }; },
    async createAndStart(_spec: ContainerSpec) { calls.push({ method: "local.createAndStart" }); return { containerInternalId: "local-cid" }; },
    async stop(cid: string) { calls.push({ method: "local.stop", cid }); },
    async remove(cid: string) { calls.push({ method: "local.remove", cid }); },
    async inspect(cid: string): Promise<ContainerInspect> {
      calls.push({ method: "local.inspect", cid });
      return { Id: cid, State: { Status: "running", Running: true, ExitCode: 0 } } as unknown as ContainerInspect;
    },
  };
  return { backend, calls };
}

function makeRemoteFake(): {
  backend: {
    ensureVolume: (hostId: string, name: string) => Promise<void>;
    removeVolume: (hostId: string, name: string) => Promise<void>;
    inspectVolume: (hostId: string, name: string) => Promise<{ exists: boolean }>;
    createAndStart: (hostId: string, spec: ContainerSpec) => Promise<{ containerInternalId: string }>;
    stop: (hostId: string, cid: string) => Promise<void>;
    remove: (hostId: string, cid: string) => Promise<void>;
    inspect: (hostId: string, cid: string) => Promise<ContainerInspect>;
  };
  calls: Call[];
} {
  const calls: Call[] = [];
  const backend = {
    async ensureVolume(hostId: string, name: string) { calls.push({ method: "remote.ensureVolume", hostId, name }); },
    async removeVolume(hostId: string, name: string) { calls.push({ method: "remote.removeVolume", hostId, name }); },
    async inspectVolume(hostId: string, name: string) { calls.push({ method: "remote.inspectVolume", hostId, name }); return { exists: true }; },
    async createAndStart(hostId: string, _spec: ContainerSpec) { calls.push({ method: "remote.createAndStart", hostId }); return { containerInternalId: "remote-cid" }; },
    async stop(hostId: string, cid: string) { calls.push({ method: "remote.stop", hostId, cid }); },
    async remove(hostId: string, cid: string) { calls.push({ method: "remote.remove", hostId, cid }); },
    async inspect(hostId: string, cid: string): Promise<ContainerInspect> {
      calls.push({ method: "remote.inspect", hostId, cid });
      return { Id: cid, State: { Status: "running", Running: true, ExitCode: 0 } } as unknown as ContainerInspect;
    },
  };
  return { backend, calls };
}

function makeSvc(fp: FakePool): { svc: ContainerService & HostAwareContainerService; local: Call[]; remote: Call[]; fp: FakePool } {
  const { backend: local, calls: localCalls } = makeLocalFake();
  const { backend: remote, calls: remoteCalls } = makeRemoteFake();
  // HostAwareContainerService 接受 LocalDockerBackend / RemoteNodeAgentBackend 实例;
  // 我们用 duck-typed fakes 强转 —— 只会调用在 backend 接口上声明的方法。
  const svc = new HostAwareContainerService(
    local as unknown as ConstructorParameters<typeof HostAwareContainerService>[0],
    remote as unknown as ConstructorParameters<typeof HostAwareContainerService>[1],
  );
  return { svc, local: localCalls, remote: remoteCalls, fp };
}

const SPEC_STUB: ContainerSpec = {
  name: "oc-v3-user-1",
  userId: 1,
  imageRef: "ccb:test",
  boundIp: "172.30.0.10",
  secretPlaintext: "s".repeat(32),
  memoryMB: 768,
  cpuQuota: 100000,
  pidsLimit: 256,
  ulimitNoFileSoft: 1024,
  ulimitNoFileHard: 2048,
  volumeMounts: [],
  env: {},
} as unknown as ContainerSpec;

// ───────────────────────────────────────────────────────────────────────

describe("HostAwareContainerService routing", () => {
  let fp: FakePool;
  beforeEach(() => {
    fp = new FakePool();
    fp.addHost(mkHost("self-id", "self"));
    fp.addHost(mkHost("tk-id", "tk-01"));
    setPoolOverride(fp as unknown as Pool);
  });
  afterEach(async () => { await resetPool(); });

  test("self host dispatches to local backend", async () => {
    const { svc, local, remote } = makeSvc(fp);
    await svc.ensureVolume("self-id", "oc-v3-vol-u1");
    assert.equal(remote.length, 0);
    assert.equal(local.length, 1);
    assert.equal(local[0]!.method, "local.ensureVolume");
    assert.equal(local[0]!.name, "oc-v3-vol-u1");
  });

  test("non-self host dispatches to remote backend", async () => {
    const { svc, local, remote } = makeSvc(fp);
    await svc.ensureVolume("tk-id", "oc-v3-vol-u2");
    assert.equal(local.length, 0);
    assert.equal(remote.length, 1);
    assert.equal(remote[0]!.method, "remote.ensureVolume");
    assert.equal(remote[0]!.hostId, "tk-id");
  });

  test("host row cached across calls (single DB query for 3 ops on same host)", async () => {
    const { svc } = makeSvc(fp);
    await svc.ensureVolume("self-id", "a");
    await svc.ensureVolume("self-id", "b");
    await svc.removeVolume("self-id", "a");
    assert.equal(fp.queryCount, 1, `expected 1 DB query due to cache, got ${fp.queryCount}`);
  });

  test("invalidate(hostId) forces re-fetch", async () => {
    const { svc } = makeSvc(fp);
    await svc.ensureVolume("self-id", "a");
    svc.invalidate("self-id");
    await svc.ensureVolume("self-id", "b");
    assert.equal(fp.queryCount, 2);
  });

  test("createAndStart, stop, remove, inspect all route by host.name", async () => {
    const { svc, local, remote } = makeSvc(fp);
    await svc.createAndStart("tk-id", SPEC_STUB);
    await svc.stop("tk-id", "cid-1");
    await svc.remove("tk-id", "cid-1");
    await svc.inspect("tk-id", "cid-1");
    assert.equal(local.length, 0);
    assert.equal(remote.length, 4);
    assert.deepEqual(remote.map((c) => c.method), [
      "remote.createAndStart", "remote.stop", "remote.remove", "remote.inspect",
    ]);
  });

  test("unknown hostId throws SupervisorError('InvalidArgument')", async () => {
    const { svc } = makeSvc(fp);
    await assert.rejects(
      svc.ensureVolume("does-not-exist", "x"),
      (err: unknown) => err instanceof SupervisorError && err.code === "InvalidArgument",
    );
  });

  test("resolveBaselinePaths switches on host identity", async () => {
    const { svc } = makeSvc(fp);
    const p1 = await svc.resolveBaselinePaths("self-id");
    const p2 = await svc.resolveBaselinePaths("tk-id");
    assert.ok(p1.claudeMdHostPath.endsWith("CLAUDE.md"));
    assert.ok(p2.claudeMdHostPath.endsWith("CLAUDE.md"));
    assert.notEqual(p1.claudeMdHostPath, p2.claudeMdHostPath, "self and remote should use different baseline roots");
  });

  test("isRemote flag correct", async () => {
    const { svc } = makeSvc(fp);
    assert.equal(await svc.isRemote("self-id"), false);
    assert.equal(await svc.isRemote("tk-id"), true);
  });
});
