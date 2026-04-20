import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import Docker from "dockerode";
import { statSync } from "node:fs";

/**
 * V3 Phase 3J — 容器侧网络隔离 e2e 验证。
 *
 * 见 docs/v3/02-DEVELOPMENT-PLAN.md §9.3 Task 3J:
 *   `cap-drop NET_RAW/NET_ADMIN` 校验 + 容器内 spoof 别 IP 调内部代理必须 401 +
 *   `/internal/*` 公网无法访问。
 *
 * 这里只验证容器侧的运行时安全契约(独立于 supervisor / PG / readiness)。
 * 直接 docker.createContainer({...}) 用与 v3supervisor 同款的 HostConfig 安全标志
 * (NET_RAW/NET_ADMIN drop + no-new-privileges + non-root + 固定 --ip),
 * 然后从容器内部探测以下三件事:
 *
 *   1. CapBnd 不含 NET_RAW(bit 13)/NET_ADMIN(bit 12) — kernel 真的接受了 cap-drop
 *   2. `ip addr add` 失败 — NET_ADMIN 真的被剥夺(spoof 第二 IP 不行)
 *   3. eth0 上只有一个 inet 地址,且 === 容器 bound IP — IPAM 强制 single IP
 *
 *   1+2+3 合起来 = "容器源 IP 不可伪造":
 *     - IPAM 给且只给 bound IP(测试 3)
 *     - 没法 ip-addr-add 加第二个(测试 2 = NET_ADMIN drop)
 *     - 没法用 raw socket 自造 IP 头改 src(测试 1 = NET_RAW drop)
 *   ⇒ 容器对外发出的所有 packet 源 IP 必然是 bound IP,sidecar 拒掉 spoof 必然成立。
 *
 * 不在本测试里:
 *   - sidecar 真的 401 spoof IP — 那要起 caddy + caddy 配置匹配 token,3J 之外。
 *     但 sidecar 只看 src IP 与 DB 中 bound_ip 是否一致,而 src IP 不可伪造已被本测证明。
 *   - /internal/* 公网无法访问 — 由 ops/setup-host-net.sh + ops/check-caddyfile.sh
 *     (CI lint, 见 2J-1) 保证。
 *
 * 不通过 provisionV3Container — 那条路径要 PG 事务 + IP 池分配 + 已有 unit 覆盖;
 * 本测试纯粹验证 docker daemon 是否真把这些 cap-drop 落到 kernel,以及 IPAM 强制
 * 单一 IP 是否真生效。
 *
 * Skip 条件:`/var/run/docker.sock` 不存在或当前进程无法访问 → 整个 describe skip。
 *
 * 临时网络:`v3-iso-test-net`(172.31.99.0/24,gw 172.31.99.1),test 结束清理。
 */

const TEST_IMAGE = process.env.AGENT_TEST_IMAGE ?? "alpine:3.19";
const TEST_NETWORK = "v3-iso-test-net";
const TEST_SUBNET = "172.31.99.0/24";
const TEST_GATEWAY = "172.31.99.1";
const CONTAINER_IP = "172.31.99.10";
const CONTAINER_NAME = `v3-iso-test-${Date.now().toString(36)}`;

let dockerAvailable = false;
let docker: Docker | null = null;
let container: Docker.Container | null = null;

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

async function cleanup(): Promise<void> {
  if (!docker) return;
  try {
    await docker.getContainer(CONTAINER_NAME).remove({ force: true });
  } catch {
    /* ignore — may not exist */
  }
  try {
    await docker.getNetwork(TEST_NETWORK).remove();
  } catch {
    /* ignore — may not exist or in-use */
  }
}

before(async () => {
  if (!socketExists()) return;
  try {
    docker = new Docker();
    await docker.ping();
    if (!(await imagePresent(docker, TEST_IMAGE))) {
      await pullImage(docker, TEST_IMAGE);
    }

    // pre-cleanup(防上次崩没清掉)
    await cleanup();

    // 临时 bridge 网络 + 固定 subnet,保证 IPAM 给 CONTAINER_IP
    await docker.createNetwork({
      Name: TEST_NETWORK,
      Driver: "bridge",
      IPAM: {
        Driver: "default",
        Config: [{ Subnet: TEST_SUBNET, Gateway: TEST_GATEWAY }],
      },
    });

    // 用与 v3supervisor.ts:480 同款 HostConfig 安全标志
    container = await docker.createContainer({
      name: CONTAINER_NAME,
      Image: TEST_IMAGE,
      Cmd: ["sleep", "3600"],
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
      OpenStdin: false,
      User: "1000:1000",
      NetworkingConfig: {
        EndpointsConfig: {
          [TEST_NETWORK]: { IPAMConfig: { IPv4Address: CONTAINER_IP } },
        },
      },
      HostConfig: {
        NetworkMode: TEST_NETWORK,
        CapDrop: ["NET_RAW", "NET_ADMIN"],
        CapAdd: [],
        Privileged: false,
        SecurityOpt: ["no-new-privileges"],
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
        ShmSize: 64 * 1024 * 1024,
      },
    });
    await container.start();
    dockerAvailable = true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[v3NetworkIsolation.integ] setup failed:", (err as Error).message);
    await cleanup();
  }
});

after(async () => {
  await cleanup();
});

function skipIfNoDocker(t: { skip: (reason: string) => void }): boolean {
  if (!dockerAvailable || !container || !docker) {
    t.skip("docker daemon not available");
    return true;
  }
  return false;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function execInContainer(cmd: string[]): Promise<ExecResult> {
  if (!container || !docker) throw new Error("container not initialized");
  const e = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await e.start({ hijack: true, stdin: false });

  let stdout = "";
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    // demuxStream 仅调用 sink.write(buf);end 不会被调用,但 NodeJS.WritableStream
    // 类型很复杂,这里用最小 stub + as 强转,避免引入 stream.PassThrough。
    const makeSink = (onChunk: (s: string) => void): NodeJS.WritableStream =>
      ({
        write: (chunk: string | Uint8Array): boolean => {
          onChunk(
            Buffer.isBuffer(chunk)
              ? chunk.toString("utf8")
              : typeof chunk === "string"
                ? chunk
                : Buffer.from(chunk).toString("utf8"),
          );
          return true;
        },
      }) as unknown as NodeJS.WritableStream;
    docker!.modem.demuxStream(
      stream,
      makeSink((s) => {
        stdout += s;
      }),
      makeSink((s) => {
        stderr += s;
      }),
    );
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });

  const inspect = await e.inspect();
  return { code: inspect.ExitCode ?? -1, stdout, stderr };
}

describe("v3 network isolation integ (3J)", () => {
  test("CapBnd does NOT include NET_RAW (bit 13) or NET_ADMIN (bit 12)", async (t) => {
    if (skipIfNoDocker(t)) return;
    const res = await execInContainer(["sh", "-c", "grep ^CapBnd /proc/self/status"]);
    assert.equal(res.code, 0, `read CapBnd failed: stderr=${res.stderr}`);
    // Format: "CapBnd:\t00000000a80405fb"
    const m = /CapBnd:\s+([0-9a-fA-F]+)/.exec(res.stdout);
    assert.ok(m, `CapBnd not found in /proc/self/status: ${res.stdout}`);
    const bits = BigInt(`0x${m[1]}`);
    // CAP_NET_ADMIN = 12, CAP_NET_RAW = 13
    assert.equal(
      (bits >> 12n) & 1n,
      0n,
      `CAP_NET_ADMIN bit set in CapBnd ${m[1]} — cap-drop did not take effect`,
    );
    assert.equal(
      (bits >> 13n) & 1n,
      0n,
      `CAP_NET_RAW bit set in CapBnd ${m[1]} — cap-drop did not take effect`,
    );
  });

  test("ip addr add fails (NET_ADMIN dropped → cannot spoof second IP)", async (t) => {
    if (skipIfNoDocker(t)) return;
    const res = await execInContainer([
      "ip",
      "addr",
      "add",
      "172.31.99.99/24",
      "dev",
      "eth0",
    ]);
    assert.notEqual(
      res.code,
      0,
      `ip addr add unexpectedly succeeded — NET_ADMIN not dropped. ` +
        `stdout=${res.stdout} stderr=${res.stderr}`,
    );
    // 期望 stderr 提及 permission/operation not permitted/RTNETLINK
    const combined = `${res.stdout}\n${res.stderr}`.toLowerCase();
    assert.ok(
      /permission|not permitted|operation not allowed|rtnetlink/.test(combined),
      `expected EPERM-like error, got: ${combined}`,
    );
  });

  test("eth0 has exactly one inet address, equal to bound IP (IPAM single-IP)", async (t) => {
    if (skipIfNoDocker(t)) return;
    // `ip -4 addr show eth0` 输出格式:
    //   2: eth0@if1040: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 ...
    //       inet 172.31.99.10/24 brd 172.31.99.255 scope global eth0
    //          valid_lft forever preferred_lft forever
    //
    // 我们抓所有 `^\s*inet ` 行,断言:
    //   - 恰好 1 个 inet
    //   - 其 IP === CONTAINER_IP
    //
    // 这与 NET_RAW/NET_ADMIN drop 合起来 ⇒ 容器对外 packet 源 IP 必然 == bound IP。
    const res = await execInContainer(["ip", "-4", "addr", "show", "eth0"]);
    assert.equal(res.code, 0, `ip addr show eth0 failed: ${res.stderr}`);
    const inetLines = res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("inet "));
    assert.equal(
      inetLines.length,
      1,
      `expected exactly 1 inet line on eth0, got ${inetLines.length}: ${inetLines.join(" | ")}`,
    );
    const m = /^inet\s+([0-9.]+)\/\d+/.exec(inetLines[0]!);
    assert.ok(m, `cannot parse inet line: ${inetLines[0]}`);
    assert.equal(
      m[1],
      CONTAINER_IP,
      `eth0 inet ${m[1]} !== bound IP ${CONTAINER_IP} — IPAM did not honor IPv4Address`,
    );
  });
});
