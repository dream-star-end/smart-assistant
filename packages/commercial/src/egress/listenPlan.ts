/**
 * egress 监听计划(蓝绿双槽 · 零停机发布)。
 *
 * 背景:2026-09-04 17:22–17:41 一次 selfhost 发布里 egress 单 unit 进入 Stopping
 * (drain 在飞流,TimeoutStopSec=31min),监听已关,容器侧 19 分钟 ECONNREFUSED
 * 172.31.0.1:18892,grok-build 报成「unknown model id」。根治是把 egress 变成两个
 * 槽(A/B):部署时先起空闲槽、就绪后再停旧槽,旧槽只 drain 自己的在飞流。
 *
 * 两个槽如何共享同一个 172.31.0.1:18892:
 *   · systemd `openclaude-v5-selfhost-egress@.socket`(ReusePort=yes)为每个槽建一个
 *     SO_REUSEPORT listener,通过 sd_listen_fds 协议把 fd 3 交给本进程;
 *   · 本进程按 LISTEN_PID/LISTEN_FDS 判定是否收到了 fd,收到就 `server.listen({fd:3})`,
 *     否则回落到自己 bind(legacy 单 unit / 本地开发)。
 *   · 内核 net.ipv4.tcp_migrate_req=1 让旧槽 close() 时 accept 队列里的半开连接迁到
 *     另一个 reuseport 成员,不丢 SYN。
 *
 * 每槽另有一个只读私有健康口(127.0.0.1:18898/18899),部署脚本用它判断「新槽已就绪」,
 * 不能拿共享口判定(共享口的响应可能来自旧槽)。
 */

export type EgressSlot = "A" | "B";

export const EGRESS_SLOT_PRIVATE_PORT: Readonly<Record<EgressSlot, number>> = {
  A: 18898,
  B: 18899,
};

export interface ListenPlanEnv {
  LISTEN_PID?: string;
  LISTEN_FDS?: string;
  OC_EGRESS_SLOT?: string;
}

export interface ListenPlan {
  /** 收到 systemd 传入的 socket:直接 listen({fd})。 */
  mode: "sd_activation" | "self_bind";
  /** sd_activation 时为 3(SD_LISTEN_FDS_START)。 */
  fd: number | null;
  /** 槽标识;legacy 单 unit 没有槽。 */
  slot: EgressSlot | null;
  /** 私有健康口(仅有槽时存在)。 */
  privatePort: number | null;
}

export function parseEgressSlot(raw: string | undefined): EgressSlot | null {
  if (raw === "A" || raw === "B") return raw;
  return null;
}

/**
 * 纯函数:根据 env 决定监听方式。
 *
 * - LISTEN_PID 必须等于本进程 pid(sd_listen_fds 协议;防止 fd 被无关子进程误认领)。
 *   这里的 pid 由调用方传入,便于单测。
 * - LISTEN_FDS 必须恰为 1:本 unit 只声明一个 ListenStream。多了/少了都是 unit 配置错,
 *   fail-loud 比默默 bind 第二个口更好排查。
 * - 有槽但没 fd:允许(手动 `systemctl start egress@A.service` 而不经 socket),回落自 bind;
 *   但两个槽同时自 bind 会 EADDRINUSE,由 unit 的 Requires=socket 兜住。
 */
export function computeListenPlan(env: ListenPlanEnv, selfPid: number): ListenPlan {
  const slot = parseEgressSlot(env.OC_EGRESS_SLOT);
  const privatePort = slot ? EGRESS_SLOT_PRIVATE_PORT[slot] : null;
  const listenPid = env.LISTEN_PID !== undefined ? Number(env.LISTEN_PID) : NaN;
  const listenFds = env.LISTEN_FDS !== undefined ? Number(env.LISTEN_FDS) : 0;
  if (Number.isFinite(listenPid) && listenPid === selfPid) {
    if (listenFds !== 1) {
      throw new Error(
        `[egress] LISTEN_FDS=${env.LISTEN_FDS} 不等于 1:egress@.socket 只允许一个 ListenStream,拒启`,
      );
    }
    return { mode: "sd_activation", fd: 3, slot, privatePort };
  }
  return { mode: "self_bind", fd: null, slot, privatePort };
}

/**
 * 私有健康口 body。与共享口 /internal/v5/egress-health 区分:这里只回答「本槽进程
 * 是否已完成启动并接管监听」,部署脚本据此推进槽翻转。
 */
export interface SlotHealthBody {
  ok: true;
  role: "egress";
  slot: EgressSlot;
  listenMode: ListenPlan["mode"];
  processStartId: string;
  pid: number;
}
