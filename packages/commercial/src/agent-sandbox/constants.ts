/**
 * 容器沙箱共享常量 —— 避免在 v3supervisor.ts / sshMux.ts 等处双写魔数。
 *
 * UID/GID 必须和容器镜像 Dockerfile 的 `USER agent` 一致(agent = 1000:1000)。
 * v3supervisor 通过 HostConfig.User "1000:1000" 强制 enforce;容器内任何进程
 * (entrypoint / CCB / user shell)都以这个 uid 运行。
 *
 * /run/ccb-ssh/u<uid>/h<hid>/ 下的 socket / known_hosts 需要 group 权限允许
 * 容器内 agent 连接;V3_AGENT_GID 就是 chown 的 group。
 */

export const V3_AGENT_UID = 1000;
export const V3_AGENT_GID = 1000;
