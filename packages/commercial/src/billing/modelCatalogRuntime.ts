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
 * fail-closed 启动:catalog 首次快照拉不起来(0143 未 apply / DB 不可达)→ 抛。
 * 不允许"flag 开着但 catalog 空转"这种半开状态(每条请求都会被 fence 拒 = 全站静默不可用,
 * 还不如启动就响亮失败)。
 */

import type { AuthorityKeyring } from "@openclaude/protocol";

import { ModelCatalogCache } from "./modelCatalog.js";
import { checkSnapshotCapabilities } from "../http/proxy/upstream.js";
import { AuthorityKeyringReader } from "../ws/authoritySigner.js";
import { rootLogger } from "../logging/logger.js";

const log = rootLogger.child({ subsys: "modelCatalogRuntime" });

let cache: ModelCatalogCache | null = null;
let starting: Promise<ModelCatalogCache> | null = null;
/** 验签侧的**只读** keyring(私钥不在本进程;文件变更热重载)。 */
let keyringReader: AuthorityKeyringReader | null = null;

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
 * authority **公钥** keyring 的取数函数(验签侧用;**私钥只在 master 的 AuthoritySigner**)。
 *
 * 整改前(代码审 R1 MAJOR-3):这里拿的是 `AuthoritySigner.loadOrCreate()` ——
 *   ① 它会在文件缺失时**创建** keyring:egress(一个纯验签进程)因此具备铸私钥的能力,
 *      与 master 并发首启就是双钥竞态(rename 互相覆盖 → master 签 B、egress 只认 A);
 *   ② "每请求现取"取的是常驻对象的**内存**,文件被轮换换掉了也不重读 —— 轮换窗口里
 *      egress 恒用旧 ring,新 keyId 的签名一律 UnknownKey。
 *
 * 现在换成 `AuthorityKeyringReader`:
 *   - **只读**、不创建(文件缺失 → 空 ring → 验签方 fail-closed 拒帧,不静默造钥);
 *   - 每次取 ring 先 `stat`(ino+mtime+size),文件换了就重读 → **热重载**,轮换期间
 *     egress 不必重启也认得新公钥。
 *
 * egress 与 master 同机、同 root、读同一份 keyring 文件(/var/lib/openclaude/.v5-model-authority-keys)。
 */
export function authorityKeyringProvider(): () => AuthorityKeyring {
  return () => {
    if (!keyringReader) keyringReader = AuthorityKeyringReader.open();
    return keyringReader.keyring();
  };
}

/** 测试用:清空进程级单例。 */
export function _resetModelCatalogRuntimeForTests(): void {
  cache = null;
  starting = null;
  keyringReader = null;
}
