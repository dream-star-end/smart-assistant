import type Docker from "dockerode";
import { SupervisorError } from "./types.js";

/**
 * Agent 专属 bridge 网络管理。
 *
 * 必须是独立的、我们自己打 label 的 user-defined bridge —— 05-SEC §13 要求
 * 容器不能访问宿主机上的其它服务(Postgres / Redis / Gateway),也不能用默认
 * bridge(里面所有容器互通,且别人的容器也会出现在里面)。
 *
 * 出口流量要过代理(proxyUrl 注入到容器 env),让 dnsmasq/tinyproxy 来做
 * 白名单;这部分的策略属于 T-51 镜像里 supervisor.sh 的职责。
 *
 * **2026-04-21 安全审计 BLOCKER#2 双层防御**:
 *   设计上的"靠代理出口白名单"在 v3 不完全适用 —— v3 容器跑完整个人版,
 *   browser-automation / web-search / MCP fetch 等工具直接连公网,无法全走代理。
 *   因此用 **host iptables 独立链 V3_EGRESS_IN** 兜底:
 *     - INPUT 链:容器(172.30.0.0/16)→ host 仅放行 172.30.0.1:18791(internal proxy);
 *       PG 5432 / Redis 6379 / gateway 18789 admin 等内部端口全部 DROP
 *     - FORWARD 链:不动,容器→公网仍允许(否则浏览器/搜索瘫痪)
 *   规则在 setup-host-net.sh 落地;boot 自动应用走 openclaude-v3-host-firewall.service。
 *
 *   v3 supervisor 这层的责任 = "确保 docker bridge 配置正确";
 *   host iptables 是兜底层,即使本模块出 bug 也挡得住容器→host 横向。
 */

/** 与 supervisor.ts 保持一致的 label key。 */
const MANAGED_LABEL_KEY = "com.openclaude.managed";

/** docker 内建 / 保留名。调到这里也是 caller bug,supervisor 已经过一道防御,
 *  这里再过一道,避免 network.ts 被独立使用时漏防。 */
const RESERVED_NAMES = new Set(["bridge", "host", "none", "default"]);

/**
 * 幂等地确保 agent bridge 网络存在。
 *
 * - 若已存在,断言:driver=bridge **且** 带我们自己的 managed label
 *   (防止运维或旧代码建了同名但配置不符合要求的 overlay/ macvlan,
 *   把容器挂过去就破坏了沙箱)
 * - 不存在就按 §13 约束创建
 * - 并发 create 竞态时吞 409 后回读一次做断言
 */
export async function ensureAgentNetwork(docker: Docker, name: string): Promise<void> {
  if (RESERVED_NAMES.has(name)) {
    throw new SupervisorError(
      "InvalidArgument",
      `network name ${name} is reserved (docker built-in); refuse to manage`,
    );
  }

  // 1) 先 inspect,若存在 → 校验属性
  try {
    const info = await docker.getNetwork(name).inspect();
    assertManagedBridge(info, name);
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  // 2) 不存在就创建。
  //    `Attachable:false` 避免被 swarm 服务挂载过来。
  //    `Internal:false` 因为我们靠代理做出口白名单,不是靠断网。
  //    `EnableIPv6:false` 简化,反正上游代理不需要。
  try {
    await docker.createNetwork({
      Name: name,
      Driver: "bridge",
      CheckDuplicate: true,
      Attachable: false,
      Internal: false,
      EnableIPv6: false,
      Labels: { [MANAGED_LABEL_KEY]: "1" },
    });
  } catch (err) {
    // 竞态:另一个进程刚好 create 完,我们吞 409,然后回读断言属性符合预期。
    if (!isConflict(err)) throw err;
    const info = await docker.getNetwork(name).inspect();
    assertManagedBridge(info, name);
  }
}

/**
 * 对复用的 network,不仅校验 label,还校验创建时重要的安全属性。
 * 伪造 label 相对容易,但要完整伪造一个 `{bridge, Attachable=false, Internal=false,
 * EnableIPv6=false}` 的配置才能悄悄顶替,这一步就能挡绝大多数"同名 overlay /
 * 同名 attachable swarm 网络顶替"的攻击面。
 */
function assertManagedBridge(
  info: {
    Driver?: string;
    Labels?: Record<string, string> | null;
    Attachable?: boolean;
    Internal?: boolean;
    EnableIPv6?: boolean;
  },
  name: string,
): void {
  if (info.Driver && info.Driver !== "bridge") {
    throw new SupervisorError(
      "InvalidArgument",
      `network ${name} exists but driver=${info.Driver}, expected bridge (check infra config)`,
    );
  }
  const label = info.Labels?.[MANAGED_LABEL_KEY];
  if (label !== "1") {
    throw new SupervisorError(
      "InvalidArgument",
      `network ${name} exists but is not managed by openclaude (missing ${MANAGED_LABEL_KEY}=1 label)`,
    );
  }
  // 创建时参数。dockerode inspect 里这三项都是 boolean。
  // 注意:老版本 docker daemon 的 inspect 可能不返回 Attachable 字段 → 对 undefined 宽容。
  if (info.Attachable === true) {
    throw new SupervisorError(
      "InvalidArgument",
      `network ${name} exists with Attachable=true; refuse to adopt (swarm-attachable network breaks sandbox)`,
    );
  }
  if (info.Internal === true) {
    throw new SupervisorError(
      "InvalidArgument",
      `network ${name} exists with Internal=true; refuse to adopt (we rely on proxy egress, not full air-gap)`,
    );
  }
  if (info.EnableIPv6 === true) {
    throw new SupervisorError(
      "InvalidArgument",
      `network ${name} exists with EnableIPv6=true; refuse to adopt (our proxy whitelist is IPv4-only)`,
    );
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "statusCode" in err && (err as { statusCode: number }).statusCode === 404;
}
function isConflict(err: unknown): boolean {
  return typeof err === "object" && err !== null && "statusCode" in err && (err as { statusCode: number }).statusCode === 409;
}
