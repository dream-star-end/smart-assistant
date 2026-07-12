/**
 * entrypointPlatform.test.ts — runtime hotcfg P0/P2a 的**行为断言**测试。
 *
 * 与 runtimeEntrypointPolicy.test.ts 的分工:
 *   - runtimeEntrypointPolicy:守 entrypoint.ts **源码**里保留的机制(env scrub / 计费常量 /
 *     merge 逻辑 / buildSeedAgent 装配)—— regex on source。
 *   - 本文件:守外置到 **bundle 文件/yaml** 的内容 + 抽出的**纯函数**(platformBundle.ts)行为:
 *     platform-seed schema 拒 model 键、seed 目录解析、scientist seed 文件↔清单一致 + 钉源 commit、
 *     persona 文件、codex-skill hash 覆写决策、buildSeedAgent 合并、entrypoint.sh 分流。
 *
 * platformBundle.ts 与 entrypoint.ts 同属容器运行时脚本、**不进 commercial tsc 编译图**。为不把
 * agent-sandbox/ 拉进编译图(会触发 rootDir 越界,历史 S12a MAJOR 2),这里用 **非字面量 dynamic
 * import**(tsc 视作 any、不解析;tsx 运行时按 .ts 解析)载入,与既有"读源码字符串"精神一致。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SANDBOX = join(__dirname, "..", "..", "agent-sandbox");
const PLATFORM_RUNTIME = join(SANDBOX, "platform-runtime");
const SEED_DIR = join(PLATFORM_RUNTIME, "seed");
const PLATFORM_SEED_YAML = join(SEED_DIR, "platform-seed.yaml");
const SCIENTIST_DIR = join(SEED_DIR, "skills", "scientist");
const PERSONAS_DIR = join(SEED_DIR, "personas");
const CODEX_SKILLS_DIR = join(PLATFORM_RUNTIME, "codex-skills");
const ENTRYPOINT_SH = join(SANDBOX, "runtime", "entrypoint.sh");
const ENTRYPOINT_TS = join(PLATFORM_RUNTIME, "entrypoint", "entrypoint.ts");

// 非字面量路径 → tsc 不解析,tsx 运行时按 .ts 载入(pb 类型为 any)。
const platformBundlePath = join(PLATFORM_RUNTIME, "entrypoint", "platformBundle.ts");
const pb = await import(platformBundlePath);

const KDENSE_COMMIT = "dab7aa672944a77f20cda3f2a672a6f1582adab6";

function readSeedDoc() {
  return pb.validatePlatformSeed(parseYaml(readFileSync(PLATFORM_SEED_YAML, "utf8")));
}

describe("platform-seed.yaml schema + validatePlatformSeed", () => {
  test("actual platform-seed.yaml validates and declares main/codex/hidden-reviewer + scientist skills", () => {
    const doc = readSeedDoc();
    assert.equal(doc.schemaVersion, 1);
    const ids = doc.agents.map((a: { id: string }) => a.id).sort();
    assert.deepEqual(ids, ["codex", "hidden-reviewer", "main"]);
    assert.deepEqual([...(doc.seedSkills.scientist as string[])].sort(), [
      "aeon", "matplotlib", "pymc", "pymoo", "scanpy", "scikit-learn",
      "scvi-tools", "statistical-analysis", "statsmodels", "sympy",
    ]);
  });

  test("agent declarations carry only non-billing fields (persona ref / permissionMode / display / toolsets)", () => {
    const doc = readSeedDoc();
    const byId = (id: string) => doc.agents.find((a: { id: string }) => a.id === id);
    const main = byId("main");
    assert.equal(main.persona, "personas/main.md");
    assert.equal(main.permissionMode, "bypassPermissions");
    assert.equal(main.displayName, "全能助手");
    assert.equal(main.toolsets, undefined, "main declares no toolsets (matches legacy inline shape)");
    const hr = byId("hidden-reviewer");
    assert.equal(hr.persona, "personas/hidden-reviewer.md");
    assert.equal(hr.forcePersona, true);
    assert.equal(hr.permissionMode, "bypassPermissions");
    assert.deepEqual(hr.toolsets, ["core"]);
    const codex = byId("codex");
    assert.equal(codex.persona, undefined, "codex has no persona (dynamic display, no persona)");
    assert.equal(codex.avatarEmoji, "🤖");
  });

  test("validatePlatformSeed FAILS LOUD on any billing/engine key (model/engine/provider/runnerKind)", () => {
    for (const banned of ["model", "engine", "provider", "runnerKind"]) {
      assert.throws(
        () => pb.validatePlatformSeed({ schemaVersion: 1, agents: [{ id: "x", [banned]: "sneaky" }] }),
        new RegExp(`forbidden key "${banned}"`),
        `声明含 ${banned} 必须抛(防绕道声明化计费字段 → 滚动窗口计费分叉)`,
      );
    }
  });

  test("validatePlatformSeed rejects wrong schemaVersion / non-object root / bad agent shape", () => {
    assert.throws(() => pb.validatePlatformSeed({ schemaVersion: 2, agents: [] }), /unsupported schemaVersion/);
    assert.throws(() => pb.validatePlatformSeed(null), /root must be a mapping/);
    assert.throws(() => pb.validatePlatformSeed({ schemaVersion: 1, agents: [{}] }), /non-empty string id/);
    assert.throws(
      () => pb.validatePlatformSeed({ schemaVersion: 1, agents: [{ id: "a", toolsets: "core" }] }),
      /toolsets must be a string array/,
    );
  });
});

describe("resolvePlatformSeedDir / resolvePlatformCodexSkillsDir (次序解析)", () => {
  const j = (...p: string[]) => p.join("/");
  test("seed dir prefers self bundle ../seed, else fallback share dir, else null", () => {
    const selfDir = "/bundle/entrypoint";
    // only self ../seed has platform-seed.yaml
    assert.equal(
      pb.resolvePlatformSeedDir(selfDir, (p: string) => p === "/bundle/entrypoint/../seed/platform-seed.yaml", j),
      "/bundle/entrypoint/../seed",
    );
    // only fallback has it
    assert.equal(
      pb.resolvePlatformSeedDir(selfDir, (p: string) => p === `${pb.PLATFORM_SEED_FALLBACK_DIR}/platform-seed.yaml`, j),
      pb.PLATFORM_SEED_FALLBACK_DIR,
    );
    // neither → null (dev fallback minimal seed)
    assert.equal(pb.resolvePlatformSeedDir(selfDir, () => false, j), null);
  });

  test("codex-skills dir resolution: self ../codex-skills, else fallback, else null", () => {
    const selfDir = "/bundle/entrypoint";
    assert.equal(
      pb.resolvePlatformCodexSkillsDir(selfDir, (p: string) => p === "/bundle/entrypoint/../codex-skills", j),
      "/bundle/entrypoint/../codex-skills",
    );
    assert.equal(
      pb.resolvePlatformCodexSkillsDir(selfDir, (p: string) => p === pb.PLATFORM_CODEX_SKILLS_FALLBACK_DIR, j),
      pb.PLATFORM_CODEX_SKILLS_FALLBACK_DIR,
    );
    assert.equal(pb.resolvePlatformCodexSkillsDir(selfDir, () => false, j), null);
  });
});

describe("shouldWriteCodexSkill (原生 skip-if-exists / 平台自有 hash-overwrite)", () => {
  test("skip-if-exists: write only when target missing", () => {
    assert.equal(pb.shouldWriteCodexSkill("skip-if-exists", false, null, "src"), true);
    assert.equal(pb.shouldWriteCodexSkill("skip-if-exists", true, "whatever", "src"), false);
  });
  test("hash-overwrite: write when missing OR content hash differs; skip when identical", () => {
    assert.equal(pb.shouldWriteCodexSkill("hash-overwrite", false, null, "src"), true);
    assert.equal(pb.shouldWriteCodexSkill("hash-overwrite", true, "same", "same"), false);
    assert.equal(pb.shouldWriteCodexSkill("hash-overwrite", true, "old", "new"), true);
    assert.equal(pb.shouldWriteCodexSkill("hash-overwrite", true, null, "new"), true);
  });
});

describe("buildSeedAgent (yaml 非计费声明 + billing 计费权威合并)", () => {
  test("merges decl non-billing fields, injects billing, copies toolsets by value, sets id/persona", () => {
    const out = pb.buildSeedAgent({
      id: "main",
      decl: { id: "main", permissionMode: "bypassPermissions", displayName: "全能助手", avatarEmoji: "🧠", toolsets: ["core"] },
      billing: { model: "glm-5.2", provider: "ark" },
      personaPath: "/vol/agents/main/CLAUDE.md",
    });
    assert.equal(out.id, "main");
    assert.equal(out.persona, "/vol/agents/main/CLAUDE.md");
    assert.equal(out.permissionMode, "bypassPermissions");
    assert.equal(out.displayName, "全能助手");
    assert.equal(out.model, "glm-5.2");
    assert.equal(out.provider, "ark");
    assert.deepEqual(out.toolsets, ["core"]);
  });
  test("billing wins over declaration (dynamic displayName) and undefined decl → id-only base", () => {
    const out = pb.buildSeedAgent({
      id: "codex",
      decl: { id: "codex", displayName: "SHOULD_LOSE", avatarEmoji: "🤖" },
      billing: { model: "gpt", provider: "codex-native", runnerKind: "app-server", displayName: "GPT 队长" },
    });
    assert.equal(out.displayName, "GPT 队长", "billing displayName overrides declaration");
    assert.equal(out.runnerKind, "app-server");
    assert.equal(out.persona, undefined, "no personaPath → no persona field");
    const bare = pb.buildSeedAgent({ id: "x", billing: { model: "m" } });
    assert.deepEqual(bare, { id: "x", model: "m" });
  });
});

describe("scientist seed files ↔ yaml manifest (内容外置 + 钉源 commit + 一致)", () => {
  test("on-disk scientist skill dirs exactly match the yaml seedSkills manifest", () => {
    const doc = readSeedDoc();
    const manifest = [...(doc.seedSkills.scientist as string[])].sort();
    const onDisk = readdirSync(SCIENTIST_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    assert.deepEqual(onDisk, manifest, "seed/skills/scientist 目录必须与 platform-seed.yaml 清单精确一致");
  });
  test("each scientist SKILL.md exists, pins the audited upstream commit, and names itself", () => {
    const doc = readSeedDoc();
    for (const name of doc.seedSkills.scientist as string[]) {
      const md = join(SCIENTIST_DIR, name, "SKILL.md");
      assert.ok(existsSync(md), `missing ${name}/SKILL.md`);
      const content = readFileSync(md, "utf8");
      assert.match(content, new RegExp(`source_commit: ${KDENSE_COMMIT}`), `${name} must pin the audited commit`);
      assert.match(content, new RegExp(`name: ${name}\\b`), `${name} frontmatter name must match dir`);
      assert.match(content, /## OpenClaude 商业版安全边界/, `${name} must keep the safety-boundary section`);
    }
  });
});

describe("persona files + codex-skills bundle", () => {
  test("main + hidden-reviewer persona files exist; hidden-reviewer carries both VERDICT lines", () => {
    const main = readFileSync(join(PERSONAS_DIR, "main.md"), "utf8");
    assert.ok(main.trim().length > 0, "main persona must be non-empty");
    const hr = readFileSync(join(PERSONAS_DIR, "hidden-reviewer.md"), "utf8");
    assert.match(hr, /VERDICT: PASS/);
    assert.match(hr, /VERDICT: NEEDS_FIX/);
  });
  test("bundle codex-skills ships document-writing/SKILL.md (hash-overwrite overlay source)", () => {
    assert.ok(existsSync(join(CODEX_SKILLS_DIR, "document-writing", "SKILL.md")));
  });
});

describe("entrypoint.sh 分流 + entrypoint.ts 关键不变量", () => {
  test("entrypoint.sh dispatches to bundle entrypoint, falls back to image copy, execs single entry", () => {
    const sh = readFileSync(ENTRYPOINT_SH, "utf8");
    assert.match(sh, /EP=\/run\/oc\/platform\/current\/entrypoint\/entrypoint\.ts/);
    assert.match(sh, /\[ -f "\$EP" \] \|\| EP=\/usr\/local\/lib\/openclaude\/entrypoint\.ts/);
    assert.match(sh, /exec npx --no tsx "\$EP"/);
  });

  test("the [ -f ] || fallback idiom picks bundle when present, image copy when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "ep-dispatch-"));
    try {
      const bundle = join(dir, "bundle-ep.ts");
      const fallback = join(dir, "image-ep.ts");
      writeFileSync(fallback, "// fallback");
      const pick = (b: string, f: string) =>
        execFileSync("bash", ["-c", `EP="$1"; [ -f "$EP" ] || EP="$2"; printf '%s' "$EP"`, "bash", b, f], {
          encoding: "utf8",
        });
      // bundle absent → fallback
      assert.equal(pick(bundle, fallback), fallback);
      // bundle present → bundle
      writeFileSync(bundle, "// bundle");
      assert.equal(pick(bundle, fallback), bundle);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("entrypoint.ts self-pins via realpath, fails loud outside the volume try, mkdirs workspace, hash-overwrites codex overlay", () => {
    const src = readFileSync(ENTRYPOINT_TS, "utf8");
    // 自钉:realpath(import.meta.url) 穿透 current symlink 得 rev-pinned bundle 路径。
    assert.match(src, /const SELF_ENTRY_DIR = dirname\(realpathSync\(fileURLToPath\(import\.meta\.url\)\)\)/);
    // fail loud:validatePlatformSeed 在 volume try 之外(module top),schema 违规立即崩。
    const volumeTryIdx = src.indexOf("try {\n  mkdirSync(ocConfigDir");
    const validateIdx = src.indexOf("platformSeed = validatePlatformSeed(");
    assert.ok(validateIdx > 0 && volumeTryIdx > 0 && validateIdx < volumeTryIdx,
      "validatePlatformSeed 必须在 volume try 之前(module top),否则 schema 违规被 volume-tolerant catch 吞掉");
    // 默认工作目录:OPENCLAUDE_DEFAULT_WORKSPACE 存在时 mkdir + 对齐 volume owner。
    assert.match(src, /const defaultWorkspace = \(process\.env\.OPENCLAUDE_DEFAULT_WORKSPACE \|\| ""\)\.trim\(\)/);
    assert.match(src, /mkdirSync\(defaultWorkspace, \{ recursive: true \}\)/);
    // codex overlay 走 hash-overwrite;原生 populate 保持 skip-if-exists。
    assert.match(src, /shouldWriteCodexSkill\("hash-overwrite"/);
    // dev fallback:platformSeed 缺失回落最小内置集(仅 main)+ dev-only 日志。
    assert.match(src, /if \(!platformSeed\) \{/);
    assert.match(src, /minimal main-only/);
  });
});
