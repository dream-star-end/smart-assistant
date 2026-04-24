/**
 * remoteTarget.ts — 执行目标抽象与远程控制器注入接口。
 *
 * Gateway 层不依赖 commercial;sshMux 实现住在 commercial/remoteHosts/sshMux.ts,
 * 由 commercial 侧在启动时通过 `SessionManager.setRemoteTargetController(ctrl)`
 * 注入本文件定义的接口。这样 gateway → commercial 的反向依赖被彻底切断
 * (Codex R11 BLOCK-1)。
 *
 * ExecutionTarget 形态:
 *   - { kind: 'local' }            默认,CCB 本地 spawn(或 v3 容器内 spawn)
 *   - { kind: 'remote', hostId, hostMeta } 切到远程机;hostMeta 握 mux handle,
 *     runner 据此注入 env 给 CCB 的 RemoteExecutor(task #5/#6 消费)
 *
 * 生命周期:
 *   - 每个 AgentSession 持有一个 executionTarget(默认 'local')
 *   - 切换由 `SessionManager.setExecutionTarget(sessionKey, target)` 统一入口
 *   - 切走 remote 时,SessionManager 负责 release 旧 mux;切入 remote 时,先
 *     acquireMux 成功再 swap runner,失败路径保证无泄漏
 */

/**
 * 远程机握手后返回的 mux 句柄。对齐 commercial/remoteHosts/sshMux.ts MuxHandle 形状。
 *
 * gateway 侧只消费下列字段(env 注入 + 日志),不做任何 ssh 相关 IO。
 * sessionId 用作 refcount key —— 同一 sessionKey 反复 setExecutionTarget 到同一
 * hostId 幂等(Set.add)。
 */
export interface RemoteMuxHandle {
  sessionId: string
  userId: string
  hostId: string
  controlPath: string
  knownHostsPath: string
  username: string
  host: string
  port: number
  remoteWorkdir: string
}

export type ExecutionTarget =
  | { kind: 'local' }
  | { kind: 'remote'; hostId: string; hostMeta: RemoteMuxHandle }

/**
 * Commercial 侧实现的远程目标控制器。
 *
 * 合约:
 *   - acquireMux / releaseMux 按 (userId, hostId) 的 ControlMaster refcount 语义
 *     串行化;同一 sessionId 对同一 host 重复 acquire 是幂等的(Set.add)
 *   - acquireMux 失败必须抛(不能返回 null),gateway 依赖异常做 rollback
 *   - releaseMux 幂等:session 未持有 / host 已关都返回 void
 *
 * 实现:commercial/remoteHosts/sshMux.ts 的 acquireMux/releaseMux 直接适配。
 */
export interface RemoteTargetController {
  acquireMux(sessionId: string, userId: string, hostId: string): Promise<RemoteMuxHandle>
  releaseMux(sessionId: string, userId: string, hostId: string): Promise<void>
}

/** Gateway 层 sentinel:切 remote 但 controller 未注入(commercial 关着 / personal 版) */
export class RemoteTargetUnavailableError extends Error {
  constructor(reason: string) {
    super(`remote target unavailable: ${reason}`)
    this.name = 'RemoteTargetUnavailableError'
  }
}
