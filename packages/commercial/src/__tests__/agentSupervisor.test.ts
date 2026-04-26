import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  containerNameFor,
  createContainer,
  stopContainer,
  removeContainer,
  getContainerStatus,
  ensureUserVolumes,
  volumeNamesFor,
  SupervisorError,
} from "../agent-sandbox/index.js";
import type Docker from "dockerode";

// T-52:每个 createContainer 调用会 mkdir `${rpcSocketHostDir}/u{uid}`。
// 所有用例共用一个 tmp root,after 统一清理。
let rpcRoot: string;
before(() => {
  rpcRoot = mkdtempSync(join(tmpdir(), "agent-rpc-ut-"));
});
after(() => {
  if (rpcRoot && existsSync(rpcRoot)) {
    try { rmSync(rpcRoot, { recursive: true, force: true }); } catch { /* */ }
  }
});

/**
 * Supervisor 单测:用一个极简的 Docker mock,捕获 createContainer 传给 docker
 * 的参数,断言 05-SEC §13 的所有硬约束都被设上。
 *
 * 这层测试不验证 docker daemon 的行为(那是 integ 的事),只验证"我们告诉
 * docker 的内容是对的"—— 即:限额正确、Cap 清空、tmpfs 规范、代理 env 注入等。
 */

// ------------------------------------------------------------
//  Mock docker 工厂
// ------------------------------------------------------------

type Captured = {
  createNetwork?: Parameters<Docker["createNetwork"]>[0];
  inspectNetwork?: { name: string };
  createVolumes: Array<{ name: string; labels: Record<string, string> }>;
  createContainer?: Parameters<Docker["createContainer"]>[0];
  started: boolean;
  stopped: boolean;
  removed: boolean;
};

type Behavior = {
  networkMissing?: boolean;
  imageMissing?: boolean;
  startFails?: boolean;
  inspectResult?: Partial<Awaited<ReturnType<ReturnType<Docker["getContainer"]>["inspect"]>>>;
  inspectMissing?: boolean;
  stopAlreadyStopped?: boolean;
  stopContainerMissing?: boolean;
};

function httpError(statusCode: number, message: string): Error {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}

function makeDocker(behavior: Behavior = {}): { docker: Docker; captured: Captured } {
  const captured: Captured = { createVolumes: [], started: false, stopped: false, removed: false };

  const networkInspect = async () => {
    if (behavior.networkMissing) throw httpError(404, "network not found");
    // existing network must carry the managed label, otherwise ensureAgentNetwork refuses
    return {
      Driver: "bridge",
      Labels: { "com.openclaude.managed": "1" },
    } as unknown as Awaited<ReturnType<ReturnType<Docker["getNetwork"]>["inspect"]>>;
  };

  const getNetwork = (_name: string) => ({ inspect: networkInspect }) as unknown as ReturnType<Docker["getNetwork"]>;
  const createNetwork = async (opts: Parameters<Docker["createNetwork"]>[0]) => {
    captured.createNetwork = opts;
    return {} as Awaited<ReturnType<Docker["createNetwork"]>>;
  };
  const createVolume = async (opts: { Name?: string; Labels?: Record<string, string> }) => {
    captured.createVolumes.push({ name: opts.Name!, labels: opts.Labels ?? {} });
    return {} as Awaited<ReturnType<Docker["createVolume"]>>;
  };

  // getVolume(name).inspect(): mirror back whatever labels we were asked to create,
  // so assertUserVolumes' fresh-create path passes without extra state.
  const getVolume = (name: string) => ({
    inspect: async () => {
      const entry = captured.createVolumes.find((v) => v.name === name);
      if (!entry) throw httpError(404, "no such volume");
      return {
        Name: name,
        Driver: "local",
        Labels: entry.labels,
      } as unknown as Awaited<ReturnType<ReturnType<Docker["getVolume"]>["inspect"]>>;
    },
    remove: async () => {
      // used by removeUserVolumes; no-op for unit tests
    },
  });

  const containerStart = async () => {
    if (behavior.startFails) throw httpError(500, "start failed");
    captured.started = true;
  };
  const containerRemove = async () => {
    captured.removed = true;
  };
  const containerStop = async () => {
    if (behavior.stopContainerMissing) throw httpError(404, "not found");
    if (behavior.stopAlreadyStopped) throw httpError(304, "already stopped");
    captured.stopped = true;
  };
  const containerInspect = async () => {
    if (behavior.inspectMissing) throw httpError(404, "no such container");
    return {
      Id: "abc123",
      State: { Running: true, Status: "running", ExitCode: 0, StartedAt: "2026-04-17T00:00:00Z" },
      ...behavior.inspectResult,
    } as Awaited<ReturnType<ReturnType<Docker["getContainer"]>["inspect"]>>;
  };

  const createContainerFn = async (opts: Parameters<Docker["createContainer"]>[0]) => {
    if (behavior.imageMissing) throw httpError(404, "No such image: bad:latest");
    captured.createContainer = opts;
    return {
      id: "abc123",
      start: containerStart,
      remove: containerRemove,
    } as unknown as Awaited<ReturnType<Docker["createContainer"]>>;
  };

  const getContainer = (_name: string) =>
    ({
      inspect: containerInspect,
      stop: containerStop,
      remove: containerRemove,
    }) as unknown as ReturnType<Docker["getContainer"]>;

  const docker = {
    getNetwork,
    createNetwork,
    createVolume,
    getVolume: getVolume as unknown as Docker["getVolume"],
    createContainer: createContainerFn,
    getContainer,
  } as unknown as Docker;

  return { docker, captured };
}

/**
 * createContainer 的默认必填参数。每个用例按需覆盖 proxyUrl / seccompProfileJson。
 * 把这两项抽出来避免每个 test 都写一长串。
 */
const DEFAULT_PROXY_URL = "http://proxy:3128";
const DEFAULT_SECCOMP = JSON.stringify({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [] });
function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    image: "openclaude/agent-runtime:latest",
    network: "agent-net",
    proxyUrl: DEFAULT_PROXY_URL,
    seccompProfileJson: DEFAULT_SECCOMP,
    rpcSocketHostDir: rpcRoot,
    ...overrides,
  } as Parameters<typeof createContainer>[2];
}

// ------------------------------------------------------------
//  纯函数
// ------------------------------------------------------------

describe("containerNameFor", () => {
  test("uid → container name", () => {
    assert.equal(containerNameFor(1), "agent-u1");
    assert.equal(containerNameFor(42), "agent-u42");
  });
  test("rejects non-positive / non-int uid", () => {
    assert.throws(() => containerNameFor(0), SupervisorError);
    assert.throws(() => containerNameFor(-1), SupervisorError);
    assert.throws(() => containerNameFor(1.5), SupervisorError);
    assert.throws(() => containerNameFor(Number.NaN), SupervisorError);
  });
});

describe("volumeNamesFor", () => {
  test("returns pair", () => {
    assert.deepEqual(volumeNamesFor(7), { workspace: "agent-u7-workspace", home: "agent-u7-home" });
  });
  test("rejects invalid uid", () => {
    assert.throws(() => volumeNamesFor(0));
    assert.throws(() => volumeNamesFor(-5));
  });
});

// ------------------------------------------------------------
//  createContainer 参数契约
// ------------------------------------------------------------

describe("createContainer", () => {
  test("produces 05-SEC §13 compliant HostConfig", async () => {
    const { docker, captured } = makeDocker();
    const result = await createContainer(docker, 42, baseOpts());

    assert.equal(result.name, "agent-u42");
    assert.equal(result.id, "abc123");
    // T-52:rpcSocketPath 应指向 `${rpcRoot}/u42/agent.sock`
    assert.equal(result.rpcSocketPath, join(rpcRoot, "u42", "agent.sock"));
    // 而且 host 子目录应已被 mkdir 出来(chown 可能 best-effort 失败,忽略 mode)
    assert.ok(existsSync(join(rpcRoot, "u42")), "u42 host dir should exist");
    assert.ok(statSync(join(rpcRoot, "u42")).isDirectory());
    // 默认值对齐 01-SPEC F-5.2 / 05-SEC §13
    assert.equal(result.limits.memoryBytes, 384 * 1024 * 1024);
    assert.equal(result.limits.nanoCpus, 200_000_000);
    assert.equal(result.limits.pidsLimit, 200);
    assert.equal(result.limits.tmpfsTmpBytes, 64 * 1024 * 1024);
    assert.equal(captured.started, true);

    // 断言 volume 预创建
    assert.deepEqual(
      captured.createVolumes.map((v) => v.name).sort(),
      ["agent-u42-home", "agent-u42-workspace"],
    );

    const opts = captured.createContainer!;
    assert.equal(opts.name, "agent-u42");
    assert.equal(opts.Image, "openclaude/agent-runtime:latest");
    // 非 root 运行(supervisor 层强制,不信镜像)
    assert.equal(opts.User, "1000:1000");

    // Env
    const env = opts.Env ?? [];
    assert.ok(env.includes("OC_UID=42"));
    assert.ok(env.includes(`HTTP_PROXY=${DEFAULT_PROXY_URL}`));
    assert.ok(env.includes(`HTTPS_PROXY=${DEFAULT_PROXY_URL}`));
    assert.ok(env.some((e) => e.startsWith("NO_PROXY=")));
    // 商用版容器必须默认跳过 personal-version 自反思 cron(否则用户没说话也每天扣 ~¥2-3)。
    // 处理逻辑见 packages/gateway/src/cron.ts::ensureCronFile。
    assert.ok(env.includes("OC_SEED_DEFAULT_CRON=0"));

    const hc = opts.HostConfig!;
    // 资源限额
    assert.equal(hc.Memory, 384 * 1024 * 1024);
    assert.equal(hc.MemorySwap, 384 * 1024 * 1024, "MemorySwap must equal Memory to disable swap");
    assert.equal(hc.MemorySwappiness, 0);
    assert.equal(hc.NanoCpus, 200_000_000);
    assert.equal(hc.PidsLimit, 200);
    // 安全
    assert.deepEqual(hc.CapDrop, ["ALL"]);
    assert.deepEqual(hc.CapAdd, []);
    // SecurityOpt 必含 no-new-privileges + seccomp=<custom profile>
    const so: string[] = hc.SecurityOpt ?? [];
    assert.ok(so.includes("no-new-privileges"));
    assert.ok(so.some((s) => s.startsWith("seccomp=")));
    assert.equal(hc.ReadonlyRootfs, true);
    assert.equal(hc.Privileged, false);
    // tmpfs /tmp 限 64M + nosuid/nodev/noexec
    const tmp = (hc.Tmpfs ?? {})["/tmp"];
    assert.match(tmp, /nosuid/);
    assert.match(tmp, /nodev/);
    assert.match(tmp, /noexec/);
    assert.match(tmp, /size=67108864/);
    // Binds:workspace → /workspace, home → /root(01-SPEC F-5.4 + 05-SEC §13)
    //  + T-52 新增:host/u42 → /var/run/agent-rpc(RPC socket)
    const binds = (hc.Binds ?? []).slice().sort();
    assert.deepEqual(
      binds,
      [
        "agent-u42-home:/root:rw",
        "agent-u42-workspace:/workspace:rw",
        `${join(rpcRoot, "u42")}:/var/run/agent-rpc:rw`,
      ].sort(),
    );
    // 断一下字符串格式有 `:/var/run/agent-rpc:rw` 这一段(回归保护:别改成 ro)
    assert.ok(
      (hc.Binds ?? []).some((b) => b.endsWith(":/var/run/agent-rpc:rw")),
      "Binds must include RPC socket dir bind-mounted rw at /var/run/agent-rpc",
    );
    // 网络
    assert.equal(hc.NetworkMode, "agent-net");
    assert.deepEqual(Object.keys(opts.NetworkingConfig?.EndpointsConfig ?? {}), ["agent-net"]);
    // 重启策略
    assert.equal(hc.RestartPolicy?.Name, "no");
  });

  test("rejects docker built-in network names (bridge/host/none/default)", async () => {
    const { docker } = makeDocker();
    for (const n of ["bridge", "host", "none", "default"]) {
      await assert.rejects(
        createContainer(docker, 1, baseOpts({ network: n })),
        (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
        `expected InvalidArgument for network=${n}`,
      );
    }
  });

  test("existing network without managed label is rejected", async () => {
    const { docker } = makeDocker();
    // 覆写 getNetwork.inspect 返回无 label 的 bridge
    (docker as unknown as { getNetwork: (n: string) => { inspect: () => Promise<unknown> } }).getNetwork = () => ({
      inspect: async () => ({ Driver: "bridge", Labels: {} }),
    });
    await assert.rejects(
      createContainer(docker, 1, baseOpts()),
      /not managed by openclaude/,
    );
  });

  test("existing network with Attachable/Internal/EnableIPv6 is rejected even with label", async () => {
    // 仿造完整 label 但把 Attachable=true 打开 → 等于 swarm service 可以挂进来
    for (const bad of [
      { Attachable: true, expected: /Attachable=true/ },
      { Internal: true, expected: /Internal=true/ },
      { EnableIPv6: true, expected: /EnableIPv6=true/ },
    ]) {
      const { docker } = makeDocker();
      (docker as unknown as { getNetwork: (n: string) => { inspect: () => Promise<unknown> } }).getNetwork = () => ({
        inspect: async () => ({
          Driver: "bridge",
          Labels: { "com.openclaude.managed": "1" },
          ...bad,
        }),
      });
      await assert.rejects(createContainer(docker, 1, baseOpts()), bad.expected);
    }
  });

  test("seccompProfileJson required (fail closed per 05-SEC §13)", async () => {
    const { docker } = makeDocker();
    await assert.rejects(
      createContainer(docker, 1, baseOpts({ seccompProfileJson: undefined })),
      (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
    );
  });

  test("rpcSocketHostDir rejects empty / undefined / relative / root / '..'", async () => {
    const { docker } = makeDocker();
    for (const bad of [undefined, "", "  ", "relative/dir", "./x", "../x", "/",
                       "/etc/../root", "/foo/../bar"]) {
      await assert.rejects(
        createContainer(docker, 1, baseOpts({ rpcSocketHostDir: bad })),
        (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
        `expected rejection for rpcSocketHostDir=${JSON.stringify(bad)}`,
      );
    }
  });

  test("rpcSocketPath points to per-uid subdir", async () => {
    const { docker } = makeDocker();
    const r = await createContainer(docker, 77, baseOpts());
    assert.equal(r.rpcSocketPath, join(rpcRoot, "u77", "agent.sock"));
    // u77 子目录已建,agent.sock 还没(容器内 RPC server 起来后才出现)
    assert.ok(existsSync(join(rpcRoot, "u77")));
  });

  test("proxyUrl required (fail closed per 05-SEC §13)", async () => {
    const { docker } = makeDocker();
    await assert.rejects(
      createContainer(docker, 1, baseOpts({ proxyUrl: undefined })),
      (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
    );
    await assert.rejects(
      createContainer(docker, 1, baseOpts({ proxyUrl: "" })),
      (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
    );
  });

  test("seccompProfileJson refuses unconfined / empty / invalid JSON / array", async () => {
    const { docker } = makeDocker();
    for (const bad of ["unconfined", "not json", "[]", "null"]) {
      await assert.rejects(
        createContainer(docker, 1, baseOpts({ seccompProfileJson: bad })),
        (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
        `expected rejection for seccompProfileJson=${bad}`,
      );
    }
  });

  test("seccompProfileJson refuses allow-default + empty syscalls (effectively unconfined)", async () => {
    const { docker } = makeDocker();
    // 这是 Round 2 集成测试曾经用过的"看起来像 JSON 但实际等于关掉 seccomp"的典型配置。
    const allowAll = JSON.stringify({ defaultAction: "SCMP_ACT_ALLOW", syscalls: [] });
    await assert.rejects(
      createContainer(docker, 1, baseOpts({ seccompProfileJson: allowAll })),
      (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
    );
    // 同样,没有 syscalls 字段也应被拒
    const allowDefaultOnly = JSON.stringify({ defaultAction: "SCMP_ACT_ALLOW" });
    await assert.rejects(
      createContainer(docker, 1, baseOpts({ seccompProfileJson: allowDefaultOnly })),
      (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
    );
    // 但 allow-default + 非空 syscalls(典型用法:allow 大多数,显式 deny 危险 syscall)应被接受
    const allowWithDenies = JSON.stringify({
      defaultAction: "SCMP_ACT_ALLOW",
      syscalls: [{ names: ["reboot"], action: "SCMP_ACT_ERRNO" }],
    });
    await createContainer(docker, 1, baseOpts({ seccompProfileJson: allowWithDenies }));
  });

  test("seccompProfileJson refuses allow-default + syscalls without any deny rule", async () => {
    const { docker } = makeDocker();
    // 即使 syscalls 非空,只要没有 deny 动作,也是观测模式/等同 unconfined,必须拒绝。
    const allowOnly = JSON.stringify({
      defaultAction: "SCMP_ACT_ALLOW",
      syscalls: [{ names: ["getpid"], action: "SCMP_ACT_ALLOW" }],
    });
    await assert.rejects(
      createContainer(docker, 1, baseOpts({ seccompProfileJson: allowOnly })),
      (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
    );
    const logOnly = JSON.stringify({
      defaultAction: "SCMP_ACT_LOG",
      syscalls: [{ names: ["getpid"], action: "SCMP_ACT_LOG" }],
    });
    await assert.rejects(
      createContainer(docker, 1, baseOpts({ seccompProfileJson: logOnly })),
      (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
    );
    // KILL 动作也是 deny,应放行
    const allowWithKill = JSON.stringify({
      defaultAction: "SCMP_ACT_ALLOW",
      syscalls: [{ names: ["kexec_load"], action: "SCMP_ACT_KILL" }],
    });
    await createContainer(docker, 1, baseOpts({ seccompProfileJson: allowWithKill }));
  });

  test("seccompProfileJson requires defaultAction field", async () => {
    const { docker } = makeDocker();
    const noAction = JSON.stringify({ syscalls: [] });
    await assert.rejects(
      createContainer(docker, 1, baseOpts({ seccompProfileJson: noAction })),
      (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
    );
  });

  test("creates agent-net when missing", async () => {
    const { docker, captured } = makeDocker({ networkMissing: true });
    await createContainer(docker, 1, baseOpts());
    assert.ok(captured.createNetwork, "createNetwork must be called when inspect 404");
    assert.equal(captured.createNetwork?.Name, "agent-net");
    assert.equal(captured.createNetwork?.Driver, "bridge");
  });

  test("accepts opts.extraEnv but rejects OC_-prefixed keys", async () => {
    const { docker, captured } = makeDocker();
    await createContainer(docker, 1, baseOpts({ extraEnv: { FOO: "bar" } }));
    assert.ok((captured.createContainer?.Env ?? []).includes("FOO=bar"));

    await assert.rejects(
      createContainer(docker, 1, baseOpts({ extraEnv: { OC_UID: "999" } })),
      (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
    );
    // invalid env key
    await assert.rejects(
      createContainer(docker, 1, baseOpts({ extraEnv: { "bad-key": "x" } })),
      SupervisorError,
    );
  });

  test("extraEnv cannot override or clear proxy env (fail-closed)", async () => {
    const { docker } = makeDocker();
    // 大写 / 小写 / NO_PROXY 都要挡住 —— 任何一个被"放进来"都可能绕过 T-51 代理白名单。
    for (const k of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
      "ALL_PROXY",
      "all_proxy",
    ]) {
      await assert.rejects(
        createContainer(docker, 1, baseOpts({ extraEnv: { [k]: "http://attacker:8080" } })),
        (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
        `expected rejection for extraEnv.${k}`,
      );
    }
  });

  test("supervisor proxy env comes after extraEnv (defense-in-depth: last write wins)", async () => {
    const { docker, captured } = makeDocker();
    await createContainer(docker, 1, baseOpts({ extraEnv: { FOO: "bar" } }));
    const env = captured.createContainer?.Env ?? [];
    const fooIdx = env.indexOf("FOO=bar");
    const httpProxyIdx = env.indexOf(`HTTP_PROXY=${DEFAULT_PROXY_URL}`);
    assert.ok(fooIdx >= 0, "FOO=bar should be present");
    assert.ok(httpProxyIdx >= 0, "HTTP_PROXY should be present");
    assert.ok(httpProxyIdx > fooIdx, "HTTP_PROXY must come after user extraEnv");
  });

  test("rejects non-positive memoryMb / cpus / pidsLimit", async () => {
    const { docker } = makeDocker();
    await assert.rejects(
      createContainer(docker, 1, baseOpts({ memoryMb: 0 })),
      (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
    );
    await assert.rejects(
      createContainer(docker, 1, baseOpts({ cpus: -0.1 })),
      (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
    );
    await assert.rejects(
      createContainer(docker, 1, baseOpts({ pidsLimit: 99999 })),
      (err: Error) => err instanceof SupervisorError && err.code === "InvalidArgument",
    );
  });

  test("image missing → ImageNotFound, not generic error", async () => {
    const { docker } = makeDocker({ imageMissing: true });
    await assert.rejects(
      createContainer(docker, 1, baseOpts({ image: "bad:latest" })),
      (err: Error) => err instanceof SupervisorError && err.code === "ImageNotFound",
    );
  });

  test("start failure rolls back the created container", async () => {
    const { docker, captured } = makeDocker({ startFails: true });
    await assert.rejects(
      createContainer(docker, 1, baseOpts()),
      SupervisorError,
    );
    // createContainer was called (we captured it) and remove was called as rollback
    assert.ok(captured.createContainer, "createContainer should have been invoked");
    assert.equal(captured.removed, true, "remove should be called after start failure to avoid leaks");
    assert.equal(captured.started, false);
  });
});

// ------------------------------------------------------------
//  stop / remove / getStatus
// ------------------------------------------------------------

describe("stopContainer / removeContainer / getContainerStatus", () => {
  test("stopContainer noop when missing", async () => {
    const { docker } = makeDocker({ stopContainerMissing: true });
    await stopContainer(docker, 42); // must not throw
  });

  test("stopContainer tolerates 304 (already stopped)", async () => {
    const { docker } = makeDocker({ stopAlreadyStopped: true });
    await stopContainer(docker, 42);
  });

  test("removeContainer is idempotent on 404", async () => {
    // 真实模拟 remove() 抛 404,验证 supervisor 吞掉
    const brokenDocker = {
      getContainer: () => ({
        remove: async () => {
          throw httpError(404, "no such container");
        },
      }),
    } as unknown as Docker;
    await removeContainer(brokenDocker, 42);
  });

  test("removeContainer propagates non-404 errors as SupervisorError", async () => {
    const brokenDocker = {
      getContainer: () => ({
        remove: async () => {
          throw httpError(500, "internal");
        },
      }),
    } as unknown as Docker;
    await assert.rejects(removeContainer(brokenDocker, 42), SupervisorError);
  });

  test("getContainerStatus returns running", async () => {
    const { docker } = makeDocker();
    const s = await getContainerStatus(docker, 42);
    assert.equal(s.state, "running");
    assert.equal(s.name, "agent-u42");
    assert.equal(s.id, "abc123");
  });

  test("getContainerStatus returns missing for 404", async () => {
    const { docker } = makeDocker({ inspectMissing: true });
    const s = await getContainerStatus(docker, 42);
    assert.equal(s.state, "missing");
    assert.equal(s.id, "");
    assert.equal(s.dockerStatus, null);
    assert.equal(s.exitCode, null);
    assert.equal(s.startedAt, null);
  });

  test("getContainerStatus stopped maps Running=false", async () => {
    const { docker } = makeDocker({
      inspectResult: {
        Id: "def456",
        // Cast via unknown — dockerode's State type requires ~10 fields, we only
        // need the 4 the supervisor reads. Keeping the mock minimal is clearer.
        State: {
          Running: false,
          Status: "exited",
          ExitCode: 137,
          StartedAt: "2026-04-17T00:00:00Z",
        } as unknown as Awaited<ReturnType<ReturnType<Docker["getContainer"]>["inspect"]>>["State"],
      },
    });
    const s = await getContainerStatus(docker, 1);
    assert.equal(s.state, "stopped");
    assert.equal(s.exitCode, 137);
    assert.equal(s.dockerStatus, "exited");
  });
});

// ------------------------------------------------------------
//  docker daemon 不可达 → DockerUnavailable
// ------------------------------------------------------------

describe("docker daemon unreachable", () => {
  for (const nodeCode of ["ENOENT", "EACCES", "ECONNREFUSED"] as const) {
    test(`${nodeCode} on socket → SupervisorError.DockerUnavailable`, async () => {
      const brokenDocker = {
        getNetwork: () => ({
          inspect: async () => {
            const e = new Error(nodeCode) as Error & { code: string };
            e.code = nodeCode;
            throw e;
          },
        }),
        createContainer: async () => {
          throw new Error("should not be reached");
        },
        createVolume: async () => {
          throw new Error("should not be reached");
        },
        createNetwork: async () => {
          throw new Error("should not be reached");
        },
        getContainer: () => ({
          inspect: async () => {
            const e = new Error(nodeCode) as Error & { code: string };
            e.code = nodeCode;
            throw e;
          },
        }),
      } as unknown as Docker;

      await assert.rejects(
        createContainer(brokenDocker, 1, baseOpts({ image: "i", network: "n" })),
        (err: Error) => err instanceof SupervisorError && err.code === "DockerUnavailable",
      );
      await assert.rejects(
        getContainerStatus(brokenDocker, 1),
        (err: Error) => err instanceof SupervisorError && err.code === "DockerUnavailable",
      );
    });
  }

});

// ------------------------------------------------------------
//  volumes (light unit checks — integ covers daemon behavior)
// ------------------------------------------------------------

describe("ensureUserVolumes labels", () => {
  test("labels every volume with managed/uid/purpose", async () => {
    const { docker, captured } = makeDocker();
    await ensureUserVolumes(docker, 7);
    const ws = captured.createVolumes.find((v) => v.name === "agent-u7-workspace")!;
    const home = captured.createVolumes.find((v) => v.name === "agent-u7-home")!;
    assert.equal(ws.labels["com.openclaude.managed"], "1");
    assert.equal(ws.labels["com.openclaude.uid"], "7");
    assert.equal(ws.labels["com.openclaude.purpose"], "workspace");
    assert.equal(home.labels["com.openclaude.purpose"], "home");
  });

  test("rejects existing volume with non-empty Options (bind/NFS shim)", async () => {
    // 仿造一个带 label 但 Options 指向 host 路径的 bind volume
    const docker = {
      createVolume: async (_opts: { Name?: string }) => ({}),
      getVolume: (name: string) => ({
        inspect: async () => ({
          Name: name,
          Driver: "local",
          Labels: {
            "com.openclaude.managed": "1",
            "com.openclaude.uid": "7",
            "com.openclaude.purpose": name.endsWith("workspace") ? "workspace" : "home",
          },
          Options: { type: "none", device: "/etc", o: "bind" },
        }),
      }),
    } as unknown as Docker;
    await assert.rejects(ensureUserVolumes(docker, 7), /custom Options/);
  });

  test("rejects existing volume with wrong driver (non-local)", async () => {
    const docker = {
      createVolume: async (_opts: { Name?: string }) => ({}),
      getVolume: (name: string) => ({
        inspect: async () => ({
          Name: name,
          Driver: "nfs",
          Labels: {
            "com.openclaude.managed": "1",
            "com.openclaude.uid": "7",
            "com.openclaude.purpose": name.endsWith("workspace") ? "workspace" : "home",
          },
        }),
      }),
    } as unknown as Docker;
    await assert.rejects(ensureUserVolumes(docker, 7), /driver=nfs/);
  });
});
