/**
 * codex-auth/constants — 跨 host codex auth 共享常量。
 *
 * **为什么独立模块**:`v3supervisor.ts` 已经从 `nodeAgentClient.ts` import
 * `AgentAppError`。如果 `nodeAgentClient` 反向 import `v3supervisor` 的 codex
 * 路径常量,会形成循环依赖。把常量挪到这里,让 `remoteCodexAuth.ts` /
 * `v3supervisor.ts` / `index.ts` / `codexAccountActor.ts` 都从同一无依赖
 * 模块取值,避免循环。
 *
 * `v3supervisor.ts` 把 `DEFAULT_V3_CODEX_CONTAINER_DIR` re-export 出去,
 * 老调用方(import 自 v3supervisor)无需改动。
 */

/**
 * Per-container codex auth.json 的 host 根目录。
 *
 * **本地路径**:可被 env `OC_V3_CODEX_CONTAINER_DIR` override(`v3supervisor.ts:188`
 * `readCodexContainerDirFromEnv`)。
 *
 * **远端路径**:**强制**用此默认值,**不读 master 的 env**。原因:docker bind
 * source 在远端 host 上解析,必须等于远端 fs 真实路径。env 是 master 进程内
 * 概念,远端 node-agent 完全不知道。`remoteCodexAuth.ts` / `v3supervisor.ts`
 * 远端分支均直接 import 此常量。
 *
 * 该路径同时被 node-agent (Go) `internal/files/files.go AllowedRoots` 和
 * `internal/containers/containers.go MountRoots` 白名单。三处必须保持一致 ——
 * 路径变更需同步修改 4 个文件。
 */
export const DEFAULT_V3_CODEX_CONTAINER_DIR =
  "/var/lib/openclaude-v3/codex-container-auth";
