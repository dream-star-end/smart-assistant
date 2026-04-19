import type Docker from "dockerode";
import { SupervisorError } from "./types.js";

/**
 * Agent 持久化 volume 管理。
 *
 * 每个订阅用户两个 named volume(05-SEC §13 / 01-SPEC F-5.4):
 *   - `agent-u{uid}-workspace` 挂 `/workspace`:用户代码 / 工具产物
 *   - `agent-u{uid}-home`      挂 `/root`:shell 历史 / git config / npm cache
 *     (agent 进程以 uid=1000 运行,镜像里会把 /root 的 ownership chown 到 1000)
 *
 * 为什么是 **named volume** 而不是 bind mount:
 *   1. 路径隔离 —— volume 被 docker engine 管,宿主机没人会误挂到用户目录
 *   2. 便于 `lifecycle.ts` 的 volume GC:订阅到期后 30 天删除
 *   3. 容器可以 `--read-only` 根文件系统 + tmpfs /tmp,只有这两个 volume 可写
 *
 * 和 network.ts 对称的保护:创建时打 managed/uid/purpose label,后续复用前
 * 必须断言 label 存在。防止运维手工建了同名但属性不对的 volume(比如挂在
 * 奇怪 driver 上、或者被其他 uid 占用),被 supervisor 静默接管。
 */

/** volume 名验证,防止通过 uid 注入非法字符 */
const VOL_NAME_RE = /^agent-u\d+-(workspace|home)$/;

export type VolumePair = {
  workspace: string;
  home: string;
};

export function volumeNamesFor(uid: number): VolumePair {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  const workspace = `agent-u${uid}-workspace`;
  const home = `agent-u${uid}-home`;
  // 双重保险(uid 已经过整数校验,但名字拼好后再过一次正则,将来重构不会破防护)
  if (!VOL_NAME_RE.test(workspace) || !VOL_NAME_RE.test(home)) {
    throw new SupervisorError("InvalidArgument", `invalid volume name for uid ${uid}`);
  }
  return { workspace, home };
}

/**
 * 幂等地创建两个 volume,并校验存量 volume 的属性。
 *
 * docker createVolume 同名第二次调用会直接返回旧 volume 不报错。如果旧 volume
 * 是别人建的(比如运维手工 `docker volume create agent-u42-workspace`),label
 * 就对不上。我们 create 之后 inspect 一下,断言 managed=1 / uid=当前 / purpose
 * 对应;对不上就抛错,让 caller 决定是报 500 还是提示运维清理。
 */
export async function ensureUserVolumes(docker: Docker, uid: number): Promise<VolumePair> {
  const names = volumeNamesFor(uid);
  await createAndAssertVolume(docker, names.workspace, uid, "workspace");
  await createAndAssertVolume(docker, names.home, uid, "home");
  return names;
}

async function createAndAssertVolume(
  docker: Docker,
  name: string,
  uid: number,
  purpose: "workspace" | "home",
): Promise<void> {
  await docker.createVolume({
    Name: name,
    Driver: "local",
    Labels: {
      "com.openclaude.managed": "1",
      "com.openclaude.uid": String(uid),
      "com.openclaude.purpose": purpose,
    },
  });
  const info = await docker.getVolume(name).inspect();
  if (info.Driver && info.Driver !== "local") {
    throw new SupervisorError(
      "InvalidArgument",
      `volume ${name} exists with driver=${info.Driver}, expected local`,
    );
  }
  const labels = (info.Labels ?? {}) as Record<string, string>;
  if (labels["com.openclaude.managed"] !== "1") {
    throw new SupervisorError(
      "InvalidArgument",
      `volume ${name} exists but is not managed by openclaude (missing com.openclaude.managed=1)`,
    );
  }
  if (labels["com.openclaude.uid"] !== String(uid)) {
    throw new SupervisorError(
      "InvalidArgument",
      `volume ${name} exists but belongs to uid=${labels["com.openclaude.uid"]}, expected ${uid}`,
    );
  }
  if (labels["com.openclaude.purpose"] !== purpose) {
    throw new SupervisorError(
      "InvalidArgument",
      `volume ${name} exists but purpose=${labels["com.openclaude.purpose"]}, expected ${purpose}`,
    );
  }
  // 额外加固:即使是 driver=local,也可以通过 `Options: { type: nfs, o: ..., device: ... }`
  // 或 `type=bind, device=/host/path` 来指向宿主机敏感路径。我们只接受"无 Options"
  // 或空 Options 的纯 local volume —— 伪造同名且带 label 的 bind-style volume 会被拒。
  const opts = (info as { Options?: Record<string, string> | null }).Options;
  if (opts && typeof opts === "object" && Object.keys(opts).length > 0) {
    throw new SupervisorError(
      "InvalidArgument",
      `volume ${name} exists with custom Options=${JSON.stringify(opts)}; refuse to adopt (only plain local volumes are allowed)`,
    );
  }
}

/**
 * 删除两个 volume。容器必须先 remove,否则 docker 会 409。
 * missing 当作成功(幂等)。
 */
export async function removeUserVolumes(docker: Docker, uid: number): Promise<void> {
  const names = volumeNamesFor(uid);
  for (const n of [names.workspace, names.home]) {
    try {
      await docker.getVolume(n).remove();
    } catch (err) {
      if (isNotFound(err)) continue;
      throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "statusCode" in err && (err as { statusCode: number }).statusCode === 404;
}
