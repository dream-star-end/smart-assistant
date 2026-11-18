/** Immutable runtime tuple consumed by provisioning and staleness checks. */
// ───────────────────────────────────────────────────────────────────────
// 公共类型
// ───────────────────────────────────────────────────────────────────────

/**
 * v5 runtime tuple(热生效改造,plan §1)。仅 v5 channel + 显式配置时真正生效。
 *
 * 分工:
 *   - provision:挂平台稳定根(→ /run/oc/platform:ro)+ release(→ /opt/openclaude:ro)、
 *     打 4 个 runtime label、注入 3 个平台 env。**昂贵的全量 bundle 校验(逐文件 sha256)
 *     不在这里做**,而在 index.ts 启动期一次性 resolvePlatformBundleMount / resolveRuntimeReleaseMount
 *     完成后把结果(bundleRev/bootHash/resolved 路径)灌进本结构;provision 每次只做便宜的
 *     `assertCurrentMatches`(current symlink realpath 对照,防激活中间态)。
 *   - ensureRunning:desired 三元组(imageId / release / bootHash)做 runtimeStale 判定。
 *
 * 字段全 optional:未配置(v3 常态)→ 整套逻辑跳过,provision/ensureRunning 行为逐字节同旧。
 */
export interface V3RuntimeTuple {
  /**
   * OC_RUNTIME_IMAGE_ID —— 部署时验证过的 immutable image ID(sha256:...)。
   * label image_id 值 + runtimeStale 的 desired imageId。缺省 → runtimeStale 回落 tag 比较
   * (过渡兼容;**部署后必填**,否则同 tag 重指新镜像漏判,见 plan §1.1 R2-M4)。
   */
  imageId?: string;
  /** OC_PLATFORM_BUNDLE —— bundles/<bundleRev12>(内容 digest 命名)。assertCurrentMatches 对照目标。 */
  bundlePath?: string;
  /** 启动期解析:bundle realpath(== platform current 目标)。 */
  bundleResolvedPath?: string;
  /** 启动期解析:bundleRev(= digest12 = bundle 目录名)。label bundle_rev。 */
  bundleRev?: string;
  /** 启动期解析:bootHash(entrypoint/+seed/ 子集)。label boot_hash + runtimeStale desired。 */
  bootHash?: string;
  /** OC_RUNTIME_RELEASE —— releases/rel-<digest12>。 */
  releasePath?: string;
  /** 启动期解析:release realpath(bind /opt/openclaude:ro 的源;绝不挂 symlink)。 */
  releaseResolvedPath?: string;
  /** 平台稳定根(默认 DEFAULT_PLATFORM_ROOT);挂 /run/oc/platform:ro + assertCurrentMatches。 */
  platformRoot?: string;
  /** releases 根(默认 DEFAULT_RUNTIME_RELEASES_ROOT);release realpath 必在其下。 */
  releasesRoot?: string;
}
