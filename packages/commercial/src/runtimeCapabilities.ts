/**
 * 进程级 capability 广播 + 步骤 5 兼容地板(方案 §7 步 3/4/5,R3-B4 + R4-M2)。
 *
 * ── 为什么需要"capability"这层 ───────────────────────────────────────────────
 * 模型权威批次把判定单点化到 master:master 签发签名 execution descriptor,容器消费,
 * egress 每请求跑 epoch fence。这三面(master / egress / 容器 runtime)+ DB schema 一共
 * **四面**,任一面回到 legacy/baked 判定 = 双信任源复活(签发的人和执行的人不同源)。
 *
 * 所以每一面都必须能**自证**"我这个版本实现了模型权威协议",让部署守卫能在**激活之前**
 * 拒绝掉不具备该能力的旧版本。自证的方式 = capability token:
 *   - master  → `/healthz` 的 `runtime.capabilities`(gateway 只读透传 CommercialRuntimeStatus,
 *               commercial 是唯一权威;不动 gateway 的 body.capabilities —— 那是容器 file-proxy 面);
 *   - egress  → `/internal/v5/egress-health` 的 `capabilities`;
 *   - 容器 runtime → hello attestation(ws/userChatBridge)+ 镜像/release 制品声明;
 *   - 制品面(deploy 守卫读的静态声明)→ deploy/v5/release-metadata.json 的 capabilities /
 *     runtimeCapabilities,与本文件由 __tests__/releaseCapabilities.test.ts 钉死同源。
 *
 * ── 步骤 5 的不可逆兼容地板 ─────────────────────────────────────────────────
 * 方案 §7 步 5 一旦开放 admin catalog 写入(staged/activate/switch),DB 里就会出现
 * **baked 判定不可能知道的行**(新模型/新 upstream/新 capability)。此后任何一面回滚到
 * legacy 判定 = 容器按 baked 表执行一个 catalog 已经改掉/撤销的模型 → 计费与安全都失真。
 * 故步骤 5 起:
 *   - deploy/rollback 守卫拒绝激活缺 capability 的 master release / runtime tuple(scripts/);
 *   - 进程启动拒绝在 flag 关闭态下起(本文件 assertModelAuthorityCutoverFloor)。
 * 真要退回 baked,唯一合法路径见方案 §7 步 5 回滚列:事务性把 catalog 恢复到 baked 等价值 +
 * bump epoch + 等所有快照/运行容器收敛,才允许清 marker 并关 flag。
 */

import {
  LOSSLESS_TURN_TAPE_CAPABILITY,
  MODEL_AUTHORITY_CAPABILITY,
  MODEL_AUTHORITY_EGRESS_CAPABILITY,
} from "@openclaude/protocol";

import { isModelAuthorityEnforced } from "./billing/modelCatalogRuntime.js";

/** master 进程广播的 capability(→ /healthz.runtime.capabilities)。 */
export const MASTER_CAPABILITIES: readonly string[] = [
  MODEL_AUTHORITY_CAPABILITY,
  LOSSLESS_TURN_TAPE_CAPABILITY,
];

/** egress 进程广播的 capability(→ /internal/v5/egress-health.capabilities)。 */
export const EGRESS_CAPABILITIES: readonly string[] = [MODEL_AUTHORITY_EGRESS_CAPABILITY];

/**
 * 步骤 5 cutover marker(持久化,双源):
 *   - env 键(本常量):写在 /etc/openclaude/commercial-v5.env,**进程侧唯一可见的信号**
 *     (DB 不可达时部署守卫也还能判定地板已生效 → fail-closed 不依赖 DB 活着);
 *   - DB 单行(model_authority_deploy_state.key='cutover'):跨主机重建/DR 后仍在,
 *     且普通 app 角色不可读写,与它保护的 model_catalog 同库同命运
 *     (见 scripts/deploy-v5.sh --model-authority-cutover)。
 * 判定 = 任一为真(OR)。deploy 侧两源都查;进程侧只查 env(启动路径不引入 DB 依赖)。
 */
export const MODEL_AUTHORITY_CUTOVER_ENV = "OC_MODEL_AUTHORITY_CUTOVER";
/** DB 侧 marker 的 model_authority_deploy_state key(只有 deploy role 可写)。 */
export const MODEL_AUTHORITY_CUTOVER_SETTING_KEY = "cutover";

/** env 侧 marker 是否置位。 */
export function isModelAuthorityCutoverDone(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MODEL_AUTHORITY_CUTOVER_ENV] === "1";
}

/**
 * 启动期兼容地板断言(master 与 egress 两进程各调一次)。
 *
 * cutover 已置位却在 flag 关闭态下起 = 判定权退回 baked/legacy,而 DB 里可能已经有 baked
 * 不认识的 catalog 行 → **拒启**(响亮失败,而不是带着分叉的判定源静默服务)。
 * 反向(flag 开着但 marker 未置位)是合法的:步骤 4 就是这个状态。
 */
export function assertModelAuthorityCutoverFloor(env: NodeJS.ProcessEnv = process.env): void {
  if (!isModelAuthorityCutoverDone(env)) return;
  if (isModelAuthorityEnforced(env)) return;
  throw new Error(
    `[model-authority] compat floor violated: ${MODEL_AUTHORITY_CUTOVER_ENV}=1 (step 5 done) but OC_MODEL_AUTHORITY≠1 —— ` +
      "步骤 5 后禁止回到 baked 判定。合法退路见 docs/V5_MODEL_AUTHORITY_PLAN.md §7 步 5 回滚列" +
      "(事务性恢复 catalog 至 baked 等价值 + bump epoch + 等快照/容器收敛后才允许清 marker)。",
  );
}
