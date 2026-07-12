/**
 * modelCatalogRuntime —— 进程级 catalog 装配的**单一入口**(模型权威批次 · 方案 §1.2/§4)。
 *
 * 为什么需要它:同一个进程里有多个消费者要 catalog ——
 *   - master:bridge 签发 authority(ws/userChatBridge)、内部下发端点(/internal/v3/model-catalog)、
 *     非 split 拓扑下的 internalProxyHandler;
 *   - egress:`/v1/messages` 的每请求 fence + provider 路由。
 * 各自 `new ModelCatalogCache()` 会得到**多份快照 + 多条 LISTEN 连接**:同一进程内两份快照
 * 可能一新一旧,fence 结论就会互相矛盾(签发用旧的、路由用新的)。所以进程内只准有一份。
 *
 * flag(方案 §7 步 4):`OC_MODEL_AUTHORITY=1` = 判定权切到 catalog(强制);未开 = 影子期
 * (catalog 照常加载并与 legacy 对比打日志,但不参与拒绝)。**两种模式都会加载 catalog** ——
 * 影子期的价值就在于用真实流量证明"切过去不会改变任何请求的命运"。
 *
 * fail-closed 启动:catalog 首次快照拉不起来(0135 未 apply / DB 不可达)→ 抛。
 * 不允许"flag 开着但 catalog 空转"这种半开状态(每条请求都会被 fence 拒 = 全站静默不可用,
 * 还不如启动就响亮失败)。
 */

import type { AuthorityKeyring } from "@openclaude/protocol";

import { ModelCatalogCache } from "./modelCatalog.js";
import { checkSnapshotCapabilities } from "../http/proxy/upstream.js";
import { AuthoritySigner } from "../ws/authoritySigner.js";
import { rootLogger } from "../logging/logger.js";

const log = rootLogger.child({ subsys: "modelCatalogRuntime" });

let cache: ModelCatalogCache | null = null;
let starting: Promise<ModelCatalogCache> | null = null;
let signer: AuthoritySigner | null = null;

/** `OC_MODEL_AUTHORITY=1` —— 判定权在 catalog(强制模式)。未开 = 影子期。 */
export function isModelAuthorityEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OC_MODEL_AUTHORITY === "1";
}

/**
 * 取(必要时初始化)本进程唯一的 catalog cache。幂等 + 单飞。
 * 首次调用会:load 快照 → startListener(epoch/catalog NOTIFY)。失败 → 抛(fail-closed)。
 */
export async function getModelCatalogCache(): Promise<ModelCatalogCache> {
  if (cache) return cache;
  if (starting) return starting;
  starting = (async () => {
    const c = new ModelCatalogCache();
    c.onError = (err) => {
      log.error("catalog_cache_error", { err: (err as Error)?.message ?? String(err) });
    };
    // 每次重建(含 admin 激活触发的 NOTIFY)都体检一遍能力上限:配错的行要在被第一个用户
    // 撞到之前喊出来。这里只能告警(NOTIFY 回调里抛没人接);启动路径下面会硬断言。
    c.onRebuild = (snap) => {
      const violations = checkSnapshotCapabilities(snap);
      if (violations.length > 0) {
        log.error("catalog_capability_violations", { violations });
      }
    };
    await c.rebuild();
    await c.startListener();
    // 启动断言(方案 §4 "启动/激活期断言"):enforce 期一条违规就拒启 —— 带着"声明能识图但
    // 上游是纯文本端点"这种行上线,等于给用户发一个必然 400 的模型。
    const violations = checkSnapshotCapabilities(c.current());
    if (violations.length > 0) {
      if (isModelAuthorityEnforced()) {
        throw new Error(
          `[model-catalog] capability exceeds provider mechanism limits: ${violations.join("; ")}`,
        );
      }
      log.error("catalog_capability_violations_shadow", { violations });
    }
    cache = c;
    log.info("catalog_cache_ready", {
      securityEpoch: c.current().securityEpoch.toString(),
      executionRevision: c.current().executionRevision.slice(0, 12),
      enforced: isModelAuthorityEnforced(),
    });
    return c;
  })().finally(() => {
    starting = null;
  });
  return starting;
}

/** 已初始化的 cache(未初始化 → null)。诊断/装配判定用,不做懒初始化。 */
export function peekModelCatalogCache(): ModelCatalogCache | null {
  return cache;
}

/**
 * authority **公钥** keyring 的取数函数(验签侧用;私钥只在签发侧)。
 *
 * 每次调用现取 —— 轮换五步(R3-M7)期间 ring 会变(加新公钥 / 删旧公钥),闭包快照会让
 * egress 在轮换窗口里认不出新签名。AuthoritySigner 内部持文件态,取 keyring 是内存操作。
 *
 * egress 与 master 同机、同 root、读同一份 keyring 文件(/var/lib/openclaude/.v5-model-authority-keys)。
 */
export function authorityKeyringProvider(): () => AuthorityKeyring {
  return () => {
    if (!signer) signer = AuthoritySigner.loadOrCreate();
    return signer.publicKeyring();
  };
}

/** 测试用:清空进程级单例。 */
export function _resetModelCatalogRuntimeForTests(): void {
  cache = null;
  starting = null;
  signer = null;
}
