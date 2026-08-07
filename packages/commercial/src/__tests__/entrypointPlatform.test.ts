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
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

/** 最小合法 v2 agent 声明(执行三元组必填)+ 覆写。 */
const A = (extra: Record<string, unknown> = {}) => ({
  id: "a",
  model: "glm-5.2",
  provider: "ark",
  ...extra,
});
/** 最小合法 v2 文档。 */
const DOC = (agents: unknown[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  agents,
  ...extra,
});

describe("platform-seed.yaml schema v2 + validatePlatformSeed", () => {
  test("actual platform-seed.yaml validates (schema v2) and declares main/codex/hidden-reviewer + scientist skills", () => {
    const doc = readSeedDoc();
    assert.equal(doc.schemaVersion, 2);
    const ids = doc.agents.map((a: { id: string }) => a.id).sort();
    assert.deepEqual(ids, ["codex", "hidden-reviewer", "main"]);
    assert.deepEqual([...(doc.seedSkills.scientist as string[])].sort(), [
      "aeon", "matplotlib", "pymc", "pymoo", "scanpy", "scikit-learn",
      "scvi-tools", "statistical-analysis", "statsmodels", "sympy",
    ]);
  });

  test("agent declarations carry the execution triple (model/provider/runnerKind) + non-billing fields", () => {
    const doc = readSeedDoc();
    const byId = (id: string) => doc.agents.find((a: { id: string }) => a.id === id);
    const main = byId("main");
    // 执行三元组(声明 = 容器侧唯一权威;值的一致性锚在 runtimeEntrypointPolicy.test.ts)。
    assert.equal(main.model, "glm-5.2");
    assert.equal(main.provider, "ark");
    assert.equal(main.runnerKind, undefined, "main 走默认 runner");
    assert.equal(main.persona, "personas/main.md");
    assert.equal(main.permissionMode, "bypassPermissions");
    assert.equal(main.displayName, "全能助手");
    assert.equal(main.toolsets, undefined, "main declares no toolsets (matches legacy inline shape)");
    const hr = byId("hidden-reviewer");
    assert.equal(hr.model, "glm-5.2");
    assert.equal(hr.provider, "ark");
    assert.equal(hr.persona, "personas/hidden-reviewer.md");
    assert.equal(hr.forcePersona, true, "裁决词汇必须每 boot 强制刷新");
    assert.equal(hr.permissionMode, "bypassPermissions");
    assert.deepEqual(hr.toolsets, ["core"]);
    const codex = byId("codex");
    assert.equal(codex.provider, "codex-native", "codex 引擎 pin");
    assert.equal(codex.runnerKind, "app-server", "gateway runner 路由依据必须落声明");
    assert.equal(codex.persona, undefined, "codex has no persona (dynamic display, no persona)");
    assert.equal(codex.avatarEmoji, "🤖");
    assert.equal(codex.displayName, undefined, "codex 显示名由 entrypoint 按声明的 model 反查 protocol 型号表");
  });

  test("validatePlatformSeed 仍硬拒 engine 键(engine 由 model 推导,禁第二权威源)", () => {
    assert.equal(pb.REJECTED_SEED_AGENT_KEYS.length, 1);
    assert.equal(pb.REJECTED_SEED_AGENT_KEYS[0], "engine");
    assert.throws(
      () => pb.validatePlatformSeed(DOC([A({ engine: "codex" })])),
      /forbidden key "engine"/,
      "engine 声明化 = 与 model 推导出的 engine 两个权威源,漂移无法裁决",
    );
  });

  test("schema v2 值校验矩阵:缺 model 拒 / 未知 provider 拒 / 非法 runnerKind 拒", () => {
    // 缺 model(或空串)
    assert.throws(
      () => pb.validatePlatformSeed(DOC([{ id: "a", provider: "ark" }])),
      /must declare a non-empty string model/,
    );
    assert.throws(
      () => pb.validatePlatformSeed(DOC([{ id: "a", model: "  ", provider: "ark" }])),
      /must declare a non-empty string model/,
    );
    // 缺 provider / provider 不在已知集
    assert.throws(
      () => pb.validatePlatformSeed(DOC([{ id: "a", model: "glm-5.2" }])),
      /provider .* not in known set/,
    );
    assert.throws(
      () => pb.validatePlatformSeed(DOC([A({ provider: "openai" })])),
      /provider "openai" not in known set/,
    );
    // runnerKind 只允许 app-server
    assert.throws(
      () => pb.validatePlatformSeed(DOC([A({ runnerKind: "subprocess" })])),
      /runnerKind "subprocess" not supported/,
    );
    // 合法:三元组齐全
    const ok = pb.validatePlatformSeed(
      DOC([{ id: "codex", model: "gpt-5.6-sol", provider: "codex-native", runnerKind: "app-server" }]),
    );
    assert.deepEqual(
      { ...ok.agents[0] },
      { id: "codex", model: "gpt-5.6-sol", provider: "codex-native", runnerKind: "app-server" },
    );
  });

  test("未知 schemaVersion fail-loud(含旧 v1 —— v1 文档没有执行三元组,静默接受会 seed 出无模型 agent)", () => {
    assert.equal(pb.PLATFORM_SEED_SCHEMA_VERSION, 2);
    for (const bad of [1, 3, "2", undefined]) {
      assert.throws(
        () => pb.validatePlatformSeed({ schemaVersion: bad, agents: [] }),
        /unsupported schemaVersion/,
        `schemaVersion=${String(bad)} 必须拒`,
      );
    }
  });

  test("validatePlatformSeed rejects non-object root / bad agent shape", () => {
    assert.throws(() => pb.validatePlatformSeed(null), /root must be a mapping/);
    assert.throws(() => pb.validatePlatformSeed(DOC([{}])), /non-empty string id/);
    assert.throws(
      () => pb.validatePlatformSeed(DOC([A({ toolsets: "core" })])),
      /toolsets must be a string array/,
    );
  });

  test("DEV_FALLBACK_SEED_DOC 自身是一份合法 v2 声明(dev 路径与生产走同一装配)", () => {
    const doc = pb.validatePlatformSeed(JSON.parse(JSON.stringify(pb.DEV_FALLBACK_SEED_DOC)));
    assert.equal(doc.schemaVersion, 2);
    assert.deepEqual(doc.agents.map((a: { id: string }) => a.id), ["main"]);
    assert.equal(doc.agents[0].model, "glm-5.2");
    assert.equal(doc.agents[0].provider, "ark");
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

describe("shouldWriteSeededSkill (原生 skip-if-exists / 平台自有 hash-overwrite;codex overlay + seed skill 共用)", () => {
  test("skip-if-exists: write only when target missing", () => {
    assert.equal(pb.shouldWriteSeededSkill("skip-if-exists", false, null, "src"), true);
    assert.equal(pb.shouldWriteSeededSkill("skip-if-exists", true, "whatever", "src"), false);
  });
  test("hash-overwrite: write when missing OR content hash differs; skip when identical", () => {
    assert.equal(pb.shouldWriteSeededSkill("hash-overwrite", false, null, "src"), true);
    assert.equal(pb.shouldWriteSeededSkill("hash-overwrite", true, "same", "same"), false);
    assert.equal(pb.shouldWriteSeededSkill("hash-overwrite", true, "old", "new"), true);
    assert.equal(pb.shouldWriteSeededSkill("hash-overwrite", true, null, "new"), true);
  });
});

describe("validatePlatformSeed confinement 强化(M5:slug / persona-ref / 未知字段 / 重复 id)", () => {
  const V = (doc: unknown) => () => pb.validatePlatformSeed(doc);
  test("agent id 必须严格 slug(拒大写/点/斜杠/空白/过长)", () => {
    for (const bad of ["BadCase", "a.b", "a/b", "a b", "-lead", "a".repeat(65)]) {
      assert.throws(V(DOC([A({ id: bad })])), /must match slug/, `id "${bad}" 必须拒`);
    }
    // 合法 slug 通过
    assert.equal(pb.validatePlatformSeed(DOC([A({ id: "a-1b" })])).agents[0].id, "a-1b");
  });
  test("persona 引用只允许 personas/<slug>.md(拒 ../ / 绝对路径 / 子目录)", () => {
    for (const bad of ["../x.md", "/etc/x.md", "personas/sub/x.md", "personas/x.txt", "x.md", "personas/BAD.md"]) {
      assert.throws(V(DOC([A({ persona: bad })])), /must be personas\/<slug>\.md/, `persona "${bad}" 必须拒`);
    }
    assert.equal(
      pb.validatePlatformSeed(DOC([A({ persona: "personas/main.md" })])).agents[0].persona,
      "personas/main.md",
    );
  });
  test("未知顶层字段 / 未知 agent 字段 fail-loud", () => {
    assert.throws(V(DOC([], { extra: 1 })), /unknown top-level field "extra"/);
    assert.throws(V(DOC([A({ bogus: 1 })])), /unknown field "bogus"/);
  });
  test("重复 agent id 拒", () => {
    assert.throws(V(DOC([A(), A()])), /duplicate agent id "a"/);
  });
  test("banned engine 键走专属报错(先于 slug/unknown 检查)", () => {
    assert.throws(V(DOC([A({ id: "BAD", engine: "ccb" })])), /forbidden key "engine"/);
  });
  test("seedSkills key/skill 名必须 slug", () => {
    assert.throws(V(DOC([A()], { seedSkills: { BadAgent: ["x"] } })), /seedSkills agent id "BadAgent" must match slug/);
    assert.throws(V(DOC([A()], { seedSkills: { sci: ["Bad_Name"] } })), /skill name "Bad_Name" must match slug/);
  });
});

describe("isPathWithin (M5 二道防线:归一化后越界拒)", () => {
  test("同路径 / 子树内 = true;.. 逃逸 / 兄弟前缀 = false", () => {
    assert.equal(pb.isPathWithin("/a/b", "/a/b"), true);
    assert.equal(pb.isPathWithin("/a/b", "/a/b/c/d"), true);
    assert.equal(pb.isPathWithin("/a/b", "/a/b/../c"), false); // 逃逸
    assert.equal(pb.isPathWithin("/a/b", "/a/bc"), false); // 兄弟前缀,非子树
    assert.equal(pb.isPathWithin("/a/b", "/a"), false); // 父目录
  });
});

describe("decidePersonaWrite (M4b:persona 三态升级矩阵)", () => {
  const P = "p".repeat(64); // platform hash（新版）
  const R = "r".repeat(64); // recorded hash（上次平台版）
  const U = "u".repeat(64); // user-edited hash
  test("force → 无条件覆写(hidden-reviewer 裁决词稳定同步)", () => {
    assert.equal(pb.decidePersonaWrite({ force: true, targetExists: true, currentHash: U, recordedHash: R, platformHash: P }), "force");
  });
  test("目标不存在 → write-new", () => {
    assert.equal(pb.decidePersonaWrite({ force: false, targetExists: false, currentHash: null, recordedHash: null, platformHash: P }), "write-new");
  });
  test("已是最新平台版 → already-latest(不改内容,仅回填记录)", () => {
    assert.equal(pb.decidePersonaWrite({ force: false, targetExists: true, currentHash: P, recordedHash: R, platformHash: P }), "already-latest");
  });
  test("用户没改过(当前==记录) → upgrade", () => {
    assert.equal(pb.decidePersonaWrite({ force: false, targetExists: true, currentHash: R, recordedHash: R, platformHash: P }), "upgrade");
  });
  test("记录缺失(存量 volume) → skip-no-record(保守视为定制)", () => {
    assert.equal(pb.decidePersonaWrite({ force: false, targetExists: true, currentHash: U, recordedHash: null, platformHash: P }), "skip-no-record");
  });
  test("用户定制(当前既非新版也非上次平台版) → skip-customized", () => {
    assert.equal(pb.decidePersonaWrite({ force: false, targetExists: true, currentHash: U, recordedHash: R, platformHash: P }), "skip-customized");
  });
});

describe("buildSeedAgent (schema v2:执行三元组恒取自声明,dynamic 只许展示字段)", () => {
  test("装配 = 声明的执行三元组 + 非计费字段 + persona 卷路径(toolsets 按值拷贝)", () => {
    const out = pb.buildSeedAgent({
      id: "main",
      decl: {
        id: "main",
        model: "glm-5.2",
        provider: "ark",
        permissionMode: "bypassPermissions",
        displayName: "全能助手",
        avatarEmoji: "🧠",
        toolsets: ["core"],
      },
      personaPath: "/vol/agents/main/CLAUDE.md",
    });
    assert.equal(out.id, "main");
    assert.equal(out.persona, "/vol/agents/main/CLAUDE.md");
    assert.equal(out.permissionMode, "bypassPermissions");
    assert.equal(out.displayName, "全能助手");
    assert.equal(out.model, "glm-5.2", "model 来自声明(entrypoint 已无本地常量)");
    assert.equal(out.provider, "ark");
    assert.equal(out.runnerKind, undefined, "声明没 runnerKind → 产物不带该字段");
    assert.deepEqual(out.toolsets, ["core"]);
  });

  test("codex:runnerKind 落产物;dynamic displayName(protocol 型号表)覆盖声明的 displayName", () => {
    const out = pb.buildSeedAgent({
      id: "codex",
      decl: {
        id: "codex",
        model: "gpt-5.6-sol",
        provider: "codex-native",
        runnerKind: "app-server",
        displayName: "SHOULD_LOSE",
        avatarEmoji: "🤖",
      },
      dynamic: { displayName: "GPT-5.6-Sol 队长" },
    });
    assert.equal(out.model, "gpt-5.6-sol");
    assert.equal(out.provider, "codex-native");
    assert.equal(out.runnerKind, "app-server");
    assert.equal(out.displayName, "GPT-5.6-Sol 队长", "dynamic 展示字段覆盖声明");
    assert.equal(out.persona, undefined, "no personaPath → no persona field");
  });

  test("回潮防线:dynamic 面禁止携带任何执行键(model/provider/runnerKind/engine)", () => {
    for (const forbidden of ["model", "provider", "runnerKind", "engine"]) {
      assert.throws(
        () =>
          pb.buildSeedAgent({
            id: "main",
            decl: { id: "main", model: "glm-5.2", provider: "ark" },
            dynamic: { [forbidden]: "sneaky" },
          }),
        new RegExp(`must not carry execution key "${forbidden}"`),
        `dynamic.${forbidden} 必须抛(否则又造出第二个执行权威源)`,
      );
    }
  });

  test("decl.id 与 args.id 不符 → 抛(装配错位保护)", () => {
    assert.throws(
      () => pb.buildSeedAgent({ id: "main", decl: { id: "codex", model: "m", provider: "ark" } }),
      /decl id "codex" != requested id "main"/,
    );
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
  test("entrypoint.sh 三级分流:rev-pinned(REV) → current → image copy;REV 严格 12hex 校验", () => {
    const sh = readFileSync(ENTRYPOINT_SH, "utf8");
    // ① rev-pinned:读 env OC_PLATFORM_BUNDLE_REV,拼 bundles/<REV>/entrypoint/entrypoint.ts
    assert.match(sh, /REV="\$\{OC_PLATFORM_BUNDLE_REV:-\}"/);
    assert.match(sh, /\[\[ "\$REV" =~ \^\[0-9a-f\]\{12\}\$ \]\]/, "REV 必须严格 [0-9a-f]{12} 校验防路径注入");
    assert.match(sh, /EP="\/run\/oc\/platform\/bundles\/\$REV\/entrypoint\/entrypoint\.ts"/);
    // ② current(原子翻转)兜底
    assert.match(sh, /EP=\/run\/oc\/platform\/current\/entrypoint\/entrypoint\.ts/);
    // ③ 镜像 COPY 副本兜底
    assert.match(sh, /\[ -f "\$EP" \] \|\| EP=\/usr\/local\/lib\/openclaude\/entrypoint\.ts/);
    assert.match(sh, /exec npx --no tsx "\$EP"/);
  });

  test("三级分流行为(bash 复现):REV 合法+存在→rev;REV 非法/缺失→current;current 缺→image", () => {
    const dir = mkdtempSync(join(tmpdir(), "ep-dispatch-"));
    try {
      // 模拟容器内三个候选路径(相对 dir,脚本片段用绝对路径拼)
      const revDir = join(dir, "bundles", "abc123def456", "entrypoint");
      const revEp = join(revDir, "entrypoint.ts");
      const currentEp = join(dir, "current", "entrypoint", "entrypoint.ts");
      const imageEp = join(dir, "image", "entrypoint.ts");
      for (const p of [revDir, join(dir, "current", "entrypoint"), join(dir, "image")]) {
        mkdirSync(p, { recursive: true });
      }
      writeFileSync(imageEp, "// image"); // image 兜底始终在

      // 复刻 entrypoint.sh 的三级分流逻辑(路径参数化以便隔离测试)
      const pick = (rev: string) =>
        execFileSync(
          "bash",
          [
            "-c",
            `REV="$1"; ROOT="$2"; IMG="$3"; EP="";
             if [[ "$REV" =~ ^[0-9a-f]{12}$ ]] && [ -f "$ROOT/bundles/$REV/entrypoint/entrypoint.ts" ]; then EP="$ROOT/bundles/$REV/entrypoint/entrypoint.ts"; fi
             [ -n "$EP" ] || EP="$ROOT/current/entrypoint/entrypoint.ts"
             [ -f "$EP" ] || EP="$IMG"
             printf '%s' "$EP"`,
            "bash",
            rev,
            dir,
            imageEp,
          ],
          { encoding: "utf8" },
        );

      // ③ rev 未建 + current 未建 → image(裸镜像)
      assert.equal(pick("abc123def456"), imageEp, "rev/current 均缺 → image");
      // ② current 建了、rev 未建 → current
      writeFileSync(currentEp, "// current");
      assert.equal(pick("abc123def456"), currentEp, "rev 缺 → current");
      // ① rev 建了 + REV 合法 → rev-pinned(优先于 current)
      writeFileSync(revEp, "// rev");
      assert.equal(pick("abc123def456"), revEp, "REV 合法且 rev 存在 → rev-pinned");
      // REV 非法(路径注入/大写/13位)即使 rev 存在也不采用 → 回落 current
      assert.equal(pick("../etc/passwd"), currentEp, "REV 注入串 → 拒,回落 current");
      assert.equal(pick("ABC123DEF456"), currentEp, "REV 大写 → 拒(严格小写 hex)");
      assert.equal(pick(""), currentEp, "REV 缺失 → current");
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
    // codex overlay + 平台 seed skill 共用 shouldWriteSeededSkill("hash-overwrite");原生 populate 仍 skip-if-exists。
    assert.match(src, /shouldWriteSeededSkill\("hash-overwrite"/);
    // dev fallback:platformSeed 缺失回落 DEV_FALLBACK_SEED_DOC(仍是一份**声明**,与生产同一条装配路径)。
    assert.match(src, /const seedDoc: PlatformSeedDoc = platformSeed \?\? DEV_FALLBACK_SEED_DOC/);
    assert.match(src, /minimal main-only/);
  });

  test("entrypoint.ts exposes bundle-only CLIs to login shells without violating validate-only or overwriting user files", () => {
    const src = readFileSync(ENTRYPOINT_TS, "utf8");
    assert.match(src, /const PLATFORM_BIN_DIR = "\/run\/oc\/platform\/current\/bin"/);
    assert.match(src, /const USER_PLATFORM_BIN_DIR = "\/home\/agent\/\.local\/bin"/);
    assert.match(
      src,
      /const PLATFORM_LINKED_CLIS = \["oc-plugin", "oc-ocr", "oc-h3", "oc-video"\] as const/,
    );
    assert.match(src, /const source = join\(PLATFORM_BIN_DIR, cliName\)/);
    assert.match(src, /const userLink = join\(USER_PLATFORM_BIN_DIR, cliName\)/);
    assert.match(src, /lstatSync\(userLink\)/);
    assert.match(src, /readlinkSync\(userLink\) !== source/);
    assert.match(src, /symlinkSync\(source, userLink\)/);
    assert.match(src, /already exists with an unexpected target; preserved/);
    assert.doesNotMatch(
      src,
      /unlinkSync\(userLink\)/,
      "entrypoint 不得删除用户已有的普通文件、目录或异向链接",
    );

    const validateOnlyIdx = src.indexOf('if ((process.env.OC_ENTRYPOINT_VALIDATE_ONLY || "").trim() === "1")');
    const validateExitIdx = src.indexOf("process.exit(0);", validateOnlyIdx);
    const platformLinkIdx = src.indexOf("const PLATFORM_LINKED_CLIS");
    assert.ok(
      validateOnlyIdx > 0 && validateExitIdx > validateOnlyIdx && platformLinkIdx > validateExitIdx,
      "platform CLI 链接写入必须位于 validate-only 早退之后",
    );
  });

  test("M4a:平台 seed skill 从 skip-if-exists 改 hash-overwrite(平台更新送达存量 volume)", () => {
    const src = readFileSync(ENTRYPOINT_TS, "utf8");
    // ensureAgentSeedSkill 不再 skip-if-exists 短路;改经 shouldWriteSeededSkill 判定覆写。
    assert.doesNotMatch(src, /if \(existsSync\(skillPath\)\) return;/, "seed skill 不得再走 skip-if-exists 短路");
    assert.match(src, /shouldWriteSeededSkill\("hash-overwrite", targetExists, targetContent, content\)/);
  });

  test("M4b:persona 升级走 decidePersonaWrite 三态 + .platform-persona-hash 记录", () => {
    const src = readFileSync(ENTRYPOINT_TS, "utf8");
    assert.match(src, /const PERSONA_HASH_FILE = "\.platform-persona-hash"/);
    assert.match(src, /decidePersonaWrite\(\{/, "persona 升级决策走纯函数 decidePersonaWrite");
    // 用户定制保护日志(平台热更新明确排除用户改过的 persona)。
    assert.match(src, /customization protected/);
    assert.match(src, /skip platform upgrade \(conservative\)/);
  });

  test("M5:消费端源/写路径 containment(isPathWithin)+ realpath 源基准", () => {
    const src = readFileSync(ENTRYPOINT_TS, "utf8");
    // 源:seed 根 realpath 一次做 containment 基准。
    assert.match(src, /const platformSeedDirReal = platformSeedDir === null \? null : realpathSync\(platformSeedDir\)/);
    assert.match(src, /isPathWithin\(platformSeedDirReal!, realpathSync\(skillMd\)\)/, "seed skill 源必须 containment");
    // 写:seed-skill / persona 写目标 containment 到 agents 子树。
    assert.match(src, /isPathWithin\(join\(ocConfigDir, "agents", agentId, "seed-skills"\), skillPath\)/);
    assert.match(src, /isPathWithin\(join\(ocConfigDir, "agents"\), personaPath\)/);
  });
});

describe("R2-M2 validateSeedAssetsExist(persona/seed skill 引用存在性 + containment,纯函数)", () => {
  const j = (...p: string[]) => p.join("/");
  const doc = {
    schemaVersion: 2,
    agents: [
      { id: "main", model: "glm-5.2", provider: "ark", persona: "personas/main.md" },
      { id: "codex", model: "gpt-5.6-sol", provider: "codex-native", runnerKind: "app-server" },
    ],
    seedSkills: { scientist: ["demo"] },
  };
  const presentSet = (paths: string[]) => (p: string) => new Set(paths).has(p);

  test("全部引用存在且不逃逸 → 空错误清单", () => {
    const errs = pb.validateSeedAssetsExist("/seed", "/seed", doc, {
      exists: presentSet(["/seed/personas/main.md", "/seed/skills/scientist/demo/SKILL.md"]),
      realpath: (p: string) => p,
      join: j,
    });
    assert.deepEqual(errs, []);
  });
  test("persona 文件缺失 → 报 persona missing(agentId 带出)", () => {
    const errs = pb.validateSeedAssetsExist("/seed", "/seed", doc, {
      exists: presentSet(["/seed/skills/scientist/demo/SKILL.md"]),
      realpath: (p: string) => p,
      join: j,
    });
    assert.equal(errs.length, 1);
    assert.match(errs[0], /persona for agent "main" missing/);
  });
  test("seed skill 文件缺失 → 报 seed skill missing", () => {
    const errs = pb.validateSeedAssetsExist("/seed", "/seed", doc, {
      exists: presentSet(["/seed/personas/main.md"]),
      realpath: (p: string) => p,
      join: j,
    });
    assert.equal(errs.length, 1);
    assert.match(errs[0], /seed skill "scientist\/demo" missing/);
  });
  test("引用存在但 realpath 逃逸 seed 子树 → 报 escapes", () => {
    const errs = pb.validateSeedAssetsExist("/seed", "/seed", doc, {
      exists: presentSet(["/seed/personas/main.md", "/seed/skills/scientist/demo/SKILL.md"]),
      realpath: (p: string) => (p === "/seed/personas/main.md" ? "/etc/evil" : p), // main persona 软链逃逸
      join: j,
    });
    assert.equal(errs.length, 1);
    assert.match(errs[0], /persona for agent "main" escapes bundle seed dir/);
  });
});

describe("R2-M4 assertVolumeAncestryNoSymlink(祖先 symlink 逃逸拒,注入 lstat)", () => {
  const dn = (p: string) => p.split("/").slice(0, -1).join("/") || "/";
  const linkStat = (isLink: boolean) => ({ isSymbolicLink: () => isLink });

  test("无 symlink 祖先 → 通过", () => {
    assert.doesNotThrow(() =>
      pb.assertVolumeAncestryNoSymlink("/vol/agents/main/CLAUDE.md", "/vol", () => linkStat(false), dn),
    );
  });
  test("某级祖先是 symlink → 抛(拒穿透写)", () => {
    const links = new Set(["/vol/agents"]); // agents 被换成 symlink
    assert.throws(
      () =>
        pb.assertVolumeAncestryNoSymlink(
          "/vol/agents/main/CLAUDE.md",
          "/vol",
          (p: string) => linkStat(links.has(p)),
          dn,
        ),
      /symlink/,
    );
  });
  test("target 词法越界(不在 volumeRoot 下)→ 抛", () => {
    assert.throws(
      () => pb.assertVolumeAncestryNoSymlink("/etc/passwd", "/vol", () => linkStat(false), dn),
      /escapes volume root/,
    );
  });
  test("祖先尚未创建(lstat 抛)→ 跳过该级,不误报", () => {
    assert.doesNotThrow(() =>
      pb.assertVolumeAncestryNoSymlink(
        "/vol/agents/main/CLAUDE.md",
        "/vol",
        (p: string) => {
          if (p === "/vol/agents/main" || p === "/vol/agents/main/CLAUDE.md") throw new Error("ENOENT");
          return linkStat(false);
        },
        dn,
      ),
    );
  });
});

describe("R2-M4 safeWritePlatformVolumeFile(三步合一:原子写 + 祖先 symlink 拒,真实 fs)", () => {
  const realFs = { lstatSync, mkdirSync, realpathSync, writeFileSync, renameSync };

  test("正常:落盘内容正确 + 临时文件已 rename(原子)", () => {
    const vol = mkdtempSync(join(tmpdir(), "oc-m4-ok-"));
    try {
      const target = join(vol, "agents", "main", "CLAUDE.md");
      pb.safeWritePlatformVolumeFile({
        targetPath: target,
        volumeRoot: vol,
        content: "hello persona\n",
        mode: 0o644,
        fs: realFs,
        dirname,
        randomSuffix: () => "testsuffix",
      });
      assert.equal(readFileSync(target, "utf8"), "hello persona\n");
      assert.ok(!existsSync(`${target}.tmp-testsuffix`), "临时文件必须已 rename 掉");
    } finally {
      rmSync(vol, { recursive: true, force: true });
    }
  });

  test("祖先 symlink → 抛(拒穿透写卷外),绝不落盘到卷外", () => {
    const vol = mkdtempSync(join(tmpdir(), "oc-m4-lnk-"));
    const outside = mkdtempSync(join(tmpdir(), "oc-m4-out-"));
    try {
      symlinkSync(outside, join(vol, "agents")); // agents 被换成指向卷外的 symlink
      const target = join(vol, "agents", "main", "CLAUDE.md");
      assert.throws(
        () =>
          pb.safeWritePlatformVolumeFile({
            targetPath: target,
            volumeRoot: vol,
            content: "x",
            mode: 0o644,
            fs: realFs,
            dirname,
            randomSuffix: () => "s",
          }),
        /symlink/,
      );
      assert.ok(!existsSync(join(outside, "main", "CLAUDE.md")), "绝不能穿透 symlink 写到卷外");
    } finally {
      rmSync(vol, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("R2-M2b validatePlatformSeedCli.ts(deploy prepare 离线语义校验 CLI)", () => {
  const CLI = join(PLATFORM_RUNTIME, "entrypoint", "validatePlatformSeedCli.ts");
  function buildBundle(root: string, opts: { withSkill: boolean }): void {
    mkdirSync(join(root, "seed", "personas"), { recursive: true });
    mkdirSync(join(root, "seed", "skills", "scientist", "demo"), { recursive: true });
    writeFileSync(
      join(root, "seed", "platform-seed.yaml"),
      "schemaVersion: 2\nagents:\n  - id: main\n    model: glm-5.2\n    provider: ark\n    persona: personas/main.md\n" +
        "seedSkills:\n  scientist:\n    - demo\n",
    );
    writeFileSync(join(root, "seed", "personas", "main.md"), "# main\n");
    if (opts.withSkill) writeFileSync(join(root, "seed", "skills", "scientist", "demo", "SKILL.md"), "# demo\n");
  }
  function runCli(bundleRoot: string): { status: number; stderr: string } {
    try {
      execFileSync("npx", ["--no", "tsx", CLI, bundleRoot], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { status: 0, stderr: "" };
    } catch (e) {
      const err = e as { status?: number | null; stderr?: string };
      return { status: err.status ?? -1, stderr: String(err.stderr ?? "") };
    }
  }
  test("引用齐全 → exit 0(stderr 留证执行三元组)", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-cli-ok-"));
    try {
      buildBundle(dir, { withSkill: true });
      assert.equal(runCli(dir).status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("seed skill 文件缺失 → exit 1 + stderr 原因", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-cli-bad-"));
    try {
      buildBundle(dir, { withSkill: false });
      const r = runCli(dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /seed skill "scientist\/demo" missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("声明含 banned engine 键 → schema 校验 exit 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-cli-schema-"));
    try {
      mkdirSync(join(dir, "seed"), { recursive: true });
      writeFileSync(
        join(dir, "seed", "platform-seed.yaml"),
        "schemaVersion: 2\nagents:\n  - id: main\n    model: glm-5.2\n    provider: ark\n    engine: ccb\n",
      );
      const r = runCli(dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /forbidden key "engine"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("schema v2 值校验也在 CLI 生效:缺 model / 未知 provider / 旧 v1 文档 → exit 1", () => {
    const cases: [string, string, RegExp][] = [
      ["oc-cli-nomodel-", "schemaVersion: 2\nagents:\n  - id: main\n    provider: ark\n", /non-empty string model/],
      [
        "oc-cli-badprov-",
        "schemaVersion: 2\nagents:\n  - id: main\n    model: glm-5.2\n    provider: openai\n",
        /not in known set/,
      ],
      // 旧 v1 文档(无执行三元组)必须被 deploy 期 fail-closed 拦下,而不是静默 seed 出无模型 agent。
      ["oc-cli-v1-", "schemaVersion: 1\nagents:\n  - id: main\n", /unsupported schemaVersion/],
    ];
    for (const [prefix, yaml, want] of cases) {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      try {
        mkdirSync(join(dir, "seed"), { recursive: true });
        writeFileSync(join(dir, "seed", "platform-seed.yaml"), yaml);
        const r = runCli(dir);
        assert.equal(r.status, 1, `${prefix} 必须 exit 1`);
        assert.match(r.stderr, want);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe("R2-M2c/M4 entrypoint.ts validate-only 早退 + 写侧 symlink 逃逸纵深(源码不变量)", () => {
  test("M2c:OC_ENTRYPOINT_VALIDATE_ONLY=1 早退在 volume try 之前,过 seed 语义校验后 exit 0/1", () => {
    const src = readFileSync(ENTRYPOINT_TS, "utf8");
    // validate-only 分支存在,读 OC_ENTRYPOINT_VALIDATE_ONLY,调 validateSeedAssetsExist。
    assert.match(src, /OC_ENTRYPOINT_VALIDATE_ONLY \|\| ""\)\.trim\(\) === "1"/);
    assert.match(src, /validateSeedAssetsExist\(platformSeedDir, platformSeedDirReal!, platformSeed,/);
    assert.match(src, /process\.exit\(0\)/);
    // 早退必须在 volume try(mkdirSync(ocConfigDir...)之前 —— 不写任何 volume。
    const validateOnlyIdx = src.indexOf("OC_ENTRYPOINT_VALIDATE_ONLY");
    const volumeTryIdx = src.indexOf("try {\n  mkdirSync(ocConfigDir");
    assert.ok(validateOnlyIdx > 0 && volumeTryIdx > 0 && validateOnlyIdx < volumeTryIdx,
      "validate-only 早退必须在 volume try 之前(不写 volume / 不 spawn gateway)");
  });

  test("M4:persona/hash/seed-skill 写走 platformVolumeWrite;codex overlay 前 assertVolumeAncestryNoSymlink;renameSync 已引入", () => {
    const src = readFileSync(ENTRYPOINT_TS, "utf8");
    // renameSync 已 import(原子落盘)。
    assert.match(src, /\n  renameSync,\n/);
    // 统一写 helper + 复核 helper 定义。
    assert.match(src, /function platformVolumeWrite\(/);
    assert.match(src, /safeWritePlatformVolumeFile\(\{/);
    assert.match(src, /function assertDirWithinVolume\(/);
    // persona / hash / seed skill 三处写都改经 platformVolumeWrite。
    assert.match(src, /platformVolumeWrite\(personaPath, ocConfigDir, content, 0o644\)/);
    assert.match(src, /platformVolumeWrite\(hashPath, ocConfigDir, `\$\{hash\}\\n`, 0o644\)/);
    assert.match(src, /platformVolumeWrite\(skillPath, ocConfigDir, content, 0o644\)/);
    // codex overlay(两处 cpSync)前置祖先 symlink 逃逸拒。
    assert.match(src, /assertVolumeAncestryNoSymlink\(targetDir, CODEX_HOME_DIR, lstatSync, dirname\)/);
    // 旧的裸 writeFileSync(personaPath/skillPath) 不得残留(全走 helper)。
    assert.doesNotMatch(src, /writeFileSync\(personaPath, content/);
    assert.doesNotMatch(src, /writeFileSync\(skillPath, content/);
  });
});
