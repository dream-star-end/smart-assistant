/**
 * V5 runtime tuple —— platformBundle.ts 校验矩阵单测。
 *
 * 覆盖:
 *   - resolvePlatformBundleMount:每条 §1.3 规则至少一个"拒绝"+一个"通过";digest/bootHash
 *     返回;MANIFEST 与实际 sha256/条目相符;结构上限(单文件/深度/条目/顶层白名单/扩展名/
 *     denylist/类型);祖先链;dir 名 == digest;**M8 必需叶子**;**B5.2 containment**(resolved
 *     必须落在 <platformRoot>/bundles/ 下)。错误码 = PlatformBundleInvalid。
 *   - assertSafeAncestry:**B5.1**(给了 stopAt 却走到根未命中 → 抛)。
 *   - assertCurrentMatches:current==bundle 通过,不等抛(激活中间态);**B5.3**(readlink 原始
 *     目标须规范相对 bundles/<12hex>)。R2-M5 错误码 = RuntimeActivationInProgress(秒级激活窗口,
 *     与永久坏产物的 RuntimePlacementInvalid 分离)。
 *   - resolveRuntimeReleaseMount:realpath 在 releases 根下 / root-owned / 非可写 / MANIFEST
 *     digest ↔ 目录名一致;**M6 结构深校验**(owner/权限/类型/symlink 越界)。错误码 = RuntimeReleaseInvalid。
 *
 * 运行:npx tsx --test packages/commercial/src/__tests__/platformBundle.test.ts
 *
 * 全部用真实临时目录 + 真实权限位翻转(参考 ccbBaselineSkills / v3Supervisor 的 baseline 用例风格)。
 * assertBaselineLeaf 要求 uid=0(root owned),故非 root 环境整组 skip(与既有 baseline 用例一致)。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import {
  resolvePlatformBundleMount,
  assertCurrentMatches,
  assertSafeAncestry,
  resolveRuntimeReleaseMount,
  manifestDigestOf,
  bootHashOf,
  PLATFORM_BUNDLE_MAX_FILE_BYTES,
  PLATFORM_BUNDLE_MAX_ENTRIES,
  PLATFORM_BUNDLE_REQUIRED_LEAVES,
  type ManifestFileEntry,
  SupervisorError,
} from "../agent-sandbox/index.js";

const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

// ───────────────────────────────────────────────────────────────────────
//  bundle 构造 helper —— 建一棵合规树,按内容 digest 命名目录,写 MANIFEST。
// ───────────────────────────────────────────────────────────────────────

/** 写文件 + chmod 0644(root owned,非 group/other 可写)。 */
function writeFile644(abs: string, content: string): void {
  writeFileSync(abs, content);
  chmodSync(abs, 0o644);
}

/** 建目录 + chmod 0755(root owned,非 group/other 可写)。 */
function mkdir755(abs: string): void {
  mkdirSync(abs, { recursive: true });
  chmodSync(abs, 0o755);
}

interface BuiltBundle {
  /** 稳定根(= platformRoot;bundle 落其 bundles/<digest> 下)。 */
  ancestorRoot: string;
  bundleDir: string;
  digest: string;
  bootHash: string;
}

/**
 * bundle 合规内容:含全部 PLATFORM_BUNDLE_REQUIRED_LEAVES(M8)+ 一个 bin/ 工具。
 * 键 = 相对 bundle 根路径,值 = 文件内容。
 */
function bundleContents(): Record<string, string> {
  return {
    "bin/oc-tool": "#!/bin/sh\necho hi\n",
    // M2:bin/oc-web-context 现为必需叶子(supervisor 注入 OPENCLAUDE_WEB_CONTEXT_BIN 指向它)。
    "bin/oc-web-context": "#!/bin/sh\nexec echo web-context\n",
    "entrypoint/entrypoint.ts": "export const boot = 1;\n",
    "entrypoint/platformBundle.ts": "export const bundle = 1;\n",
    "seed/platform-seed.yaml": "schemaVersion: 1\nagents: []\n",
    "prompts/platform-capabilities.md": "# Platform capabilities\n",
    "prompts/memory-instructions.md": "# Memory\n",
    "prompts/codex-preamble.md": "# preamble\n",
    "etc-codex/managed_config.toml": "check_for_update_on_startup = false\n",
  };
}

/**
 * 在 `ancestorRoot/bundles/<digest>` 建一个合规 bundle,目录名 = 内容 digest。
 * 返回路径 + digest/bootHash。ancestorRoot 即 platformRoot(bundle 落其 bundles/ 下,
 * 满足 B5.2 containment 与 assertCurrentMatches 的 bundles/<rev> 相对链契约)。
 *
 * MANIFEST.files 用磁盘实际 sha256/mode 填,digest/bootHash 用 manifestDigestOf/bootHashOf
 * 算(与被测校验同一权威),保证自洽。
 */
function buildValidBundle(): BuiltBundle {
  const ancestorRoot = mkdtempSync(pathJoin(tmpdir(), "oc-bundle-"));
  chmodSync(ancestorRoot, 0o755); // ancestry 边界:root owned 0755
  const bundlesDir = pathJoin(ancestorRoot, "bundles");
  mkdir755(bundlesDir);
  // 先建到一个临时名(bundles/.staging),填完算 digest 再 rename。
  const staging = pathJoin(bundlesDir, ".staging");
  for (const d of ["bin", "entrypoint", "seed", "prompts", "etc-codex"]) {
    mkdir755(pathJoin(staging, d));
  }

  const contents = bundleContents();
  for (const [rel, body] of Object.entries(contents)) {
    writeFile644(pathJoin(staging, rel), body);
    // bin/ 下必须 owner 可执行(collectBundleFiles bin 规则),其余保持 0644。
    if (rel.startsWith("bin/")) chmodSync(pathJoin(staging, rel), 0o755);
  }

  const files: ManifestFileEntry[] = Object.keys(contents)
    .sort()
    .map((rel) => {
      const abs = pathJoin(staging, rel);
      const st = statSync(abs);
      return {
        path: rel,
        sha256: createHash("sha256").update(Buffer.from(contents[rel]!)).digest("hex"),
        size: st.size,
        mode: (st.mode & 0o777).toString(8),
      };
    });

  const digest = manifestDigestOf(files);
  const bootHash = bootHashOf(files);

  // rename staging → bundles/<digest>
  const bundleDir = pathJoin(bundlesDir, digest);
  renameSync(staging, bundleDir);

  // 写 MANIFEST.json(不进 files 表)。
  const manifest = { schemaVersion: 1, digest, bootHash, sourceCommit: "deadbeef", files };
  writeFile644(pathJoin(bundleDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2));

  return { ancestorRoot, bundleDir, digest, bootHash };
}

function cleanup(b: BuiltBundle): void {
  rmSync(b.ancestorRoot, { recursive: true, force: true });
}

/** 期望 fn 抛 SupervisorError,code 恰为 expected。 */
function rejectsWith(expected: string, fn: () => unknown): void {
  assert.throws(fn, (err: unknown) => err instanceof SupervisorError && err.code === expected);
}
const rejectsBundle = (fn: () => unknown): void => rejectsWith("PlatformBundleInvalid", fn);
const rejectsRelease = (fn: () => unknown): void => rejectsWith("RuntimeReleaseInvalid", fn);
// R2-M5:assertCurrentMatches 的中间态现抛 RuntimeActivationInProgress(秒级激活窗口,非坏产物)。
const rejectsActivation = (fn: () => unknown): void => rejectsWith("RuntimeActivationInProgress", fn);

// ───────────────────────────────────────────────────────────────────────

describe("resolvePlatformBundleMount", { skip: !IS_ROOT ? "requires root (uid=0)" : false }, () => {
  test("通过:合规 bundle 返回 { resolvedPath, bundleRev=digest, bootHash }", () => {
    const b = buildValidBundle();
    try {
      const r = resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot });
      assert.equal(r.bundleRev, b.digest);
      assert.equal(r.bootHash, b.bootHash);
      assert.equal(r.resolvedPath, b.bundleDir);
    } finally {
      cleanup(b);
    }
  });

  test("通过:传 platformRoot(containment)—— bundle 落 <platformRoot>/bundles/ 下", () => {
    const b = buildValidBundle();
    try {
      const r = resolvePlatformBundleMount(b.bundleDir, {
        ancestorRoot: b.ancestorRoot,
        platformRoot: b.ancestorRoot,
      });
      assert.equal(r.bundleRev, b.digest);
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:非绝对路径 / 空", () => {
    rejectsBundle(() => resolvePlatformBundleMount("relative/x"));
    rejectsBundle(() => resolvePlatformBundleMount(""));
    rejectsBundle(() => resolvePlatformBundleMount("   "));
  });

  test("拒绝:symlink 条目(类型白名单)", () => {
    const b = buildValidBundle();
    try {
      symlinkSync("/etc/hostname", pathJoin(b.bundleDir, "bin", "evil-link"));
      rejectsBundle(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:未声明顶层条目(顶层白名单)", () => {
    const b = buildValidBundle();
    try {
      mkdir755(pathJoin(b.bundleDir, "evil"));
      writeFile644(pathJoin(b.bundleDir, "evil", "x.sh"), "x\n");
      rejectsBundle(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:扩展名不在白名单", () => {
    const b = buildValidBundle();
    try {
      writeFile644(pathJoin(b.bundleDir, "seed", "bad.exe"), "x\n");
      rejectsBundle(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:bin/ 下带扩展名(必须是 PATH 命令名,finalize 负责剥)", () => {
    const b = buildValidBundle();
    try {
      writeFile644(pathJoin(b.bundleDir, "bin", "oc-left.sh"), "#!/bin/sh\n");
      chmodSync(pathJoin(b.bundleDir, "bin", "oc-left.sh"), 0o755);
      rejectsBundle(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:bin/ 下缺 owner exec 位", () => {
    const b = buildValidBundle();
    try {
      chmodSync(pathJoin(b.bundleDir, "bin", "oc-tool"), 0o644);
      rejectsBundle(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:特殊 mode 位(suid)", () => {
    const b = buildValidBundle();
    try {
      chmodSync(pathJoin(b.bundleDir, "bin", "oc-tool"), 0o4755);
      rejectsBundle(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:敏感名 denylist(.env)", () => {
    const b = buildValidBundle();
    try {
      writeFile644(pathJoin(b.bundleDir, "bin", ".env"), "SECRET=1\n");
      rejectsBundle(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:单文件超 1MB", () => {
    const b = buildValidBundle();
    try {
      writeFile644(pathJoin(b.bundleDir, "prompts", "big.md"), "x".repeat(PLATFORM_BUNDLE_MAX_FILE_BYTES + 1));
      rejectsBundle(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:深度 > 6", () => {
    const b = buildValidBundle();
    try {
      // bin/ 已是 depth 2;再嵌 6 层触发 > MAX_DEPTH(6)。
      let d = pathJoin(b.bundleDir, "bin");
      for (let i = 0; i < 7; i++) {
        d = pathJoin(d, `l${i}`);
        mkdir755(d);
      }
      writeFile644(pathJoin(d, "deep.sh"), "x\n");
      rejectsBundle(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:条目数 > 512", () => {
    const b = buildValidBundle();
    try {
      for (let i = 0; i <= PLATFORM_BUNDLE_MAX_ENTRIES; i++) {
        writeFile644(pathJoin(b.bundleDir, "seed", `f${i}.md`), "x\n");
      }
      rejectsBundle(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:文件 group/other 可写", () => {
    const b = buildValidBundle();
    try {
      chmodSync(pathJoin(b.bundleDir, "bin", "oc-tool"), 0o775); // 0775:有 exec 位,拒因恰为 group 可写
      rejectsBundle(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:文件非 root owned", () => {
    const b = buildValidBundle();
    try {
      chownSync(pathJoin(b.bundleDir, "bin", "oc-tool"), 1, 1);
      rejectsBundle(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:MANIFEST sha256 与实际不符(内容被篡改)", () => {
    const b = buildValidBundle();
    try {
      // 篡改已声明文件内容(size 不变,sha256 变)→ 磁盘 sha256 != MANIFEST。
      writeFile644(pathJoin(b.bundleDir, "bin", "oc-tool"), "#!/bin/sh\necho HI\n");
      chmodSync(pathJoin(b.bundleDir, "bin", "oc-tool"), 0o755); // 保住 exec 位,拒因恰为 sha256
      rejectsBundle(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:MANIFEST.digest 与重算不符", () => {
    const b = buildValidBundle();
    try {
      const bad = { schemaVersion: 1, digest: "000000000000", bootHash: b.bootHash, files: [] };
      writeFile644(pathJoin(b.bundleDir, "MANIFEST.json"), JSON.stringify(bad));
      rejectsBundle(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:bundle 目录名 != digest", () => {
    const b = buildValidBundle();
    try {
      const wrongDir = pathJoin(b.ancestorRoot, "bundles", "not-the-digest");
      renameSync(b.bundleDir, wrongDir);
      rejectsBundle(() => resolvePlatformBundleMount(wrongDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:祖先目录 group/other 可写", () => {
    const b = buildValidBundle();
    try {
      chmodSync(b.ancestorRoot, 0o777);
      // stopAt=ancestorRoot(inclusive)→ 校验 ancestorRoot 本身 0777 即拒。
      rejectsBundle(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      chmodSync(b.ancestorRoot, 0o755);
      cleanup(b);
    }
  });

  test("M8 拒绝:缺必需叶子(删 prompts/codex-preamble.md)", () => {
    const b = buildValidBundle();
    try {
      // 删一个必需叶子后重算 MANIFEST 自洽(否则会先撞 sha256/条目数不符,分不清是不是 M8 拒的)。
      rmSync(pathJoin(b.bundleDir, "prompts", "codex-preamble.md"));
      const kept = Object.entries(bundleContents()).filter(([rel]) => rel !== "prompts/codex-preamble.md");
      const files: ManifestFileEntry[] = kept
        .map(([rel, body]) => {
          const st = statSync(pathJoin(b.bundleDir, rel));
          return {
            path: rel,
            sha256: createHash("sha256").update(Buffer.from(body)).digest("hex"),
            size: st.size,
            mode: (st.mode & 0o777).toString(8),
          };
        })
        .sort((x, y) => (x.path < y.path ? -1 : 1));
      const digest = manifestDigestOf(files);
      const bootHash = bootHashOf(files);
      const bundleDir2 = pathJoin(b.ancestorRoot, "bundles", digest);
      renameSync(b.bundleDir, bundleDir2);
      writeFile644(
        pathJoin(bundleDir2, "MANIFEST.json"),
        JSON.stringify({ schemaVersion: 1, digest, bootHash, files }),
      );
      // 结构/MANIFEST 全自洽,唯独缺必需叶子 → M8 拒。
      assert.throws(
        () => resolvePlatformBundleMount(bundleDir2, { ancestorRoot: b.ancestorRoot }),
        (err: unknown) =>
          err instanceof SupervisorError &&
          err.code === "PlatformBundleInvalid" &&
          /required leaf/i.test(err.message),
      );
    } finally {
      cleanup(b);
    }
  });

  test("M8:PLATFORM_BUNDLE_REQUIRED_LEAVES 与 buildValidBundle 内容对齐(清单自证)", () => {
    const contents = new Set(Object.keys(bundleContents()));
    for (const leaf of PLATFORM_BUNDLE_REQUIRED_LEAVES) {
      assert.ok(contents.has(leaf), `required leaf 未在合规 fixture 中: ${leaf}`);
    }
  });

  test("B5.2 拒绝:传 platformRoot 但 bundle 不在 <platformRoot>/bundles/ 下", () => {
    const b = buildValidBundle();
    try {
      // 把 bundle 从 bundles/<digest> 移到 platformRoot 顶层(仍是同一棵合规树,只是布局越界)。
      const misplaced = pathJoin(b.ancestorRoot, b.digest);
      renameSync(b.bundleDir, misplaced);
      rejectsBundle(() =>
        resolvePlatformBundleMount(misplaced, { ancestorRoot: b.ancestorRoot, platformRoot: b.ancestorRoot }),
      );
    } finally {
      cleanup(b);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────

describe("assertSafeAncestry(B5.1)", { skip: !IS_ROOT ? "requires root (uid=0)" : false }, () => {
  test("拒绝:给了 stopAt 但祖先链走到文件系统根都没命中(path 逃逸可信根)", () => {
    const a = mkdtempSync(pathJoin(tmpdir(), "oc-anc-a-"));
    const other = mkdtempSync(pathJoin(tmpdir(), "oc-anc-b-"));
    try {
      chmodSync(a, 0o755);
      chmodSync(other, 0o755);
      const sub = pathJoin(a, "x");
      mkdir755(sub);
      // stopAt=other,但 sub 在 a 下 → 一直走到 / 都没命中 other → 抛。
      assert.throws(() => assertSafeAncestry(sub, other));
      // stopAt=a(sub 的真祖先)→ 命中即止,不抛。
      assert.doesNotThrow(() => assertSafeAncestry(sub, a));
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────

describe("assertCurrentMatches", { skip: !IS_ROOT ? "requires root (uid=0)" : false }, () => {
  /** 在 platformRoot 建 current -> bundles/<digest>(相对链,与 bash flip_current 同形)。 */
  function linkCurrentRelative(platformRoot: string, digest: string): void {
    symlinkSync(`bundles/${digest}`, pathJoin(platformRoot, "current"));
  }

  test("通过:current 相对链 bundles/<digest> 指向声明 bundle", () => {
    const b = buildValidBundle();
    try {
      linkCurrentRelative(b.ancestorRoot, b.digest);
      assert.doesNotThrow(() => assertCurrentMatches(b.ancestorRoot, b.bundleDir));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:current 指向别的 bundle(激活中间态)", () => {
    const b = buildValidBundle();
    try {
      // current -> bundles/<b.digest>(相对,规范),但声明的是同根下另一个 12hex bundle → realpath 不等。
      linkCurrentRelative(b.ancestorRoot, b.digest);
      // 另建一个 12hex 名目录(空即可,assertCurrentMatches 只 realpath 它,不做内容校验)。
      const otherDir = pathJoin(b.ancestorRoot, "bundles", "0123456789ab");
      mkdir755(otherDir);
      rejectsActivation(() => assertCurrentMatches(b.ancestorRoot, otherDir));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:current 不存在", () => {
    const b = buildValidBundle();
    try {
      rejectsActivation(() => assertCurrentMatches(b.ancestorRoot, b.bundleDir));
    } finally {
      cleanup(b);
    }
  });

  test("B5.3 拒绝:current 原始目标是绝对路径(非规范相对 bundles/<12hex>)", () => {
    const b = buildValidBundle();
    try {
      // 绝对目标即使 realpath 相等也拒 —— 只认 bundles/<12hex> 相对形态。
      symlinkSync(b.bundleDir, pathJoin(b.ancestorRoot, "current"));
      rejectsActivation(() => assertCurrentMatches(b.ancestorRoot, b.bundleDir));
    } finally {
      cleanup(b);
    }
  });

  test("B5.3 拒绝:current 目标非 12hex 形态(bundles/<非规范>)", () => {
    const b = buildValidBundle();
    try {
      // 造一个非 12hex 名的目录并让 current 相对指过去。
      const weird = pathJoin(b.ancestorRoot, "bundles", "not12hex");
      renameSync(b.bundleDir, weird);
      symlinkSync("bundles/not12hex", pathJoin(b.ancestorRoot, "current"));
      rejectsActivation(() => assertCurrentMatches(b.ancestorRoot, weird));
    } finally {
      cleanup(b);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────

describe("resolveRuntimeReleaseMount", { skip: !IS_ROOT ? "requires root (uid=0)" : false }, () => {
  /** 建一个合规 release:releasesRoot/rel-<digest12>/MANIFEST.json{digest}。 */
  function buildRelease(digest = "abcdef012345"): { releasesRoot: string; releaseDir: string; digest: string } {
    const releasesRoot = mkdtempSync(pathJoin(tmpdir(), "oc-releases-"));
    chmodSync(releasesRoot, 0o755);
    const releaseDir = pathJoin(releasesRoot, `rel-${digest}`);
    mkdir755(releaseDir);
    writeFile644(pathJoin(releaseDir, "MANIFEST.json"), JSON.stringify({ digest }));
    return { releasesRoot, releaseDir, digest };
  }

  test("通过:合规 release 返回 resolved realpath", () => {
    const r = buildRelease();
    try {
      const got = resolveRuntimeReleaseMount(r.releaseDir, r.releasesRoot);
      assert.equal(got, r.releaseDir);
    } finally {
      rmSync(r.releasesRoot, { recursive: true, force: true });
    }
  });

  test("通过:release 内相对 symlink(不逃逸)—— node_modules .bin 场景", () => {
    const r = buildRelease();
    try {
      mkdir755(pathJoin(r.releaseDir, "lib"));
      writeFile644(pathJoin(r.releaseDir, "lib", "real.js"), "module.exports=1;\n");
      // link.js -> lib/real.js(相对,规范化后在树内)。
      symlinkSync("lib/real.js", pathJoin(r.releaseDir, "link.js"));
      // 嵌套的相对回退链 sub/bin -> ../lib/real.js(仍在树内)。
      mkdir755(pathJoin(r.releaseDir, "sub"));
      symlinkSync("../lib/real.js", pathJoin(r.releaseDir, "sub", "bin"));
      assert.doesNotThrow(() => resolveRuntimeReleaseMount(r.releaseDir, r.releasesRoot));
    } finally {
      rmSync(r.releasesRoot, { recursive: true, force: true });
    }
  });

  test("M6 拒绝:release 内绝对 symlink", () => {
    const r = buildRelease();
    try {
      symlinkSync("/etc/passwd", pathJoin(r.releaseDir, "abs-link"));
      rejectsRelease(() => resolveRuntimeReleaseMount(r.releaseDir, r.releasesRoot));
    } finally {
      rmSync(r.releasesRoot, { recursive: true, force: true });
    }
  });

  test("M6 拒绝:release 内相对 symlink 逃逸出树", () => {
    const r = buildRelease();
    try {
      mkdir755(pathJoin(r.releaseDir, "sub"));
      symlinkSync("../../../../etc/passwd", pathJoin(r.releaseDir, "sub", "escape"));
      rejectsRelease(() => resolveRuntimeReleaseMount(r.releaseDir, r.releasesRoot));
    } finally {
      rmSync(r.releasesRoot, { recursive: true, force: true });
    }
  });

  test("M6 拒绝:release 内嵌套文件非 root owned", () => {
    const r = buildRelease();
    try {
      mkdir755(pathJoin(r.releaseDir, "sub"));
      writeFile644(pathJoin(r.releaseDir, "sub", "f.js"), "x\n");
      chownSync(pathJoin(r.releaseDir, "sub", "f.js"), 1, 1);
      rejectsRelease(() => resolveRuntimeReleaseMount(r.releaseDir, r.releasesRoot));
    } finally {
      // chown 回 root 便于清理
      try { chownSync(pathJoin(r.releaseDir, "sub", "f.js"), 0, 0); } catch { /* ignore */ }
      rmSync(r.releasesRoot, { recursive: true, force: true });
    }
  });

  test("M6 拒绝:release 内嵌套文件 group/other 可写", () => {
    const r = buildRelease();
    try {
      mkdir755(pathJoin(r.releaseDir, "sub"));
      writeFile644(pathJoin(r.releaseDir, "sub", "f.js"), "x\n");
      chmodSync(pathJoin(r.releaseDir, "sub", "f.js"), 0o664); // group 可写
      rejectsRelease(() => resolveRuntimeReleaseMount(r.releaseDir, r.releasesRoot));
    } finally {
      rmSync(r.releasesRoot, { recursive: true, force: true });
    }
  });

  test("拒绝:目录名不是 rel-<digest12>", () => {
    const r = buildRelease();
    try {
      const wrong = pathJoin(r.releasesRoot, "not-a-release");
      renameSync(r.releaseDir, wrong);
      writeFile644(pathJoin(wrong, "MANIFEST.json"), JSON.stringify({ digest: r.digest }));
      rejectsRelease(() => resolveRuntimeReleaseMount(wrong, r.releasesRoot));
    } finally {
      rmSync(r.releasesRoot, { recursive: true, force: true });
    }
  });

  test("拒绝:目录名 digest 与 MANIFEST.digest 不符", () => {
    const r = buildRelease();
    try {
      writeFile644(pathJoin(r.releaseDir, "MANIFEST.json"), JSON.stringify({ digest: "ffffffffffff" }));
      rejectsRelease(() => resolveRuntimeReleaseMount(r.releaseDir, r.releasesRoot));
    } finally {
      rmSync(r.releasesRoot, { recursive: true, force: true });
    }
  });

  test("拒绝:realpath 逃逸 releases 根", () => {
    const r = buildRelease();
    const other = mkdtempSync(pathJoin(tmpdir(), "oc-other-"));
    try {
      chmodSync(other, 0o755);
      const outside = pathJoin(other, `rel-${r.digest}`);
      mkdir755(outside);
      writeFile644(pathJoin(outside, "MANIFEST.json"), JSON.stringify({ digest: r.digest }));
      // 传的 releasesRoot 是 r.releasesRoot,但 release 落在 other → 逃逸拒。
      rejectsRelease(() => resolveRuntimeReleaseMount(outside, r.releasesRoot));
    } finally {
      rmSync(r.releasesRoot, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("拒绝:release 目录非 root owned", () => {
    const r = buildRelease();
    try {
      chownSync(r.releaseDir, 1, 1);
      rejectsRelease(() => resolveRuntimeReleaseMount(r.releaseDir, r.releasesRoot));
    } finally {
      chownSync(r.releaseDir, 0, 0);
      rmSync(r.releasesRoot, { recursive: true, force: true });
    }
  });

  test("拒绝:release 目录 group/other 可写", () => {
    const r = buildRelease();
    try {
      chmodSync(r.releaseDir, 0o775);
      rejectsRelease(() => resolveRuntimeReleaseMount(r.releaseDir, r.releasesRoot));
    } finally {
      rmSync(r.releasesRoot, { recursive: true, force: true });
    }
  });

  test("拒绝:MANIFEST 缺失", () => {
    const r = buildRelease();
    try {
      rmSync(pathJoin(r.releaseDir, "MANIFEST.json"));
      rejectsRelease(() => resolveRuntimeReleaseMount(r.releaseDir, r.releasesRoot));
    } finally {
      rmSync(r.releasesRoot, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
//  digest / bootHash 算法自证(构建期与校验期唯一权威)
// ───────────────────────────────────────────────────────────────────────

describe("manifestDigestOf / bootHashOf", () => {
  const files: ManifestFileEntry[] = [
    { path: "bin/a", sha256: "aa", size: 1, mode: "755" },
    { path: "entrypoint/e.ts", sha256: "bb", size: 2, mode: "644" },
    { path: "seed/s.md", sha256: "cc", size: 3, mode: "644" },
    { path: "prompts/p.md", sha256: "dd", size: 4, mode: "644" },
  ];

  test("digest 稳定 12 hex,与顺序无关(内部按 path 排序)", () => {
    const d1 = manifestDigestOf(files);
    const d2 = manifestDigestOf([...files].reverse());
    assert.match(d1, /^[0-9a-f]{12}$/);
    assert.equal(d1, d2);
  });

  test("bootHash 只覆盖 entrypoint/ + seed/(改 bin/prompts 不动 bootHash)", () => {
    const bh1 = bootHashOf(files);
    const changedBin = files.map((f) => (f.path === "bin/a" ? { ...f, sha256: "zz" } : f));
    assert.equal(bootHashOf(changedBin), bh1, "改 bin 不影响 bootHash");
    const changedSeed = files.map((f) => (f.path === "seed/s.md" ? { ...f, sha256: "zz" } : f));
    assert.notEqual(bootHashOf(changedSeed), bh1, "改 seed 必变 bootHash");
  });

  test("M6(a) symlink 行按约定进 digest:sha256=`link:<target>`、mode=777、size=0(纯字符串拼接)", () => {
    // manifestDigestOf 只拼接字符串字段,symlink 行无需特判 —— 换 target 必变 digest。
    const withLink: ManifestFileEntry[] = [
      ...files,
      { path: "node_modules/.bin/x", sha256: "link:../pkg/bin/x.js", size: 0, mode: "777" },
    ];
    const d1 = manifestDigestOf(withLink);
    assert.match(d1, /^[0-9a-f]{12}$/);
    const retargeted = withLink.map((f) =>
      f.path === "node_modules/.bin/x" ? { ...f, sha256: "link:../pkg/bin/y.js" } : f,
    );
    assert.notEqual(manifestDigestOf(retargeted), d1, "symlink target 变 → digest 变");
  });
});
