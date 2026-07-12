/**
 * V5 runtime tuple —— platformBundle.ts 校验矩阵单测。
 *
 * 覆盖:
 *   - resolvePlatformBundleMount:每条 §1.3 规则至少一个"拒绝"+一个"通过";digest/bootHash
 *     返回;MANIFEST 与实际 sha256/条目相符;结构上限(单文件/深度/条目/顶层白名单/扩展名/
 *     denylist/类型);祖先链;dir 名 == digest。
 *   - assertCurrentMatches:current==bundle 通过,不等抛(激活中间态)。
 *   - resolveRuntimeReleaseMount:realpath 在 releases 根下 / root-owned / 非可写 / MANIFEST
 *     digest ↔ 目录名一致。
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
  resolveRuntimeReleaseMount,
  manifestDigestOf,
  bootHashOf,
  PLATFORM_BUNDLE_MAX_FILE_BYTES,
  PLATFORM_BUNDLE_MAX_ENTRIES,
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
  ancestorRoot: string;
  bundleDir: string;
  digest: string;
  bootHash: string;
}

/**
 * 在 ancestorRoot 下建一个合规 bundle(bin/entrypoint/seed/prompts + MANIFEST.json),
 * 目录名 = 内容 digest。返回路径 + digest/bootHash。
 *
 * 关键:MANIFEST.files 用磁盘实际 sha256/mode 填,digest/bootHash 用 manifestDigestOf/bootHashOf
 * 算(与被测校验同一权威),保证自洽。
 */
function buildValidBundle(): BuiltBundle {
  const ancestorRoot = mkdtempSync(pathJoin(tmpdir(), "oc-bundle-"));
  chmodSync(ancestorRoot, 0o755); // ancestry 边界:root owned 0755
  // 先建到一个临时名,填完算 digest 再 rename。
  const staging = pathJoin(ancestorRoot, "staging");
  mkdir755(staging);
  mkdir755(pathJoin(staging, "bin"));
  mkdir755(pathJoin(staging, "entrypoint"));
  mkdir755(pathJoin(staging, "seed"));
  mkdir755(pathJoin(staging, "prompts"));

  const contents: Record<string, string> = {
    "bin/oc-tool": "#!/bin/sh\necho hi\n",
    "entrypoint/entrypoint.ts": "export const boot = 1;\n",
    "seed/persona.md": "# persona\n",
    "prompts/platform.md": "# platform capabilities\n",
  };
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

  // rename staging → <digest>
  const bundleDir = pathJoin(ancestorRoot, digest);
  renameSync(staging, bundleDir);

  // 写 MANIFEST.json(不进 files 表)。
  const manifest = { schemaVersion: 1, digest, bootHash, sourceCommit: "deadbeef", files };
  writeFile644(pathJoin(bundleDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2));

  return { ancestorRoot, bundleDir, digest, bootHash };
}

function cleanup(b: BuiltBundle): void {
  rmSync(b.ancestorRoot, { recursive: true, force: true });
}

function rejects(fn: () => unknown): void {
  assert.throws(fn, (err: unknown) => err instanceof SupervisorError && err.code === "InvalidArgument");
}

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

  test("拒绝:非绝对路径 / 空", () => {
    rejects(() => resolvePlatformBundleMount("relative/x"));
    rejects(() => resolvePlatformBundleMount(""));
    rejects(() => resolvePlatformBundleMount("   "));
  });

  test("拒绝:symlink 条目(类型白名单)", () => {
    const b = buildValidBundle();
    try {
      symlinkSync("/etc/hostname", pathJoin(b.bundleDir, "bin", "evil-link"));
      rejects(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:未声明顶层条目(顶层白名单)", () => {
    const b = buildValidBundle();
    try {
      mkdir755(pathJoin(b.bundleDir, "evil"));
      writeFile644(pathJoin(b.bundleDir, "evil", "x.sh"), "x\n");
      rejects(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:扩展名不在白名单", () => {
    const b = buildValidBundle();
    try {
      writeFile644(pathJoin(b.bundleDir, "seed", "bad.exe"), "x\n");
      rejects(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:bin/ 下带扩展名(必须是 PATH 命令名,finalize 负责剥)", () => {
    const b = buildValidBundle();
    try {
      writeFile644(pathJoin(b.bundleDir, "bin", "oc-left.sh"), "#!/bin/sh\n");
      chmodSync(pathJoin(b.bundleDir, "bin", "oc-left.sh"), 0o755);
      rejects(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:bin/ 下缺 owner exec 位", () => {
    const b = buildValidBundle();
    try {
      chmodSync(pathJoin(b.bundleDir, "bin", "oc-tool"), 0o644);
      rejects(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:特殊 mode 位(suid)", () => {
    const b = buildValidBundle();
    try {
      chmodSync(pathJoin(b.bundleDir, "bin", "oc-tool"), 0o4755);
      rejects(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:敏感名 denylist(.env)", () => {
    const b = buildValidBundle();
    try {
      writeFile644(pathJoin(b.bundleDir, "bin", ".env"), "SECRET=1\n");
      rejects(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:单文件超 1MB", () => {
    const b = buildValidBundle();
    try {
      writeFile644(pathJoin(b.bundleDir, "prompts", "big.md"), "x".repeat(PLATFORM_BUNDLE_MAX_FILE_BYTES + 1));
      rejects(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
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
      rejects(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
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
      rejects(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:文件 group/other 可写", () => {
    const b = buildValidBundle();
    try {
      chmodSync(pathJoin(b.bundleDir, "bin", "oc-tool"), 0o775); // 0775:有 exec 位,拒因恰为 group 可写
      rejects(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:文件非 root owned", () => {
    const b = buildValidBundle();
    try {
      chownSync(pathJoin(b.bundleDir, "bin", "oc-tool"), 1, 1);
      rejects(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
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
      rejects(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:MANIFEST.digest 与重算不符", () => {
    const b = buildValidBundle();
    try {
      const bad = { schemaVersion: 1, digest: "000000000000", bootHash: b.bootHash, files: [] };
      writeFile644(pathJoin(b.bundleDir, "MANIFEST.json"), JSON.stringify(bad));
      rejects(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:bundle 目录名 != digest", () => {
    const b = buildValidBundle();
    try {
      const wrongDir = pathJoin(b.ancestorRoot, "not-the-digest");
      renameSync(b.bundleDir, wrongDir);
      rejects(() => resolvePlatformBundleMount(wrongDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      cleanup(b);
    }
  });

  test("拒绝:祖先目录 group/other 可写", () => {
    const b = buildValidBundle();
    try {
      chmodSync(b.ancestorRoot, 0o777);
      // stopAt=ancestorRoot(inclusive)→ 校验 ancestorRoot 本身 0777 即拒。
      rejects(() => resolvePlatformBundleMount(b.bundleDir, { ancestorRoot: b.ancestorRoot }));
    } finally {
      chmodSync(b.ancestorRoot, 0o755);
      cleanup(b);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────

describe("assertCurrentMatches", { skip: !IS_ROOT ? "requires root (uid=0)" : false }, () => {
  test("通过:current symlink 指向声明 bundle", () => {
    const b = buildValidBundle();
    const platformRoot = mkdtempSync(pathJoin(tmpdir(), "oc-platform-"));
    try {
      chmodSync(platformRoot, 0o755);
      symlinkSync(b.bundleDir, pathJoin(platformRoot, "current"));
      assert.doesNotThrow(() => assertCurrentMatches(platformRoot, b.bundleDir));
    } finally {
      rmSync(platformRoot, { recursive: true, force: true });
      cleanup(b);
    }
  });

  test("拒绝:current 指向别的 bundle(激活中间态)", () => {
    const b1 = buildValidBundle();
    const b2 = buildValidBundle();
    const platformRoot = mkdtempSync(pathJoin(tmpdir(), "oc-platform-"));
    try {
      chmodSync(platformRoot, 0o755);
      symlinkSync(b1.bundleDir, pathJoin(platformRoot, "current"));
      rejects(() => assertCurrentMatches(platformRoot, b2.bundleDir));
    } finally {
      rmSync(platformRoot, { recursive: true, force: true });
      cleanup(b1);
      cleanup(b2);
    }
  });

  test("拒绝:current 不存在", () => {
    const b = buildValidBundle();
    const platformRoot = mkdtempSync(pathJoin(tmpdir(), "oc-platform-"));
    try {
      chmodSync(platformRoot, 0o755);
      rejects(() => assertCurrentMatches(platformRoot, b.bundleDir));
    } finally {
      rmSync(platformRoot, { recursive: true, force: true });
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

  test("拒绝:目录名不是 rel-<digest12>", () => {
    const r = buildRelease();
    try {
      const wrong = pathJoin(r.releasesRoot, "not-a-release");
      renameSync(r.releaseDir, wrong);
      writeFile644(pathJoin(wrong, "MANIFEST.json"), JSON.stringify({ digest: r.digest }));
      rejects(() => resolveRuntimeReleaseMount(wrong, r.releasesRoot));
    } finally {
      rmSync(r.releasesRoot, { recursive: true, force: true });
    }
  });

  test("拒绝:目录名 digest 与 MANIFEST.digest 不符", () => {
    const r = buildRelease();
    try {
      writeFile644(pathJoin(r.releaseDir, "MANIFEST.json"), JSON.stringify({ digest: "ffffffffffff" }));
      rejects(() => resolveRuntimeReleaseMount(r.releaseDir, r.releasesRoot));
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
      rejects(() => resolveRuntimeReleaseMount(outside, r.releasesRoot));
    } finally {
      rmSync(r.releasesRoot, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("拒绝:release 目录非 root owned", () => {
    const r = buildRelease();
    try {
      chownSync(r.releaseDir, 1, 1);
      rejects(() => resolveRuntimeReleaseMount(r.releaseDir, r.releasesRoot));
    } finally {
      chownSync(r.releaseDir, 0, 0);
      rmSync(r.releasesRoot, { recursive: true, force: true });
    }
  });

  test("拒绝:release 目录 group/other 可写", () => {
    const r = buildRelease();
    try {
      chmodSync(r.releaseDir, 0o775);
      rejects(() => resolveRuntimeReleaseMount(r.releaseDir, r.releasesRoot));
    } finally {
      rmSync(r.releasesRoot, { recursive: true, force: true });
    }
  });

  test("拒绝:MANIFEST 缺失", () => {
    const r = buildRelease();
    try {
      rmSync(pathJoin(r.releaseDir, "MANIFEST.json"));
      rejects(() => resolveRuntimeReleaseMount(r.releaseDir, r.releasesRoot));
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
});
