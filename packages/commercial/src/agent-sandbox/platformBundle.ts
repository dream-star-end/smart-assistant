/**
 * V5 runtime tuple —— platform bundle / runtime release 校验与挂载解析。
 *
 * 见 docs/V5_RUNTIME_HOTCFG_PLAN.md §1(统一机制:runtime tuple 与 platform bundle)。
 *
 * 本文件是"热生效改造"里 supervisor 一侧的**结构校验权威**:
 *   - platform bundle(bin/entrypoint/prompts/seed/... + MANIFEST.json,内容 digest 命名,
 *     不可变)→ 挂稳定根 /run/oc/platform:ro,current symlink 原子翻转真热生效。
 *   - runtime release(源码树 + node_modules + ccb dist,rel-<digest12> 命名)→ ro 挂
 *     /opt/openclaude,配 runtimeStale 滚动。
 *
 * 单一实现不变量:baseline / platform bundle / release 三条校验链**共用**同一个
 * `assertBaselineLeaf`(owner=root / 非 group-other 可写 / 非 symlink / realpath 不逃逸),
 * 该函数原在 v3supervisor.ts,现移入本文件作为唯一权威,v3supervisor 的
 * `resolveCcbBaselineMounts` 从这里 import(避免两份漂移)。
 *
 * digest / bootHash 算法也在本文件收口(manifestDigestOf / bootHashOf),构建期
 * (deploy-v5.sh 的 bundle 打包脚本)与校验期(supervisor)**必须 import 同一个函数**,
 * 否则两侧算法漂移会让"目录名 rel-<digest> 与实际内容 digest 不一致"的守卫失效。
 */

import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import {
  basename as pathBasename,
  dirname as pathDirname,
  extname as pathExtname,
  isAbsolute as pathIsAbsolute,
  join as pathJoin,
  normalize as pathNormalize,
  sep as pathSep,
} from "node:path";

import { SupervisorError } from "./types.js";

// ───────────────────────────────────────────────────────────────────────
// 契约常量(四 agent 统一,不得偏离;见 plan §1 与任务共享契约)
// ───────────────────────────────────────────────────────────────────────

/** 平台稳定根默认路径。挂载源永不变(独立于 master 蓝绿 release 树),current 原子翻转。 */
export const DEFAULT_PLATFORM_ROOT = "/var/lib/openclaude-v5/platform";

/** releases 根默认路径。release realpath 必须落在其下(realpath 逃逸即拒)。 */
export const DEFAULT_RUNTIME_RELEASES_ROOT = "/var/lib/openclaude-v5/runtime-releases";

/** 平台稳定根在容器内的只读挂载点(挂根不挂 current;容器经 current/... 访问)。 */
export const PLATFORM_MOUNT_TARGET = "/run/oc/platform";

/** runtime release 在容器内的只读挂载点(bind resolved realpath,绝不挂 symlink 本身)。 */
export const RELEASE_MOUNT_TARGET = "/opt/openclaude";

/** 容器 runtime labels(channel-neutral;create 时打,runtimeStale + GC 读)。 */
export const RUNTIME_IMAGE_ID_LABEL_KEY = "com.openclaude.runtime.image_id";
export const RUNTIME_RELEASE_LABEL_KEY = "com.openclaude.runtime.release";
export const RUNTIME_BUNDLE_REV_LABEL_KEY = "com.openclaude.runtime.bundle_rev";
export const RUNTIME_BOOT_HASH_LABEL_KEY = "com.openclaude.runtime.boot_hash";

/** 瘦身镜像标记 label。=0 表示镜像未内嵌源码(EMBED_SOURCE=0),须有 release 兜底。 */
export const RUNTIME_EMBED_SOURCE_LABEL_KEY = "oc.runtime.embed_source";

/**
 * supervisor 注入容器的三个平台 env(仅 v5 channel + bundle 挂载生效时注入)。
 *   - PROMPTS_DIR:gateway 平台静态 prompt 文案文件化的读取根(LKG 快照,§4.2)。
 *   - DEFAULT_WORKSPACE:agent 默认 cwd,落 data named volume 内(容器重建文件仍在,§3.2)。
 *   - WEB_CONTEXT_BIN:oc-web-context 薄壳路径(经 current 走 rev-pinned bundle)。
 * 走 current symlink → 翻转对存量容器原子生效。
 */
export const OPENCLAUDE_PLATFORM_PROMPTS_DIR_VALUE = `${PLATFORM_MOUNT_TARGET}/current/prompts`;
export const OPENCLAUDE_DEFAULT_WORKSPACE_VALUE = "/home/agent/.openclaude/workspace";
export const OPENCLAUDE_WEB_CONTEXT_BIN_VALUE = `${PLATFORM_MOUNT_TARGET}/current/bin/oc-web-context`;

/**
 * platform bundle 顶层目录白名单(plan §1.3)。任何未声明的顶层条目 → 拒(不截断放行)。
 * MANIFEST.json 是唯一允许的顶层文件;其余全是目录。
 */
export const PLATFORM_BUNDLE_TOP_LEVEL = new Set<string>([
  "bin",
  "entrypoint",
  "etc-codex",
  "codex-skills",
  "seed",
  "prompts",
  "MANIFEST.json",
]);

/**
 * platform bundle **必需叶子**清单(plan §2 / M8)。resolvePlatformBundleMount 校验逐一存在 ——
 * 结构白名单 / 上限只堵"多出来的坏东西",不保证"该有的关键文件都在"。缺任一关键 boot/prompt/
 * seed/etc-codex 叶子的 bundle 会让容器 entrypoint/consumer 静默退化(读不到平台守则/能力文案/
 * codex 配置),必须在校验期 fail-closed 拒绝,而非等运行期才发现"平台配置半套"。
 *
 * **与 bash 侧(agent F 的 v5-runtime-release-lib.sh selfcheck)镜像同清单** —— 两侧任一改动
 * 先在 runtimeArtifactConformance.test.ts 红。路径均为相对 bundle 根的规范 POSIX 形态。
 */
export const PLATFORM_BUNDLE_REQUIRED_LEAVES: readonly string[] = [
  "entrypoint/entrypoint.ts",
  "entrypoint/platformBundle.ts",
  // supervisor 注入 OPENCLAUDE_WEB_CONTEXT_BIN=<current>/bin/oc-web-context;bundle 缺此薄壳 =
  // 注入了一条**死路径**(容器内 oc-web MCP 起不来,静默退化)。M2:提前到校验期 fail-closed。
  // 构建期 finalize_bundle 由 bin/oc-web-context.py 剥扩展名而来(与 F2 的 bash selfcheck 同清单)。
  "bin/oc-web-context",
  "seed/platform-seed.yaml",
  "prompts/platform-capabilities.md",
  "prompts/memory-instructions.md",
  "prompts/codex-preamble.md",
  "etc-codex/managed_config.toml",
  "etc-codex/model-catalog.local.json",
];

/** 文件扩展名白名单(plan §1.3)。MANIFEST.json 走 .json;其它文件必须命中其一。 */
export const PLATFORM_BUNDLE_FILE_EXTENSIONS = new Set<string>([
  ".sh",
  ".py",
  ".ts",
  ".toml",
  ".md",
  ".yaml",
  ".json",
]);

/**
 * boot 子集前缀(plan §1.4)。bootHash 只覆盖 entrypoint/ 与 seed/ 下的文件 ——
 * 纯 bin/prompts/etc-codex 翻新不改 boot_hash → 不触发无意义容器回收。
 */
export const PLATFORM_BUNDLE_BOOT_PREFIXES = ["entrypoint/", "seed/"] as const;

/** 结构上限(plan §1.3),超限一律拒绝(不截断放行,防"看似合规实则被塞入巨物")。 */
export const PLATFORM_BUNDLE_MAX_FILE_BYTES = 1 * 1024 * 1024; // 单文件 ≤ 1MB
export const PLATFORM_BUNDLE_MAX_TOTAL_BYTES = 32 * 1024 * 1024; // 总量 ≤ 32MB
export const PLATFORM_BUNDLE_MAX_DEPTH = 6; // 目录深度 ≤ 6(顶层=1)
export const PLATFORM_BUNDLE_MAX_ENTRIES = 512; // 条目总数(文件+目录)≤ 512

/**
 * 敏感名 denylist(plan §1.3)。任何 basename 命中即拒 —— 无论类型,防误把密钥/凭证
 * 打进 bundle 一路 ro 暴露给容器(bundle 本就该只放平台配置/薄壳)。
 * 正则对 basename 匹配。
 */
export const PLATFORM_BUNDLE_SENSITIVE_NAME_PATTERNS: RegExp[] = [
  /^\.env($|\.)/i, // .env / .env.local ...
  /^id_rsa($|\.)/i, // id_rsa / id_rsa.pub ...
  /\.pem$/i,
  /\.key$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
];

// ───────────────────────────────────────────────────────────────────────
// 单一实现:baseline / bundle / release 共用的 leaf 不变量校验
// (从 v3supervisor.ts 移入,保持原语义与注释;v3supervisor 反向 import)
// ───────────────────────────────────────────────────────────────────────

/**
 * 校验单个叶子路径(文件或目录):
 *   - lstat 必须是对应类型(`file` / `dir`),**拒绝 symlink**(避免把 /etc/shadow 之类
 *     挂进容器 ro 暴露)
 *   - realpath 必须严格在 root 下(把"软链逃逸到 root 外"堵死)
 *   - owner 必须是 root(uid=0)—— 非 root owned 说明部署态失控,直接拒
 *   - mode 不允许 group/other 可写(020/002),防被非 root 用户改
 *
 * 返回 normalized 绝对路径(和 realpath 一致,消除软链影响),失败抛 Error(调用方捕获)。
 *
 * 这是 baseline / platform bundle / release 三条链**共用**的最小不变量;各调用方在此之上
 * 再叠加各自的白名单/上限/denylist(单一实现,防三份漂移)。
 */
export function assertBaselineLeaf(
  leafPath: string,
  expected: "file" | "dir",
  baselineRoot: string,
): string {
  const st = lstatSync(leafPath);
  if (st.isSymbolicLink()) {
    throw new Error(`baseline leaf is a symlink: ${leafPath}`);
  }
  if (expected === "file" && !st.isFile()) {
    throw new Error(`baseline leaf is not a regular file: ${leafPath}`);
  }
  if (expected === "dir" && !st.isDirectory()) {
    throw new Error(`baseline leaf is not a directory: ${leafPath}`);
  }
  if (st.uid !== 0) {
    throw new Error(`baseline leaf not owned by root (uid=${st.uid}): ${leafPath}`);
  }
  // 低 3 位按 rwx for user/group/other。要求 group-write & other-write 都为 0。
  if ((st.mode & 0o022) !== 0) {
    throw new Error(
      `baseline leaf group/other writable (mode=${(st.mode & 0o777).toString(8)}): ${leafPath}`,
    );
  }
  // realpath 双重兜底:确保最终 bind 源不在 baselineRoot 外面
  const real = realpathSync(leafPath);
  const rootReal = realpathSync(baselineRoot);
  // 允许 real === rootReal(baseline 根本身也允许),否则要求 real 在 rootReal 下
  if (real !== rootReal && !real.startsWith(rootReal + pathSep)) {
    throw new Error(`baseline leaf realpath escapes baselineRoot: ${leafPath} → ${real}`);
  }
  return real;
}

/**
 * 祖先目录链校验:从 realpath(dir) 逐级向上,每一级都必须 root-owned + 非 group/other 可写
 * + 非 symlink。
 *
 * 意义(plan §1.3 "祖先目录 owner/权限校验"):bundle/release 自身校验通过,但若某个祖先
 * 目录(如 /var/lib/openclaude-v5)可被非 root 写,攻击者能在"校验通过 → docker 挂载"
 * 之间替换整段路径造成 TOCTOU。锁死整条祖先链后该攻击面消失。
 *
 * `stopAt`:可信边界(inclusive)。给出时,校验到该目录(含)即止 —— 它之上的路径
 * (平台稳定根 / releases 根之外的 OS 目录如 /var、/)视为部署可信,不再逐级检查。
 * 生产由 index.ts 传 platformRoot / releasesRoot(两者本就 root-owned)。不给 → 一直走到
 * 文件系统根(最严;但会踩 /tmp 这类 world-writable 中间目录,故测试与非标准布局须传 stopAt)。
 *
 * **B5 containment 缺口**:给了 stopAt 但沿祖先链一直走到文件系统根都没遇到它 → 说明
 * resolvedPath **根本不在** stopAt 子树内(如 bundle 落在 platformRoot 之外),此时静默返回
 * 会漏掉整段"应受信任边界之外"的祖先检查。改为**未抵达 stopAt 必抛** —— 让"路径不在可信根下"
 * 这一类越界在祖先校验阶段就 fail-closed,而非依赖上层再补 containment。
 *
 * 失败抛 Error(调用方捕获)。
 */
export function assertSafeAncestry(resolvedPath: string, stopAt?: string): void {
  const stopReal = stopAt ? realpathSync(stopAt) : undefined;
  let cur = resolvedPath;
  // 逐级向上;dirname("/") === "/" 作为终止条件。
  for (;;) {
    const st = lstatSync(cur);
    // 祖先必须是目录(realpath 后不应再有 symlink,但显式拒守住)。
    if (st.isSymbolicLink()) {
      throw new Error(`ancestor is a symlink: ${cur}`);
    }
    if (st.uid !== 0) {
      throw new Error(`ancestor not owned by root (uid=${st.uid}): ${cur}`);
    }
    if ((st.mode & 0o022) !== 0) {
      throw new Error(
        `ancestor group/other writable (mode=${(st.mode & 0o777).toString(8)}): ${cur}`,
      );
    }
    if (stopReal && cur === stopReal) break; // 到达可信边界(inclusive)
    const parent = pathDirname(cur);
    if (parent === cur) {
      // 到达文件系统根。若指定了 stopAt 却始终没命中 → resolvedPath 不在 stopAt 子树内,拒。
      if (stopReal) {
        throw new Error(
          `ancestry walk reached filesystem root without hitting stopAt boundary (${stopReal}); path escapes trusted root: ${resolvedPath}`,
        );
      }
      break;
    }
    cur = parent;
  }
}

// ───────────────────────────────────────────────────────────────────────
// MANIFEST.json schema v1 + digest / bootHash 算法(构建期与校验期唯一权威)
// ───────────────────────────────────────────────────────────────────────

/**
 * MANIFEST.json 里 files[] 的单条目。
 *
 * **mode 约定(构建期与校验期必须逐字节一致)**:八进制字符串、无前导 0(如 "755"/"644"),
 * 与 bash 侧 `stat -c %a` 的输出完全同形 —— 构建期 MANIFEST 由 scripts/v5-runtime-release-lib.sh
 * (bash)生成,校验期由本文件重算,两边 digest 行拼接的是**同一串字符**。跨实现一致性由
 * runtimeArtifactConformance.test.ts 用真实 fixture 树双跑锁死(改任何一侧编码必先红那个门)。
 * digest 行拼接直接用 mode 字符串;磁盘校验比 `(lstat.mode & 0o7777).toString(8) === entry.mode`。
 * uid/gid/mtime 一律忽略(plan §1.2:内容 digest 只认内容,不认时间/属主漂移)。
 *
 * **symlink 行约定(M6;仅 runtime release 的 MANIFEST 会出现,bundle 侧仍拒 symlink)**:
 *   release 树(node_modules 等)可含 symlink,MANIFEST 需把它编码进 files[] 才能进 digest。
 *   与 bash 侧(agent F 的 v5-runtime-release-lib.sh)**逐字节一致**的约定:
 *     - `path`   = 链本身的相对路径;
 *     - `sha256` = 字面串 `link:<readlink 原始 target>`(**不是** hash;消费方按 `link:` 前缀识别);
 *     - `size`   = 0;
 *     - `mode`   = "777"(Linux symlink 的 lstat %a 恒 777)。
 *   digest 行编码不变(仍是 `path\0<sha256字段>\0mode\n`),故 manifestDigestOf/bootHashOf
 *   无需特判 —— 它们只拼接字符串字段。跨实现一致性由 runtimeArtifactConformance.test.ts 锁死。
 *   注:release 侧 resolveRuntimeReleaseMount **不**逐条比对 MANIFEST(大树太贵),symlink 的
 *   安全边界由启动期 lstat-only 结构深校验(target 相对 + normalize 不逃逸)独立兜底,见其注释。
 */
export interface ManifestFileEntry {
  /** 规范化相对路径(相对 bundle/release 根,POSIX 分隔,不以 / 开头)。 */
  path: string;
  /** 文件内容 sha256(hex 全长);symlink 行为字面串 `link:<readlink 原始 target>`(见上)。 */
  sha256: string;
  /** 文件字节数;symlink 行恒 0。 */
  size: number;
  /** permission bits,八进制字符串(见上方 mode 约定);symlink 行恒 "777"。 */
  mode: string;
}

/** MANIFEST.json schema v1(plan 共享契约)。files 不含 MANIFEST.json 自身。 */
export interface PlatformBundleManifest {
  schemaVersion: 1;
  /** 对 files 表求的内容 digest(前 12 hex);= bundle 目录名 rel/bundleRev 的 <digest12>。 */
  digest: string;
  /** entrypoint/ + seed/ 子集的 boot hash(前 12 hex)。 */
  bootHash: string;
  /** 构建源 full SHA(审计;不进 digest)。 */
  sourceCommit?: string;
  builtAt?: string;
  bunVersion?: string;
  depsCacheKey?: string;
  files: ManifestFileEntry[];
}

/**
 * 对 files 子集求 digest:逐行拼 `path \0 sha256 \0 mode \n`(path 升序),整体 sha256 取前 12 hex。
 *
 * **唯一权威**:构建期打包脚本与本文件校验必须调同一函数(禁各写一份)。忽略 uid/gid/mtime。
 */
function digest12Of(
  files: ReadonlyArray<ManifestFileEntry>,
  filterPrefixes?: ReadonlyArray<string>,
): string {
  const rows = filterPrefixes
    ? files.filter((f) => filterPrefixes.some((p) => f.path.startsWith(p)))
    : files;
  const sorted = [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash("sha256");
  for (const f of sorted) {
    h.update(`${f.path}\0${f.sha256}\0${f.mode}\n`, "utf8");
  }
  return h.digest("hex").slice(0, 12);
}

/** 对整个 files 表求 bundle digest(前 12 hex)。 */
export function manifestDigestOf(files: ReadonlyArray<ManifestFileEntry>): string {
  return digest12Of(files);
}

/** 对 entrypoint/ + seed/ 子集求 bootHash(前 12 hex)。 */
export function bootHashOf(files: ReadonlyArray<ManifestFileEntry>): string {
  return digest12Of(files, PLATFORM_BUNDLE_BOOT_PREFIXES);
}

// ───────────────────────────────────────────────────────────────────────
// platform bundle:结构校验 + 挂载解析
// ───────────────────────────────────────────────────────────────────────

/** resolvePlatformBundleMount 成功返回。 */
export interface ResolvedPlatformBundle {
  /** bundle realpath(== platform current 的目标)。仅用于 assertCurrentMatches 对照。 */
  resolvedPath: string;
  /** bundleRev(= digest12 = bundle 目录名);label bundle_rev。 */
  bundleRev: string;
  /** bootHash(entrypoint/+seed/ 子集);label boot_hash + runtimeStale。 */
  bootHash: string;
}

/**
 * 递归收集 bundle 内所有文件条目并施加结构不变量(plan §1.3 全部规则)。
 * 返回收集到的 { path, sha256, size, mode } 列表(不含 MANIFEST.json 自身)。
 *
 * 施加(超限一律抛,不截断放行):
 *   - 每级 assertBaselineLeaf(root owned / 非 group-other 可写 / 非 symlink / realpath 不逃逸)
 *   - 类型白名单:仅 regular file / dir;symlink/device/socket/FIFO 拒
 *   - nlink>1(硬链)拒
 *   - 顶层白名单(仅第一层,PLATFORM_BUNDLE_TOP_LEVEL)
 *   - 文件扩展名白名单
 *   - 敏感名 denylist
 *   - 单文件 ≤1MB / 总量 ≤32MB / 深度 ≤6 / 条目 ≤512
 */
function collectBundleFiles(bundleRoot: string): ManifestFileEntry[] {
  const out: ManifestFileEntry[] = [];
  let totalBytes = 0;
  let entryCount = 0;

  // relPrefix 为 POSIX 相对路径(不含前导 /);depth 顶层目录内条目 = 1。
  const walk = (absDir: string, relPrefix: string, depth: number): void => {
    if (depth > PLATFORM_BUNDLE_MAX_DEPTH) {
      throw new Error(`bundle depth exceeds ${PLATFORM_BUNDLE_MAX_DEPTH} at: ${relPrefix || "."}`);
    }
    // 排序保证遍历确定性(digest 无关但错误信息稳定)。
    const names = readdirSync(absDir).sort();
    for (const name of names) {
      // MANIFEST.json 仅顶层允许,且不进 files 表(schema 不含自身)。
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      const abs = pathJoin(absDir, name);

      // 顶层白名单:只在第一层拦(depth===1 即顶层条目)。
      if (depth === 1 && !PLATFORM_BUNDLE_TOP_LEVEL.has(name)) {
        throw new Error(`bundle has undeclared top-level entry: ${name}`);
      }
      // 敏感名 denylist(任意层、任意类型)。
      if (PLATFORM_BUNDLE_SENSITIVE_NAME_PATTERNS.some((re) => re.test(name))) {
        throw new Error(`bundle contains sensitive-named entry: ${rel}`);
      }

      const st = lstatSync(abs);
      // 类型白名单:symlink / device / socket / FIFO 一律拒(只允许 regular file / dir)。
      if (st.isSymbolicLink()) throw new Error(`bundle entry is a symlink: ${rel}`);
      if (!st.isFile() && !st.isDirectory()) {
        throw new Error(`bundle entry is not a regular file or dir: ${rel}`);
      }
      // 硬链(nlink>1)拒:防同 inode 在 bundle 外另有可写引用绕过内容不可变。
      // **仅对 regular file** —— 目录 nlink 天生 ≥2(自身 `.` + 父 entry + 每个子目录 +1),不是硬链信号。
      if (st.isFile() && st.nlink > 1) {
        throw new Error(`bundle file has hardlink (nlink=${st.nlink}): ${rel}`);
      }

      entryCount += 1;
      if (entryCount > PLATFORM_BUNDLE_MAX_ENTRIES) {
        throw new Error(`bundle entries exceed ${PLATFORM_BUNDLE_MAX_ENTRIES}`);
      }

      if (st.isDirectory()) {
        // 目录也走 leaf 不变量(root owned / 非可写 / realpath 不逃逸)。
        assertBaselineLeaf(abs, "dir", bundleRoot);
        walk(abs, rel, depth + 1);
        continue;
      }

      // 顶层 MANIFEST.json:文件,但不入 files 表(自身),仍要求 leaf 不变量。
      if (depth === 1 && name === "MANIFEST.json") {
        assertBaselineLeaf(abs, "file", bundleRoot);
        continue;
      }

      // suid/sgid/sticky 一律拒:bundle 只放平台配置/薄壳,任何特殊位都是部署态失控信号
      // (也保证 mode 八进制串恒 ≤3 位,与 bash `stat -c %a` 无歧义对齐)。
      if ((st.mode & 0o7000) !== 0) {
        throw new Error(
          `bundle file has special mode bits (${(st.mode & 0o7777).toString(8)}): ${rel}`,
        );
      }

      // 扩展名规则:bin/ 下必须**无扩展名**且 owner 可执行(PATH 命令名即工具名,
      // `oc-docx` 而非 `oc-docx.sh`;构建期 finalize_bundle 负责剥 .sh/.py);
      // 其余目录走扩展名白名单。两侧规则同源:v5-runtime-release-lib.sh selfcheck。
      const ext = pathExtname(name).toLowerCase();
      if (rel.startsWith("bin/")) {
        if (ext !== "") {
          throw new Error(
            `bundle bin/ entry must be extensionless (finalize_bundle strips .sh/.py): ${rel}`,
          );
        }
        if ((st.mode & 0o100) === 0) {
          throw new Error(`bundle bin/ entry must be owner-executable: ${rel}`);
        }
      } else if (!PLATFORM_BUNDLE_FILE_EXTENSIONS.has(ext)) {
        throw new Error(`bundle file has disallowed extension "${ext}": ${rel}`);
      }
      assertBaselineLeaf(abs, "file", bundleRoot);
      if (st.size > PLATFORM_BUNDLE_MAX_FILE_BYTES) {
        throw new Error(`bundle file exceeds ${PLATFORM_BUNDLE_MAX_FILE_BYTES} bytes: ${rel}`);
      }
      totalBytes += st.size;
      if (totalBytes > PLATFORM_BUNDLE_MAX_TOTAL_BYTES) {
        throw new Error(`bundle total size exceeds ${PLATFORM_BUNDLE_MAX_TOTAL_BYTES} bytes`);
      }
      const sha256 = createHash("sha256").update(readFileSync(abs)).digest("hex");
      out.push({ path: rel, sha256, size: st.size, mode: (st.mode & 0o777).toString(8) });
    }
  };

  walk(bundleRoot, "", 1);
  return out;
}

/**
 * platform bundle 结构校验 + 挂载解析(plan §1.3)。
 *
 * 完整校验链(任一失败抛 SupervisorError("PlatformBundleInvalid")):
 *   1. 非空绝对路径;
 *   2. bundle 目录本身 + 祖先链 leaf 不变量(root owned / 非 group-other 可写 / 非 symlink);
 *      B5.1:给了 ancestorRoot 却沿祖先链走到根都没命中 → 拒(路径逃逸可信根)。
 *   3. B5.2 containment:给了 opts.platformRoot 时,resolved 必须严格落在 `<platformRoot>/bundles/` 下;
 *   4. 有界递归 collectBundleFiles(顶层白名单 / 类型白名单 / 扩展名白名单 / denylist /
 *      单文件≤1MB / 总量≤32MB / 深度≤6 / 条目≤512);
 *   5. M8 必需叶子:PLATFORM_BUNDLE_REQUIRED_LEAVES 逐一存在;
 *   6. MANIFEST.json 存在、schemaVersion=1;
 *   7. 磁盘实际条目集合 ≡ MANIFEST.files 路径集合(逐一);每文件 sha256 与 mode 相符;
 *   8. manifestDigestOf(files) === MANIFEST.digest;bootHashOf(files) === MANIFEST.bootHash;
 *   9. bundle 目录名 basename === MANIFEST.digest(内容 digest 命名不变量)。
 *
 * 返回 { resolvedPath, bundleRev, bootHash }。
 *
 * **调用位置(plan §1.5)**:昂贵的全量校验(逐文件 sha256)在 deploy prepare 与 gateway
 * 启动期各跑一次(index.ts),**不**在每次 provision 重复(避免每个容器冷启都 hash 32MB)。
 * 每次 provision 只做便宜的 `assertCurrentMatches`(realpath 对照),见其注释。
 */
export function resolvePlatformBundleMount(
  bundlePath: string,
  opts?: { ancestorRoot?: string; platformRoot?: string },
): ResolvedPlatformBundle {
  if (typeof bundlePath !== "string" || bundlePath.trim() === "") {
    throw new SupervisorError("PlatformBundleInvalid", "platform bundle path is empty");
  }
  if (!pathIsAbsolute(bundlePath)) {
    throw new SupervisorError("PlatformBundleInvalid", `platform bundle path must be absolute: ${bundlePath}`);
  }
  const abs = pathNormalize(bundlePath).replace(/(?<!^)\/+$/, "");
  try {
    // bundle 根本身 leaf 不变量 + 祖先链锁死(TOCTOU 防御;stopAt=platformRoot,生产由 index.ts 传)。
    assertBaselineLeaf(abs, "dir", abs);
    const resolvedPath = realpathSync(abs);
    assertSafeAncestry(resolvedPath, opts?.ancestorRoot);

    // B5 显式 containment:给了 platformRoot(生产由 index.ts 传 config 稳定根)时,resolved 必须
    // 严格位于 `<platformRoot>/bundles/` 下 —— bundle 目录名是内容 digest,但"落在哪个根的
    // bundles/ 下"是布局契约(current 只翻到 bundles/<rev>)。不在其下 = 越界布局,拒。
    if (opts?.platformRoot != null) {
      let platformRootReal: string;
      try {
        platformRootReal = realpathSync(opts.platformRoot);
      } catch (e) {
        throw new Error(`platform root unresolvable (${opts.platformRoot}): ${(e as Error).message}`);
      }
      const bundlesPrefix = pathJoin(platformRootReal, "bundles") + pathSep;
      if (!resolvedPath.startsWith(bundlesPrefix)) {
        throw new Error(
          `bundle realpath must live under ${pathJoin(platformRootReal, "bundles")}/; got ${resolvedPath}`,
        );
      }
    }

    // 递归收集 + 结构不变量。
    const files = collectBundleFiles(resolvedPath);

    // M8 必需叶子:结构白名单只堵"多出来的坏东西",不保证关键文件都在。逐一断言必需 boot/prompt/
    // seed/etc-codex 叶子存在于收集到的 regular-file 集合(collectBundleFiles 已校过 leaf 不变量)。
    const diskPathSet = new Set(files.map((f) => f.path));
    for (const leaf of PLATFORM_BUNDLE_REQUIRED_LEAVES) {
      if (!diskPathSet.has(leaf)) {
        throw new Error(`bundle missing required leaf: ${leaf}`);
      }
    }

    // MANIFEST.json 解析。
    const manifestPath = pathJoin(resolvedPath, "MANIFEST.json");
    let manifest: PlatformBundleManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PlatformBundleManifest;
    } catch (e) {
      throw new Error(`MANIFEST.json missing or not valid JSON: ${(e as Error).message}`);
    }
    if (manifest.schemaVersion !== 1) {
      throw new Error(`MANIFEST.schemaVersion must be 1, got ${JSON.stringify(manifest.schemaVersion)}`);
    }
    if (!Array.isArray(manifest.files)) {
      throw new Error("MANIFEST.files must be an array");
    }

    // 磁盘条目集合 ≡ MANIFEST.files(逐一);sha256 / mode 相符。
    const manifestByPath = new Map<string, ManifestFileEntry>();
    for (const f of manifest.files) {
      if (f.path === "MANIFEST.json") {
        throw new Error("MANIFEST.files must not list MANIFEST.json itself");
      }
      manifestByPath.set(f.path, f);
    }
    if (manifestByPath.size !== files.length) {
      throw new Error(
        `disk has ${files.length} files, MANIFEST declares ${manifestByPath.size}`,
      );
    }
    for (const disk of files) {
      const decl = manifestByPath.get(disk.path);
      if (!decl) throw new Error(`disk file not declared in MANIFEST: ${disk.path}`);
      if (decl.sha256 !== disk.sha256) {
        throw new Error(`sha256 mismatch for ${disk.path}`);
      }
      // mode 是八进制字符串,直接串比(类型不对也在此兜住 —— 构建侧 jq 恒产字符串)。
      if (typeof decl.mode !== "string" || decl.mode !== disk.mode) {
        throw new Error(`mode mismatch for ${disk.path}`);
      }
    }

    // digest / bootHash 与 MANIFEST 声明一致;bundleRev(目录名)与 digest 一致。
    const digest = manifestDigestOf(manifest.files);
    if (digest !== manifest.digest) {
      throw new Error(`MANIFEST.digest ${manifest.digest} != recomputed ${digest}`);
    }
    const bootHash = bootHashOf(manifest.files);
    if (bootHash !== manifest.bootHash) {
      throw new Error(`MANIFEST.bootHash ${manifest.bootHash} != recomputed ${bootHash}`);
    }
    const bundleRev = pathBasename(resolvedPath);
    if (bundleRev !== digest) {
      throw new Error(`bundle dir name ${bundleRev} != content digest ${digest}`);
    }

    return { resolvedPath, bundleRev, bootHash };
  } catch (err) {
    if (err instanceof SupervisorError) throw err;
    throw new SupervisorError(
      "PlatformBundleInvalid",
      `platform bundle validation failed (${abs}): ${(err as Error).message}`,
    );
  }
}

/**
 * 断言 `${platformRoot}/current` 的 realpath 恰好等于 expectedBundlePath 的 realpath。
 *
 * 意义(plan §1.3 R2-M1 配套):env tuple(OC_PLATFORM_BUNDLE)与 current symlink 在
 * 激活 saga 里有一个短暂不一致窗口(约等于 restart 时长)。此时新 provision 若照旧挂
 * 平台根,容器会看到与 env 声明不一致的 bundle(混合版本)。断言 current == 声明 bundle,
 * 不等 = 激活中间态 → 拒 provision(前端 retry 兜底,与今日 restart 窗口同量级)。
 *
 * 这是**便宜的**每次 provision 检查(readlink + 两次 realpath),与昂贵的全量
 * resolvePlatformBundleMount(逐文件 sha256,启动期一次)分工。
 *
 * **R2-M5 错误码语义**:本函数的所有失败都是激活 saga 的**中间态**(current 尚未翻到声明 bundle /
 * 目标形态畸形 / current 暂不可读),属于正常的秒级窗口(≈ 一次 restart 时长),故抛
 * SupervisorError("RuntimeActivationInProgress") —— 让 v3ensureRunning 走 5s 短重试 + 不发 critical
 * (与 provisioning 同级),而非当永久坏产物吃 300s 长重试 + critical 告警。RuntimePlacementInvalid
 * 现专留给**多机 placement 硬门**(release 调度到非 self-host)。
 *
 * **B5 symlink 契约加固**:除 realpath 相等外,另断言 current 的 **readlink 原始目标** 恰为
 * 规范相对形态 `bundles/<12hex>`(bash `oc_hotcfg_flip_current` 产 `ln -s "bundles/$rev"`)。
 * 只比 realpath 会放过"current 指到别处再软链回来"或"current 是绝对/多级异常目标"的畸形布局;
 * 钉死原始目标形态 = current 只能是"指向本根 bundles/ 下某个 12hex rev 的相对链",堵住这类越界。
 */
const CURRENT_LINK_TARGET_RE = /^bundles\/[0-9a-f]{12}$/;

export function assertCurrentMatches(platformRoot: string, expectedBundlePath: string): void {
  const currentLink = pathJoin(platformRoot, "current");
  // 先看原始 symlink 目标形态(readlink,不解析);非规范相对形态即拒(激活布局被污染)。
  let rawTarget: string;
  try {
    rawTarget = readlinkSync(currentLink);
  } catch (e) {
    throw new SupervisorError(
      "RuntimeActivationInProgress",
      `platform current symlink unreadable (${currentLink}): ${(e as Error).message}`,
    );
  }
  if (!CURRENT_LINK_TARGET_RE.test(rawTarget)) {
    throw new SupervisorError(
      "RuntimeActivationInProgress",
      `platform current target must be canonical relative "bundles/<12hex>"; got ${JSON.stringify(rawTarget)}`,
    );
  }
  let currentReal: string;
  let expectedReal: string;
  try {
    currentReal = realpathSync(currentLink);
  } catch (e) {
    throw new SupervisorError(
      "RuntimeActivationInProgress",
      `platform current symlink unresolvable (${currentLink}): ${(e as Error).message}`,
    );
  }
  try {
    expectedReal = realpathSync(expectedBundlePath);
  } catch (e) {
    throw new SupervisorError(
      "RuntimeActivationInProgress",
      `expected bundle path unresolvable (${expectedBundlePath}): ${(e as Error).message}`,
    );
  }
  if (currentReal !== expectedReal) {
    throw new SupervisorError(
      "RuntimeActivationInProgress",
      `platform activation mid-state: current=${currentReal} != expected=${expectedReal}`,
    );
  }
}

// ───────────────────────────────────────────────────────────────────────
// runtime release:结构校验 + 挂载解析
// ───────────────────────────────────────────────────────────────────────

/**
 * runtime release 树**结构深校验**(M6;plan §3.2)。启动期一次,**lstat-only 不 hash 内容**
 * —— release 含 node_modules 数万文件,内容完整性由内容寻址目录名 + deploy prepare 期一次性
 * 组装 digest 兜底;这里的深校验只锁"结构安全",递归 walk 整树每条 lstat:
 *   - owner=root(uid=0)—— 非 root owned = 部署态失控;
 *   - regular file / dir:非 group/other 可写(mode & 022 == 0);
 *   - symlink:target 必须**相对**且相对自身目录 normalize 后**不逃逸 release 树**
 *     (bundle 侧拒 symlink,release 侧允许 node_modules 内部相对链但堵越界);
 *   - file / dir / symlink **之外的类型**(device/socket/FIFO)一律拒。
 *
 * **无 env 逃生口**(设计承诺):fail-closed。任一条不满足抛 Error(调用方 wrap 成
 * SupervisorError("RuntimeReleaseInvalid"))。`releaseRoot` 必须是已 realpath 的绝对路径。
 * symlink 不跟进(不 walk 其 target),避免顺链走出树 / 无限环。
 */
function assertReleaseTreeStructure(releaseRoot: string): void {
  const walk = (absDir: string, relPrefix: string): void => {
    const names = readdirSync(absDir).sort();
    for (const name of names) {
      const abs = pathJoin(absDir, name);
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      const st = lstatSync(abs);
      if (st.uid !== 0) {
        throw new Error(`release entry not owned by root (uid=${st.uid}): ${rel}`);
      }
      if (st.isSymbolicLink()) {
        const target = readlinkSync(abs);
        if (pathIsAbsolute(target)) {
          throw new Error(`release symlink target must be relative: ${rel} -> ${target}`);
        }
        // 相对自身所在目录做**纯词法** normalize(不触碰 fs;target 可能尚不存在/本身也是链)。
        const resolvedTarget = pathNormalize(pathJoin(absDir, target));
        if (resolvedTarget !== releaseRoot && !resolvedTarget.startsWith(releaseRoot + pathSep)) {
          throw new Error(`release symlink target escapes release tree: ${rel} -> ${target}`);
        }
        continue; // 不跟进 symlink
      }
      if (st.isDirectory()) {
        if ((st.mode & 0o022) !== 0) {
          throw new Error(
            `release dir group/other writable (mode=${(st.mode & 0o777).toString(8)}): ${rel}`,
          );
        }
        walk(abs, rel);
        continue;
      }
      if (st.isFile()) {
        if ((st.mode & 0o022) !== 0) {
          throw new Error(
            `release file group/other writable (mode=${(st.mode & 0o777).toString(8)}): ${rel}`,
          );
        }
        continue;
      }
      // regular file / dir / symlink 之外的类型(device / socket / FIFO)一律拒。
      throw new Error(`release entry has forbidden type (not file/dir/symlink): ${rel}`);
    }
  };
  walk(releaseRoot, "");
}

/**
 * runtime release 校验 + 挂载解析(plan §3.2)。
 *
 * 校验链(任一失败抛 SupervisorError("InvalidArgument")):
 *   1. 非空绝对路径;
 *   2. realpath 落在 releasesRoot 下(逃逸即拒);
 *   3. release 目录 root-owned + 非 group-other 可写 + 非 symlink(leaf 不变量)+ 祖先链锁死;
 *   4. MANIFEST.json 存在,含 digest;
 *   5. 目录名 `rel-<digest12>` 的 <digest12> === MANIFEST.digest(命名一致);
 *   6. **结构深校验**(M6,lstat-only 不 hash 内容):递归整树,每条 owner=root / file·dir 非
 *      group-other 可写 / symlink target 相对且不逃逸 release 树 / 拒 file·dir·symlink 外类型。
 *      **无 env 逃生口**(fail-closed 设计承诺)。
 *
 * **与 bundle 不同**:release 含 node_modules + ccb dist(体量大),这里**不**逐文件重算
 * content digest(那要 hash 整棵 GB 级树,每次都做代价过高);内容完整性由 deploy prepare 期
 * 的一次性组装 digest(§3.1)+ 内容寻址目录名 + ro 挂载 + 祖先链锁死共同兜底。但结构安全
 * (owner/权限/类型/symlink 越界)由第 6 步 lstat-only 深校验独立兜底(~数万文件秒级)。
 *
 * 返回 resolved realpath(bind 到 /opt/openclaude:ro 的源;绝不挂 symlink 本身)。
 */
export function resolveRuntimeReleaseMount(
  releasePath: string,
  releasesRoot: string = DEFAULT_RUNTIME_RELEASES_ROOT,
): string {
  if (typeof releasePath !== "string" || releasePath.trim() === "") {
    throw new SupervisorError("RuntimeReleaseInvalid", "runtime release path is empty");
  }
  if (!pathIsAbsolute(releasePath)) {
    throw new SupervisorError("RuntimeReleaseInvalid", `runtime release path must be absolute: ${releasePath}`);
  }
  const abs = pathNormalize(releasePath).replace(/(?<!^)\/+$/, "");
  try {
    assertBaselineLeaf(abs, "dir", abs);
    const resolvedPath = realpathSync(abs);

    // realpath 必须落在 releasesRoot 下(root===本身或严格子路径)。
    let rootReal: string;
    try {
      rootReal = realpathSync(releasesRoot);
    } catch (e) {
      throw new Error(`releases root unresolvable (${releasesRoot}): ${(e as Error).message}`);
    }
    if (resolvedPath !== rootReal && !resolvedPath.startsWith(rootReal + pathSep)) {
      throw new Error(`release realpath escapes releases root: ${resolvedPath} not under ${rootReal}`);
    }
    // 祖先链锁死到 releases 根(inclusive);根之上视为部署可信(OS 目录)。
    assertSafeAncestry(resolvedPath, rootReal);

    // MANIFEST.json 存在 + digest ↔ 目录名一致。
    const manifestPath = pathJoin(resolvedPath, "MANIFEST.json");
    let manifest: { digest?: unknown };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { digest?: unknown };
    } catch (e) {
      throw new Error(`release MANIFEST.json missing or not valid JSON: ${(e as Error).message}`);
    }
    if (typeof manifest.digest !== "string" || manifest.digest.trim() === "") {
      throw new Error("release MANIFEST.digest missing");
    }
    const base = pathBasename(resolvedPath);
    const m = /^rel-([0-9a-f]{12})$/.exec(base);
    if (!m) {
      throw new Error(`release dir name must be rel-<digest12>, got: ${base}`);
    }
    if (m[1] !== manifest.digest) {
      throw new Error(`release dir digest ${m[1]} != MANIFEST.digest ${manifest.digest}`);
    }

    // M6 结构深校验(lstat-only,不 hash 内容):整树 owner/权限/类型/symlink 越界(见函数注释)。
    // **无 env 逃生口**:fail-closed 是设计承诺。
    assertReleaseTreeStructure(resolvedPath);

    return resolvedPath;
  } catch (err) {
    if (err instanceof SupervisorError) throw err;
    throw new SupervisorError(
      "RuntimeReleaseInvalid",
      `runtime release validation failed (${abs}): ${(err as Error).message}`,
    );
  }
}
