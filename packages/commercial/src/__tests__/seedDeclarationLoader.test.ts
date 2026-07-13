/**
 * seedDeclarationLoader.test.ts —— master 按 bundleRev 读 seed 执行声明(模型权威 §5 阶段 B)。
 *
 * 覆盖(方案 §8「seed rev 复用 bundle 校验器三态」):
 *   - rev 有效 → 返回该 rev 声明的 agentId → 执行三元组;
 *   - rev 格式非法 / 缺失 → SeedRevInvalid(不触盘);
 *   - bundle 缺失 / 内容被篡改(digest 不符)→ SeedRevUnavailable(**复用** resolvePlatformBundleMount
 *     的全量校验:digest==目录名 / MANIFEST 逐文件 sha256,而非另造弱校验);
 *   - bundle 合法但 seed schema 不合(旧 v1 / 缺 model)→ SeedSchemaInvalid;
 *   - LRU 命中(rev 不可变 ⇒ 缓存恒新鲜):命中后即使磁盘被改也返回缓存值;
 *   - **失败不负缓存**:先失败后修好 → 下次成功(瞬态 IO 故障不钉死)。
 *
 * bundle 构造复用 platformBundle.test.ts 的合规树 + MANIFEST 自洽写法(root owned / 0644 / 0755)。
 * assertBaselineLeaf 要求 uid=0,故非 root 整组 skip(与既有 bundle 用例一致)。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootHashOf, manifestDigestOf, type ManifestFileEntry } from "../agent-sandbox/platformBundle.js";
import {
  SeedDeclarationError,
  __resetSeedDeclarationCacheForTests,
  loadSeedDeclaration,
  seedAgentModels,
} from "../ws/seedDeclarationLoader.js";

const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

const SEED_YAML_V2 = [
  "schemaVersion: 2",
  "agents:",
  "  - id: main",
  "    model: glm-5.2",
  "    provider: ark",
  "  - id: codex",
  "    model: gpt-5.6-sol",
  "    provider: codex-native",
  "    runnerKind: app-server",
  "",
].join("\n");

/** 旧 v1 声明(无执行三元组)—— master 必须 fail-loud,不能静默当成"没有 seed 模型"。 */
const SEED_YAML_V1 = "schemaVersion: 1\nagents:\n  - id: main\n";

function bundleContents(seedYaml: string): Record<string, string> {
  return {
    "bin/oc-web-context": "#!/bin/sh\nexec echo web-context\n",
    "entrypoint/entrypoint.ts": "export const boot = 1;\n",
    "entrypoint/platformBundle.ts": "export const bundle = 1;\n",
    "seed/platform-seed.yaml": seedYaml,
    "prompts/platform-capabilities.md": "# Platform capabilities\n",
    "prompts/memory-instructions.md": "# Memory\n",
    "prompts/codex-preamble.md": "# preamble\n",
    "etc-codex/managed_config.toml": "check_for_update_on_startup = false\n",
  };
}

interface BuiltBundle {
  platformRoot: string;
  bundleDir: string;
  rev: string;
}

/** 在 <platformRoot>/bundles/<digest> 建合规 bundle(目录名 = 内容 digest,MANIFEST 自洽)。 */
function buildBundle(seedYaml: string, platformRoot?: string): BuiltBundle {
  const root = platformRoot ?? mkdtempSync(join(tmpdir(), "oc-seeddecl-"));
  chmodSync(root, 0o755);
  const bundlesDir = join(root, "bundles");
  mkdirSync(bundlesDir, { recursive: true });
  chmodSync(bundlesDir, 0o755);
  const staging = join(bundlesDir, ".staging");
  rmSync(staging, { recursive: true, force: true });
  for (const d of ["bin", "entrypoint", "seed", "prompts", "etc-codex"]) {
    mkdirSync(join(staging, d), { recursive: true });
    chmodSync(join(staging, d), 0o755);
  }
  const contents = bundleContents(seedYaml);
  for (const [rel, body] of Object.entries(contents)) {
    const abs = join(staging, rel);
    writeFileSync(abs, body);
    chmodSync(abs, rel.startsWith("bin/") ? 0o755 : 0o644);
  }
  const files: ManifestFileEntry[] = Object.keys(contents)
    .sort()
    .map((rel) => {
      const abs = join(staging, rel);
      const st = statSync(abs);
      return {
        path: rel,
        sha256: createHash("sha256").update(Buffer.from(contents[rel]!)).digest("hex"),
        size: st.size,
        mode: (st.mode & 0o777).toString(8),
      };
    });
  const digest = manifestDigestOf(files);
  const bundleDir = join(bundlesDir, digest);
  rmSync(bundleDir, { recursive: true, force: true });
  renameSync(staging, bundleDir);
  const manifest = {
    schemaVersion: 1,
    digest,
    bootHash: bootHashOf(files),
    sourceCommit: "deadbeefcafe",
    files,
  };
  const manifestPath = join(bundleDir, "MANIFEST.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  chmodSync(manifestPath, 0o644);
  return { platformRoot: root, bundleDir, rev: digest };
}

async function rejectsWithCode(code: string, fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (err: unknown) => err instanceof SeedDeclarationError && err.code === code);
}

describe("seedDeclarationLoader", { skip: !IS_ROOT ? "requires root (uid=0)" : false }, () => {
  test("rev 有效:返回该 rev 声明的 agentId → 执行三元组", async () => {
    __resetSeedDeclarationCacheForTests();
    const b = buildBundle(SEED_YAML_V2);
    try {
      const decl = await loadSeedDeclaration(b.platformRoot, b.rev);
      assert.equal(decl.bundleRev, b.rev);
      assert.equal(decl.schemaVersion, 2);
      assert.deepEqual(decl.agents.get("main"), { model: "glm-5.2", provider: "ark" });
      assert.deepEqual(decl.agents.get("codex"), {
        model: "gpt-5.6-sol",
        provider: "codex-native",
        runnerKind: "app-server",
      });
      // seedAgentModels 是同一份(bridge/agentModelAuthority 的消费口)。
      const models = await seedAgentModels(b.rev, b.platformRoot);
      assert.equal(models.get("main")?.model, "glm-5.2");
      assert.equal(models.get("nope"), undefined);
    } finally {
      rmSync(b.platformRoot, { recursive: true, force: true });
    }
  });

  test("rev 格式非法 / 缺失 → SeedRevInvalid(fail-closed,不触盘)", async () => {
    __resetSeedDeclarationCacheForTests();
    for (const bad of [undefined, null, "", "ABCDEF012345", "abc", "../../etc", "0123456789abc"]) {
      await rejectsWithCode("SeedRevInvalid", () =>
        loadSeedDeclaration("/nonexistent-platform-root", bad as string | null | undefined),
      );
    }
  });

  test("bundle 缺失 → SeedRevUnavailable", async () => {
    __resetSeedDeclarationCacheForTests();
    const root = mkdtempSync(join(tmpdir(), "oc-seeddecl-empty-"));
    try {
      await rejectsWithCode("SeedRevUnavailable", () => loadSeedDeclaration(root, "0123456789ab"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bundle 内容被篡改(digest 不再等于目录名)→ SeedRevUnavailable(复用全量校验器)", async () => {
    __resetSeedDeclarationCacheForTests();
    const b = buildBundle(SEED_YAML_V2);
    try {
      // 攻击面:改 seed 声明里的模型 = 改计费。目录名(digest)不变 → 校验器必须拒。
      writeFileSync(
        join(b.bundleDir, "seed", "platform-seed.yaml"),
        SEED_YAML_V2.replace("glm-5.2", "gpt-5.6-sol"),
      );
      await rejectsWithCode("SeedRevUnavailable", () => loadSeedDeclaration(b.platformRoot, b.rev));
    } finally {
      rmSync(b.platformRoot, { recursive: true, force: true });
    }
  });

  test("bundle 合法但 seed schema 不合(旧 v1)→ SeedSchemaInvalid", async () => {
    __resetSeedDeclarationCacheForTests();
    const b = buildBundle(SEED_YAML_V1);
    try {
      await rejectsWithCode("SeedSchemaInvalid", () => loadSeedDeclaration(b.platformRoot, b.rev));
    } finally {
      rmSync(b.platformRoot, { recursive: true, force: true });
    }
  });

  test("LRU:rev 不可变 ⇒ 命中缓存不再重算(磁盘被改也返回首次结果)", async () => {
    __resetSeedDeclarationCacheForTests();
    const b = buildBundle(SEED_YAML_V2);
    try {
      const first = await loadSeedDeclaration(b.platformRoot, b.rev);
      assert.equal(first.agents.get("main")?.model, "glm-5.2");
      // 破坏磁盘内容(未 reset 缓存)→ 仍返回缓存值,证明命中路径不重跑校验。
      writeFileSync(join(b.bundleDir, "seed", "platform-seed.yaml"), "garbage: [");
      const second = await loadSeedDeclaration(b.platformRoot, b.rev);
      assert.equal(second.agents.get("main")?.model, "glm-5.2");
      // reset 后同一 rev 重新校验 → 现在磁盘坏了,必须拒(证明缓存确实是刚才那条命中的唯一原因)。
      __resetSeedDeclarationCacheForTests();
      await rejectsWithCode("SeedRevUnavailable", () => loadSeedDeclaration(b.platformRoot, b.rev));
    } finally {
      rmSync(b.platformRoot, { recursive: true, force: true });
    }
  });

  test("失败不负缓存:bundle 恢复后同一 rev 立刻可用", async () => {
    __resetSeedDeclarationCacheForTests();
    const b = buildBundle(SEED_YAML_V2);
    const hidden = join(b.platformRoot, "hidden-bundle");
    try {
      // 先制造"bundle 缺失"的瞬态故障。
      renameSync(b.bundleDir, hidden);
      await rejectsWithCode("SeedRevUnavailable", () => loadSeedDeclaration(b.platformRoot, b.rev));
      // 恢复(不清缓存)→ 必须成功:失败**没有**被负缓存钉死。
      renameSync(hidden, b.bundleDir);
      const decl = await loadSeedDeclaration(b.platformRoot, b.rev);
      assert.equal(decl.agents.get("codex")?.runnerKind, "app-server");
    } finally {
      rmSync(b.platformRoot, { recursive: true, force: true });
    }
  });
});
