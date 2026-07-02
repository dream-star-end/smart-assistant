/**
 * agentModelAuthority —— master 侧「agentId → 有效模型」权威快照
 * (P0 计费旁路封堵:bridge 可信模型推导的数据源)。
 *
 * 为什么在 master 侧再立一份权威:M1a 起容器 gateway 的 engine 判定按 model
 * (engine/registry resolveEngine),帧不带 model 时回落 **agent.model**。
 * agent.model 的落库权威本来就在 master(seed 常量 + marketplace manifest),
 * 容器 agents.yaml 只是它的下发投影(entrypoint seed + syncMarketplaceHub
 * reconcile)。bridge 在 forward 前做 codex 分类,必须读同一份权威,而不是
 * 信 frame / lastSeen 这类客户端可控信号。
 *
 * 快照组成(与容器 agents.yaml 的 master 侧来源一一对应):
 *   1. marketplace 用户已装 agent(listActiveInstalledAgents)→ manifest.model
 *   2. marketplace 平台预设 agent(listPlatformPresetAgents)→ manifest.model,
 *      同 slug 覆盖已装(与 internalMarketplaceSync 的「预设优先」合并规则一致)
 *   3. 内置 seed agents(entrypoint desiredSeedAgents 的 master 侧镜像):
 *      main → PLATFORM_DEFAULT_MODEL、codex → gpt-5.5;
 *      内置 id 最后写入 = 最高优先(容器 reconcileAgents 对 reserved id 同样跳过
 *      marketplace 同名项,语义对齐)
 *
 * 推导不出(用户在容器里手改 agents.yaml 自建的 agent 等)→ resolver 返 null,
 * bridge 对「帧无 model」的这类帧 fail-closed 拒(gateway seam 的 requestId
 * fail-closed guard 是同问题的容器侧兜底层)。
 */
import { DEFAULT_CODEX_ENGINE_MODEL } from "@openclaude/protocol";

import {
  listActiveInstalledAgents,
  listPlatformPresetAgents,
  type InstalledAgent,
} from "../marketplace/marketplaceDb.js";
import { platformPresetAgentSlugs } from "../marketplace/platformPresets.js";
import { PLATFORM_DEFAULT_MODEL } from "../platformDefaults.js";

/** manifest JSON → model 字段(形状防御:非法 JSON / 非 string model → null)。 */
function manifestModel(rawManifest: string): string | null {
  try {
    const parsed: unknown = JSON.parse(rawManifest);
    if (parsed === null || typeof parsed !== "object") return null;
    const model = (parsed as { model?: unknown }).model;
    return typeof model === "string" && model.trim() !== "" ? model : null;
  } catch {
    return null;
  }
}

/**
 * 纯函数快照构建(单测锚点):installed → presets(覆盖)→ builtin(覆盖)。
 * 后写覆盖 = 优先级递增,与文件头注释的 1→3 顺序一致。
 */
export function buildAgentModelSnapshot(
  installedAgents: readonly InstalledAgent[],
  presetAgents: readonly InstalledAgent[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const list of [installedAgents, presetAgents]) {
    for (const a of list) {
      const model = manifestModel(a.rawManifest);
      if (model !== null) map.set(a.slug, model);
    }
  }
  // 内置 seed(最高优先;容器侧 reserved id 同语义)。
  map.set("main", PLATFORM_DEFAULT_MODEL);
  map.set("codex", DEFAULT_CODEX_ENGINE_MODEL);
  return map;
}

/**
 * bridge dep `loadAgentModelResolver` 的生产实现:拉一次 DB 快照,返回 sync
 * resolver closure。刷新语义由 bridge 侧 handle 承载(周期 + miss 补触发)。
 */
export async function loadAgentModelResolverForUser(
  uid: bigint,
): Promise<(agentId: string) => string | null> {
  const presetSlugs = await platformPresetAgentSlugs();
  const [installed, presets] = await Promise.all([
    listActiveInstalledAgents(Number(uid)),
    listPlatformPresetAgents(presetSlugs),
  ]);
  const snapshot = buildAgentModelSnapshot(installed, presets);
  return (agentId: string) => snapshot.get(agentId) ?? null;
}
