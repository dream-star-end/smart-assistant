import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import Docker from "dockerode";
import { statSync } from "node:fs";
import {
  createContainer,
  stopContainer,
  removeContainer,
  getContainerStatus,
  containerNameFor,
  volumeNamesFor,
  removeUserVolumes,
} from "../agent-sandbox/index.js";

/**
 * Agent supervisor integration tests.
 *
 * 运行前提:
 *   - `/var/run/docker.sock` 存在且当前进程可访问
 *   - docker daemon 里能拉到 `alpine:3.19`(或已本地缓存)
 *
 * 测试用 `alpine:3.19` 作为临时镜像代替 `openclaude/agent-runtime`,因为后者由
 * T-51 才构建;本 task 只验证 supervisor 把参数正确下发给 daemon。
 * alpine 里 `sleep infinity` 做永续进程,让容器保持 Running 以便 inspect。
 *
 * 容器名用高 uid(90000000 + Math.random(),每次独一)避免和开发机上其它容器名冲突。
 */

const TEST_IMAGE = process.env.AGENT_TEST_IMAGE ?? "alpine:3.19";
const TEST_NETWORK = "agent-net-test";

let dockerAvailable = false;
let docker: Docker | null = null;

function socketExists(): boolean {
  try {
    const s = statSync("/var/run/docker.sock");
    return s.isSocket();
  } catch {
    return false;
  }
}

async function imagePresent(d: Docker, image: string): Promise<boolean> {
  try {
    await d.getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}

async function pullImage(d: Docker, image: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    d.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      d.modem.followProgress(stream, (err2) => (err2 ? reject(err2) : resolve()));
    });
  });
}

let testUid: number;

before(async () => {
  if (!socketExists()) return;
  try {
    docker = new Docker();
    await docker.ping();
    if (!(await imagePresent(docker, TEST_IMAGE))) {
      await pullImage(docker, TEST_IMAGE);
    }
    dockerAvailable = true;
    testUid = 90_000_000 + Math.floor(Math.random() * 1_000_000);
  } catch (err) {
    // 拉镜像网络不通也算不可用,skip
    // eslint-disable-next-line no-console
    console.warn("[agentSupervisor.integ] docker unavailable:", (err as Error).message);
  }
});

function skipIfNoDocker(t: { skip: (reason: string) => void }): boolean {
  if (!dockerAvailable || !docker) {
    t.skip("docker daemon not available");
    return true;
  }
  return false;
}

async function cleanupContainer(uid: number): Promise<void> {
  if (!docker) return;
  try {
    await docker.getContainer(containerNameFor(uid)).remove({ force: true });
  } catch {
    /* ignore */
  }
  try {
    await removeUserVolumes(docker, uid);
  } catch {
    /* ignore */
  }
}

async function cleanupNetwork(): Promise<void> {
  if (!docker) return;
  try {
    await docker.getNetwork(TEST_NETWORK).remove();
  } catch {
    /* ignore 404 / in-use;留给下次测试 */
  }
}

after(async () => {
  if (!dockerAvailable) return;
  await cleanupContainer(testUid);
  // 额外清理过去可能遗留的 test uid(本测试如果中途崩)
  await cleanupNetwork();
});

describe("agent supervisor integ", () => {
  test("createContainer creates running container with §13 limits applied", async (t) => {
    if (skipIfNoDocker(t)) return;
    const d = docker!;
    const uid = testUid;
    await cleanupContainer(uid);

    const seccompProfile = JSON.stringify({
      // 测试用:defaultAction=ALLOW + 非空 syscalls(显式 deny reboot)。
      // 既满足 supervisor fail-closed 校验(非空 syscalls 表明 profile 有在"动"),
      // 又能让 alpine 容器正常启动 —— deny-default 会阻止 docker 建立 netns。
      // T-51 会落真正的 docker default.json 形式(default=ERRNO + 白名单)。
      defaultAction: "SCMP_ACT_ALLOW",
      syscalls: [{ names: ["reboot"], action: "SCMP_ACT_ERRNO" }],
    });
    const res = await createContainer(d, uid, {
      image: TEST_IMAGE,
      network: TEST_NETWORK,
      memoryMb: 64, // alpine 够用
      cpus: 0.25,
      pidsLimit: 50,
      tmpfsTmpMb: 16,
      extraEnv: { FOO: "bar" },
      proxyUrl: "http://proxy:3128",
      seccompProfileJson: seccompProfile,
      // alpine 镜像默认 CMD 是 ["/bin/sh"],没有 stdin 会立刻退出 —— 我们
      // 只看 inspect 里 supervisor 下发的参数,不看容器是否持续 Running。
    });
    assert.equal(res.name, `agent-u${uid}`);
    assert.equal(res.limits.memoryBytes, 64 * 1024 * 1024);
    assert.equal(res.limits.pidsLimit, 50);
    assert.equal(res.limits.nanoCpus, 250_000_000);

    const info = await d.getContainer(res.id).inspect();
    const hc = info.HostConfig;
    assert.equal(hc.Memory, 64 * 1024 * 1024);
    assert.equal(hc.MemorySwap, 64 * 1024 * 1024);
    assert.equal(hc.PidsLimit, 50);
    assert.equal(hc.NanoCpus, 250_000_000);
    assert.deepEqual(hc.CapDrop, ["ALL"]);
    assert.ok(hc.SecurityOpt?.some((s: string) => s === "no-new-privileges"));
    // seccomp 自定义白名单落到了 daemon
    assert.ok(hc.SecurityOpt?.some((s: string) => s.startsWith("seccomp=")));
    assert.equal(hc.ReadonlyRootfs, true);
    assert.equal(hc.Privileged, false);
    assert.equal(hc.NetworkMode, TEST_NETWORK);

    // 非 root 运行(05-SEC §13),在 Container.Config.User 可见
    assert.equal(info.Config.User, "1000:1000");

    // tmpfs 真正落到 daemon
    const tmp = (hc.Tmpfs ?? {})["/tmp"];
    assert.match(tmp ?? "", /noexec/);
    assert.match(tmp ?? "", /size=16777216/);

    const binds = hc.Binds ?? [];
    const vols = volumeNamesFor(uid);
    assert.ok(binds.some((b: string) => b.startsWith(`${vols.workspace}:/workspace`)));
    // home volume 挂到 /root,不是 /home/agent
    assert.ok(binds.some((b: string) => b.startsWith(`${vols.home}:/root`)));

    // Env FOO=bar 已注入
    assert.ok((info.Config.Env ?? []).includes("FOO=bar"));
    assert.ok((info.Config.Env ?? []).includes(`OC_UID=${uid}`));

    // Labels
    assert.equal(info.Config.Labels?.["com.openclaude.uid"], String(uid));
    assert.equal(info.Config.Labels?.["com.openclaude.managed"], "1");

    // 清理
    await cleanupContainer(uid);
  });

  test("reserved network names are rejected before touching daemon", async (t) => {
    if (skipIfNoDocker(t)) return;
    const d = docker!;
    const seccompProfile = JSON.stringify({
          defaultAction: "SCMP_ACT_ALLOW",
          syscalls: [{ names: ["reboot"], action: "SCMP_ACT_ERRNO" }],
        });
    for (const n of ["bridge", "host", "none", "default"]) {
      await assert.rejects(
        createContainer(d, testUid + 10, {
          image: TEST_IMAGE,
          network: n,
          proxyUrl: "http://proxy:3128",
          seccompProfileJson: seccompProfile,
        }),
        (err: Error & { code?: string }) => err.name === "SupervisorError" && err.code === "InvalidArgument",
      );
    }
  });

  test("stopContainer then inspect → state != running; removeContainer → missing", async (t) => {
    if (skipIfNoDocker(t)) return;
    const d = docker!;
    const uid = testUid;
    await cleanupContainer(uid);

    // 这次跑一个永续进程,确保 start 成功后仍在跑
    // createContainer 没暴露 Cmd,我们直接走底层 docker.createContainer 造一个同名的
    // 然后用 supervisor 的 stop/remove 来验证。这样才能观察到 "running → stopped"。
    const name = containerNameFor(uid);
    await d.createContainer({
      name,
      Image: TEST_IMAGE,
      Cmd: ["sleep", "3600"],
      HostConfig: { AutoRemove: false },
    });
    await d.getContainer(name).start();

    let s = await getContainerStatus(d, uid);
    assert.equal(s.state, "running");

    await stopContainer(d, uid);
    s = await getContainerStatus(d, uid);
    assert.equal(s.state, "stopped");

    await removeContainer(d, uid);
    s = await getContainerStatus(d, uid);
    assert.equal(s.state, "missing");
    assert.equal(s.id, "");
  });

  test("stop/remove on missing container is idempotent", async (t) => {
    if (skipIfNoDocker(t)) return;
    const d = docker!;
    const uid = testUid + 1;
    await stopContainer(d, uid); // no throw
    await removeContainer(d, uid); // no throw
    const s = await getContainerStatus(d, uid);
    assert.equal(s.state, "missing");
  });

  test("createContainer with unknown image maps to ImageNotFound", async (t) => {
    if (skipIfNoDocker(t)) return;
    const d = docker!;
    const uid = testUid + 2;
    await cleanupContainer(uid);
    await assert.rejects(
      createContainer(d, uid, {
        image: "openclaude/definitely-does-not-exist:nope",
        network: TEST_NETWORK,
        proxyUrl: "http://proxy:3128",
        seccompProfileJson: JSON.stringify({
          defaultAction: "SCMP_ACT_ALLOW",
          syscalls: [{ names: ["reboot"], action: "SCMP_ACT_ERRNO" }],
        }),
      }),
      (err: Error & { code?: string }) => err.name === "SupervisorError" && err.code === "ImageNotFound",
    );
    // 冗余清理
    await cleanupContainer(uid);
  });
});
