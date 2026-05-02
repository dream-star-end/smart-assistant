/**
 * remoteCodexAuth — 把 per-container codex auth.json 写到远端 host (boheyun /
 * fly-01 / oc-compute-tk1) 的 host fs。
 *
 * **为什么独立模块**(plan v1.0.72 决策):
 * - `nodeAgentClient.ts` 只暴露低层 RPC(`putFile` / `deleteFile`)— 不掺业务
 *   逻辑(否则与 `v3supervisor.ts` / `codexAccountActor.ts` 互相 import 形成循环)
 * - 业务层(per-container 路径拼接 + buildPerContainerAuthJson body + chown
 *   语义)统一收在本模块,supervisor / lazy migrate / refresh actor 三方都从这里
 *   调用,确保**远端写入路径与远端 docker bind source 完全一致**。
 *
 * **路径硬编码** `DEFAULT_V3_CODEX_CONTAINER_DIR`:不读 master env,远端 host
 * 上 fs 路径与 master 完全独立,只能锁死同一默认值(见 constants.ts 注释)。
 *
 * **chown 由 node-agent server 端做**:`putFile` 透传 `owner_uid` / `owner_gid`
 * query,node-agent (Go `internal/files/files.go`) chown 在 chmod 之前(同 plan
 * round 3 的 chown-before-chmod 决策)。本模块 caller 不需要关心 chown 细节。
 *
 * **失败语义**:任一步抛 → caller 在 supervisor / actor / lazy migrate 自行
 * fallback 到 NULL bind / skip / 重试,本模块不吞错。
 */

import { join as pathJoin } from "node:path";

import { V3_AGENT_GID, V3_AGENT_UID } from "../agent-sandbox/constants.js";
import { putFile, deleteFile, type NodeAgentTarget } from "../compute-pool/nodeAgentClient.js";
import { buildPerContainerAuthJson } from "./codexAuthFile.js";
import { DEFAULT_V3_CODEX_CONTAINER_DIR } from "./constants.js";

/**
 * 拼远端 host 上 per-container auth.json 绝对路径。
 *
 * 容器 id 必须是十进制数字 — 与 `codexAuthFile.resolveAuthPath` 同样的输入
 * 校验,防止 caller 传 `..` / 含斜杠的 token 让远端 PUT 写到 AllowedRoot 外。
 * (node-agent server 端 `validatePath` + `resolveParentNoSymlink` 还会再校,
 * 这里是 client 侧第一道防线。)
 */
function resolveRemotePath(containerId: string): string {
  if (!/^\d+$/.test(containerId)) {
    throw new Error(`remoteCodexAuth: invalid containerId (must be digits): ${containerId}`);
  }
  return pathJoin(DEFAULT_V3_CODEX_CONTAINER_DIR, containerId, "auth.json");
}

/**
 * 写远端 per-container auth.json。owner=V3_AGENT_UID:V3_AGENT_GID(=1000:1000),
 * mode=0o400 — 与本地 `writeCodexContainerAuthFile` 输出文件属性完全一致,
 * 容器内 codex CLI(uid 1000)能读、host 上其他 uid 无权读。
 */
export async function putRemoteCodexContainerAuth(
  target: NodeAgentTarget,
  containerId: string,
  accessToken: string,
  lastRefreshIso: string,
): Promise<void> {
  const remotePath = resolveRemotePath(containerId);
  const body = Buffer.from(
    buildPerContainerAuthJson({ accessToken, lastRefreshIso }),
    "utf8",
  );
  await putFile(target, remotePath, body, 0o400, V3_AGENT_UID, V3_AGENT_GID);
}

/**
 * 删远端 per-container auth.json。
 *
 * **与本地 `removeCodexContainerAuthDir` 的语义差异**(intentional):
 * - 本地版会 `unlink(file) + rmdir(parentDir)` 清掉空目录
 * - 远端版只 `DELETE /files?path=<file>`,**不 rmdir parent** —— node-agent
 *   `/files` endpoint 没有 rmdir 能力(仅支持单文件 PUT/DELETE/STAT,设计如此)
 *
 * 后果:每个停掉的容器在远端 host 上留一个空 `<containerId>/` 子目录,无安全
 * 影响,占空间忽略不计。下次同 cid 重 provision 会复用该目录(实际不会,
 * `agent_containers.id` 是 SERIAL 自增,不重用)— 长期累积属于已知偏差,
 * 等未来给 node-agent 加 rmdir RPC 时再清。
 *
 * 容器 id 非法时 silently noop(与 `codexAuthFile.removeCodexContainerAuthDir`
 * 同行为)。
 */
export async function deleteRemoteCodexContainerAuth(
  target: NodeAgentTarget,
  containerId: string,
): Promise<void> {
  if (!/^\d+$/.test(containerId)) return;
  const remotePath = resolveRemotePath(containerId);
  await deleteFile(target, remotePath);
}
