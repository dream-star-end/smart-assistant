/**
 * 跨实现一致性门(bash ⇄ TS):bundle 的 MANIFEST/digest 由 scripts/v5-runtime-release-lib.sh
 * (bash,构建期权威)生成,由 packages/commercial/src/agent-sandbox/platformBundle.ts
 * (TS,校验期权威)重算校验。两侧对 digest 行编码(path\0sha256\0mode\n、mode=八进制串、
 * LC_ALL=C 排序、前 12 hex)与 bin/ 剥扩展名规则必须**逐字节一致** —— 本测试用真实 fixture
 * 树把 bash 产物直接喂给 TS 校验器,任何一侧改编码/改规则,先在这里红。
 *
 * 需要 root(owner=root 校验)+ bash/jq/sha256sum(与部署机同置备);非 root 环境 skip。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join as pathJoin, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolvePlatformBundleMount,
  assertCurrentMatches,
  manifestDigestOf,
} from "../agent-sandbox/platformBundle.js";

const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
// 仓库根(本文件在 packages/commercial/src/__tests__/;ESM 无 __dirname)。
const REPO_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const LIB = pathJoin(REPO_ROOT, "scripts/v5-runtime-release-lib.sh");

function write(p: string, body: string, mode = 0o644): void {
  writeFileSync(p, body);
  chmodSync(p, mode);
}

/** 组装一棵与真实 platform-runtime 同构的 fixture 源树(bin 里带 .sh/.py,等 finalize 剥)。 */
function buildFixtureStaging(stagingDir: string): void {
  for (const d of [
    "bin",
    "entrypoint",
    "etc-codex",
    "codex-skills/document-writing",
    "seed/personas",
    "seed/skills/scientist/demo",
    "prompts",
  ]) {
    mkdirSync(pathJoin(stagingDir, d), { recursive: true });
  }
  write(pathJoin(stagingDir, "bin/oc-demo.sh"), "#!/bin/sh\nexec echo demo\n");
  write(pathJoin(stagingDir, "bin/oc-py.py"), "#!/usr/bin/env python3\nprint('py')\n");
  write(pathJoin(stagingDir, "bin/mmx"), '#!/bin/sh\nexec "$(dirname "$0")/oc-demo" "$@"\n');
  // M2 必需叶子:bin/oc-web-context(finalize_bundle 剥 .py → bin/oc-web-context;与 F2 的 bash
  // selfcheck 清单 + TS PLATFORM_BUNDLE_REQUIRED_LEAVES 三侧会师)。
  write(pathJoin(stagingDir, "bin/oc-web-context.py"), "#!/usr/bin/env python3\nprint('web-context')\n");
  write(pathJoin(stagingDir, "entrypoint/entrypoint.ts"), "export const boot = true;\n");
  // M8 必需叶子:entrypoint/platformBundle.ts(与 PLATFORM_BUNDLE_REQUIRED_LEAVES 对齐)。
  write(pathJoin(stagingDir, "entrypoint/platformBundle.ts"), "export const bundle = true;\n");
  write(pathJoin(stagingDir, "etc-codex/managed_config.toml"), "check_for_update_on_startup = false\n");
  write(pathJoin(stagingDir, "codex-skills/document-writing/SKILL.md"), "# document-writing\n");
  write(pathJoin(stagingDir, "seed/platform-seed.yaml"), "schemaVersion: 1\nagents: []\n");
  write(pathJoin(stagingDir, "seed/personas/main.md"), "# main persona\n");
  write(pathJoin(stagingDir, "seed/skills/scientist/demo/SKILL.md"), "# demo seed skill\n");
  write(pathJoin(stagingDir, "prompts/platform-capabilities.md"), "# Platform capabilities\n");
  write(pathJoin(stagingDir, "prompts/memory-instructions.md"), "# Memory\n");
  write(pathJoin(stagingDir, "prompts/codex-preamble.md"), "# preamble\n");
}

describe(
  "runtime artifact conformance(bash 构建 ⇄ TS 校验)",
  { skip: !IS_ROOT ? "requires root (uid=0)" : false },
  () => {
    test("bash finalize_bundle 产物被 TS resolvePlatformBundleMount 原样接受", () => {
      const work = mkdtempSync(pathJoin(tmpdir(), "oc-conform-"));
      chmodSync(work, 0o755);
      try {
        const platformRoot = pathJoin(work, "platform");
        mkdirSync(pathJoin(platformRoot, "bundles"), { recursive: true });
        const staging = pathJoin(platformRoot, "bundles", ".staging-conform");
        mkdirSync(staging, { recursive: true });
        buildFixtureStaging(staging);

        // bash 侧:finalize(剥 bin 扩展名→规范权限→selfcheck→MANIFEST→digest 定名)+ 翻 current。
        const rev = execFileSync(
          "bash",
          [
            "-c",
            `set -euo pipefail
             export OC_HOTCFG_PLATFORM_ROOT=${JSON.stringify(platformRoot)}
             source ${JSON.stringify(LIB)}
             rev="$(oc_hotcfg_finalize_bundle ${JSON.stringify(staging)} 1 conformdeadbeef)"
             oc_hotcfg_flip_current "$rev"
             printf '%s' "$rev"`,
          ],
          { encoding: "utf8" },
        ).trim();
        assert.match(rev, /^[0-9a-f]{12}$/, "bash 侧 bundleRev 必须是 12 hex");

        const bundleDir = pathJoin(platformRoot, "bundles", rev);

        // TS 侧:全量结构校验 + digest/bootHash 重算必须与 bash MANIFEST 一致。
        // 传 platformRoot 一并会师 B5.2 containment(bash 产物落 <platformRoot>/bundles/<rev>)+ M8
        // 必需叶子(bash selfcheck 与 TS PLATFORM_BUNDLE_REQUIRED_LEAVES 同清单,任一侧漂移先在此红)。
        const resolved = resolvePlatformBundleMount(bundleDir, { ancestorRoot: work, platformRoot });
        assert.equal(resolved.bundleRev, rev, "TS 重算 digest 必须等于 bash 定名");

        const manifest = JSON.parse(readFileSync(pathJoin(bundleDir, "MANIFEST.json"), "utf8"));
        assert.equal(resolved.bootHash, manifest.bootHash, "TS bootHash 必须等于 bash MANIFEST.bootHash");

        // bin/ 剥名两侧规则会师:bash 产物无 .sh/.py,TS 校验接受且 mmx 原样保留。
        const paths = (manifest.files as Array<{ path: string; mode: string }>).map((f) => f.path);
        assert.ok(paths.includes("bin/oc-demo"), "oc-demo.sh 应被剥为 oc-demo");
        assert.ok(paths.includes("bin/oc-py"), "oc-py.py 应被剥为 oc-py");
        assert.ok(paths.includes("bin/mmx"), "mmx 无扩展名应原样保留");
        assert.ok(!paths.some((p) => p.startsWith("bin/") && /\.(sh|py)$/.test(p)));
        // mode 编码会师:jq 产字符串八进制。
        for (const f of manifest.files as Array<{ path: string; mode: string }>) {
          assert.equal(typeof f.mode, "string", `mode 必须是八进制字符串: ${f.path}`);
        }

        // current 断言(supervisor provision 每次跑的便宜检查)与 bash flip 会师。
        // bash flip_current 产 `ln -s "bundles/$rev"`,与 assertCurrentMatches 的 bundles/<12hex>
        // 相对链契约(B5.3)逐字节一致。
        assertCurrentMatches(platformRoot, bundleDir);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });

    // release MANIFEST symlink 行跨实现会师(M6a):bash file_rows 产 `link:<target>`/size=0/
    // mode=777 行进 digest;TS manifestDigestOf 对同一 files 表重算必须等于 bash 声明的
    // digest —— node_modules/.bin 全是 symlink,这条编码漂移 = release 完整性守卫失效。
    test("release symlink `link:` 行:bash MANIFEST digest == TS 重算", () => {
      const work = mkdtempSync(pathJoin(tmpdir(), "oc-conform-rel-"));
      chmodSync(work, 0o755);
      try {
        const tree = pathJoin(work, "tree");
        mkdirSync(pathJoin(tree, "node_modules", ".bin"), { recursive: true });
        write(pathJoin(tree, "package.json"), '{"name":"x"}\n');
        write(pathJoin(tree, "node_modules", "tool.js"), "#!/usr/bin/env node\n", 0o755);
        symlinkSync("../tool.js", pathJoin(tree, "node_modules", ".bin", "tool"));

        const manifestJson = execFileSync(
          "bash",
          [
            "-c",
            `set -euo pipefail
             source ${JSON.stringify(LIB)}
             oc_hotcfg_build_manifest ${JSON.stringify(tree)} 1 conformlinkbeef >/dev/null
             cat ${JSON.stringify(pathJoin(tree, "MANIFEST.json"))}`,
          ],
          { encoding: "utf8" },
        );
        const manifest = JSON.parse(manifestJson) as {
          digest: string;
          files: Array<{ path: string; sha256: string; size: number; mode: string }>;
        };
        const linkRow = manifest.files.find((f) => f.path === "node_modules/.bin/tool");
        assert.ok(linkRow, "bash MANIFEST 必须收录 symlink 行");
        assert.equal(linkRow.sha256, "link:../tool.js", "sha256 字段=字面 link:<target>");
        assert.equal(linkRow.size, 0);
        assert.equal(linkRow.mode, "777");
        assert.equal(
          manifestDigestOf(manifest.files as never),
          manifest.digest,
          "TS manifestDigestOf 重算必须等于 bash 声明 digest(含 link: 行)",
        );
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  },
);
