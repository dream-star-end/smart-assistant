/**
 * check:v5:fast 选门对照。先钉三种交付场景的裁剪,再钉「不得削弱 CI」契约。
 *
 * 不跑任何昂贵套件,只对纯函数 + 读 package.json / workflow。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import {
  ALL_GATE_IDS,
  gateMeta,
  groupByPhase,
  selectGates,
} from "../select-gates.ts";
import { gateCommand, runFast } from "../run-v5-fast.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function ids(files: string[]) {
  return selectGates(files).selected;
}

describe("selectGates scenarios", () => {
  test("(a) 只改一个普通 md/文案 → 零质量门", () => {
    const sel = selectGates(["docs/playbook.md"]);
    assert.deepEqual(sel.selected, []);
    assert.deepEqual(sel.skipped, ALL_GATE_IDS);
    assert.equal(sel.typecheck.projects.length, 0);
    assert.equal(sel.typecheck.webReact, false);
  });

  test("(a) README / 普通 docs 同样跳过,但 V5_CI.md 会拉 ci-parity", () => {
    assert.deepEqual(ids(["README.md"]), []);
    assert.deepEqual(ids(["docs/V5_CI.md"]), ["check:ci-parity"]);
  });

  test("(b) 只改 packages/gateway 一个文件 → 便宜门 + gateway 单测 + scoped typecheck,不拉 commercial 运行时", () => {
    const sel = selectGates(["packages/gateway/src/session/engine.ts"]);
    assert.ok(sel.selected.includes("test:gateway"));
    assert.ok(sel.selected.includes("typecheck"));
    assert.ok(sel.selected.includes("check:v5:incidents"));
    assert.ok(sel.selected.includes("lint:scheduler-wiring"));
    assert.ok(!sel.selected.includes("test:commercial:unit:gate"), "gateway-only 不应拉 commercial unit");
    assert.ok(!sel.selected.includes("test:commercial:integ:shard"), "gateway-only 不应拉 commercial integ");
    assert.ok(!sel.selected.includes("test:protocol"));
    assert.ok(!sel.selected.includes("test:browser"));
    assert.ok(!sel.selected.includes("test:web-react"));
    assert.ok(sel.typecheck.projects.includes("packages/gateway"));
    assert.ok(sel.typecheck.projects.includes("packages/commercial"));
    assert.ok(sel.typecheck.projects.includes("packages/cli"));
    assert.equal(sel.typecheck.fullComposite, false);
    assert.equal(sel.typecheck.webReact, false);
  });

  test("(c) 改 packages/protocol → 近全量,且 commercial 两门都在,integ 在最后一波", () => {
    const sel = selectGates(["packages/protocol/src/frames.ts"]);
    for (const must of [
      "typecheck",
      "test:protocol",
      "test:channels",
      "test:gateway",
      "test:mcp-memory",
      "test:storage",
      "test:web-react",
      "test:browser",
      "test:commercial:unit:gate",
      "test:commercial:integ:shard",
      "check:v5:incidents",
      "lint:scheduler-wiring",
    ] as const) {
      assert.ok(sel.selected.includes(must), `protocol 应选中 ${must}, 实际: ${sel.selected.join(",")}`);
    }
    assert.ok(sel.typecheck.fullComposite);
    assert.ok(sel.typecheck.webReact);
    const phases = groupByPhase(sel.selected);
    assert.equal(phases[0]?.cost, "cheap");
    assert.equal(phases[phases.length - 1]?.cost, "very-expensive");
    assert.deepEqual(
      phases[phases.length - 1]?.gates.map((g) => g.id),
      ["test:commercial:integ:shard"],
    );
    const expensive = phases.find((p) => p.cost === "expensive");
    assert.ok(expensive?.gates.some((g) => g.id === "test:commercial:unit:gate"));
    assert.ok(expensive?.gates.some((g) => g.id === "test:browser"));
  });
});

describe("selectGates mapping edges", () => {
  test("commercial http 变动会拉 unit + integ,且两门都带 commercial 锁", () => {
    const sel = selectGates(["packages/commercial/src/http/coreMemoryLocalRanker.ts"]);
    assert.ok(sel.selected.includes("test:commercial:unit:gate"));
    assert.ok(sel.selected.includes("test:commercial:integ:shard"));
    assert.equal(gateMeta("test:commercial:unit:gate").lock, "commercial");
    assert.equal(gateMeta("test:commercial:integ:shard").lock, "commercial");
  });

  test("commercial 非 http/db 源码拉 unit 但不拉 integ", () => {
    const sel = selectGates(["packages/commercial/src/billing/foo.ts"]);
    assert.ok(sel.selected.includes("test:commercial:unit:gate"));
    assert.ok(!sel.selected.includes("test:commercial:integ:shard"));
  });

  test("integ 文件变动拉 lint:integ-tiers + integ shard", () => {
    const sel = selectGates(["packages/commercial/src/__tests__/login.integ.test.ts"]);
    assert.ok(sel.selected.includes("lint:integ-tiers"));
    assert.ok(sel.selected.includes("test:commercial:integ:shard"));
  });

  test("web-react 源码拉 jsdom + browser + e2e-selectors,不拉 commercial", () => {
    const sel = selectGates(["packages/web-react/src/App.tsx"]);
    assert.ok(sel.selected.includes("test:web-react"));
    assert.ok(sel.selected.includes("test:browser"));
    assert.ok(sel.selected.includes("check:v5:e2e-selectors"));
    assert.ok(!sel.selected.includes("test:commercial:unit:gate"));
  });

  test("channels/telegram 只跑 test:channels,wechat 才带 scoped typecheck", () => {
    const tg = selectGates(["packages/channels/telegram/src/bot.ts"]);
    assert.ok(tg.selected.includes("test:channels"));
    assert.ok(!tg.selected.includes("typecheck"));
    const wx = selectGates(["packages/channels/wechat/src/index.ts"]);
    assert.ok(wx.selected.includes("test:channels"));
    assert.ok(wx.selected.includes("typecheck"));
    assert.ok(wx.typecheck.projects.includes("packages/channels/wechat"));
  });

  test("同波内 commercial 锁门彼此串行,无锁门可并行", () => {
    const phases = groupByPhase([
      "test:gateway",
      "test:commercial:unit:gate",
      "test:browser",
    ]);
    const expensive = phases.find((p) => p.cost === "expensive");
    assert.ok(expensive);
    const locked = expensive!.gates.filter((g) => g.lock);
    const unlocked = expensive!.gates.filter((g) => !g.lock);
    assert.deepEqual(locked.map((g) => g.id), ["test:commercial:unit:gate"]);
    assert.deepEqual(unlocked.map((g) => g.id), ["test:browser"]);
  });

  test("Wave 1/2 治理快门选门映射(OCV5-847/849/859):按触及面精准触发 cheap 快门,不拉重浏览器", () => {
    assert.ok(ids(["AGENTS.md"]).includes("check:docs-links"));
    assert.ok(ids(["packages/commercial/src/http/router.ts"]).includes("check:route-sync"));
    assert.ok(ids(["packages/gateway/src/bridgeApiAllowlist.ts"]).includes("check:route-sync"));
    assert.ok(ids(["packages/commercial/src/db/migrations/0280_test.sql"]).includes("check:pg-migration-safety"));
    assert.ok(ids(["packages/protocol/src/httpContracts.ts"]).includes("check:rest-contract"));
    assert.ok(ids(["packages/web-react/budgets.json"]).includes("check:monotonic-baselines"));
    assert.ok(ids(["deploy/v5/feature-flags-registry.json"]).includes("check:feature-flags-ttl"));
    assert.ok(ids(["deploy/v5/feature-flags-registry.json"]).includes("check:monotonic-baselines"));
    assert.ok(ids(["changelog.json"]).includes("check:changelog-guard"));
    assert.ok(ids(["packages/web-react/src/App.tsx"]).includes("check:ui-gates"));
    assert.ok(ids(["scripts/check-v5-route-sync.ts"]).includes("check:governance:fast"));
    assert.ok(ids(["scripts/deploy-v5-selfhost.sh"]).includes("test:v5:ops"));
    for (const g of [
      "check:docs-links",
      "check:ui-gates",
      "check:no-weak-downgrade",
      "check:route-sync",
      "check:monotonic-baselines",
      "check:changelog-guard",
      "check:feature-flags-ttl",
      "check:pg-migration-safety",
      "check:rest-contract",
      "check:governance:fast",
    ] as const) {
      assert.equal(gateMeta(g).cost, "cheap", `${g} must stay cheap`);
      assert.equal(gateMeta(g).lock, null, `${g} must be lock-free`);
    }
    for (const g of [
      "check:monotonic-baselines",
      "check:changelog-guard",
      "check:pg-migration-safety",
      "check:rest-contract",
    ] as const) {
      const cmd = gateCommand(gateMeta(g), "origin/feat/v5-selfhost");
      assert.ok(
        cmd.args.includes("--base") && cmd.args.includes("origin/feat/v5-selfhost"),
        `${g} must forward --base to checker: ${cmd.args.join(" ")}`,
      );
    }
  });

  test("OCV5-885 check:context:static 按路径精准门控: 命中上下文/提示词/压缩/记忆/技能路径, 跳过无关路径", () => {
    const mustHit = [
      "scripts/check-context-static.ts",
      "scripts/lib/contextStaticFixtures.ts",
      ".github/context-eval-baseline.json",
      "scripts/v5-skill-shadow-eval.ts",
      "scripts/context-replay-eval.ts",
      "evals/context-golden/bucket-a.json",
      "evals/context-golden/cases.json",
      "packages/gateway/src/promptSlots.ts",
      "packages/gateway/src/promptFreeze.ts",
      "packages/gateway/src/sessionLifecycle.ts",
      "packages/gateway/src/sessionCheckpointAnchors.ts",
      "packages/gateway/src/sessionManager.ts",
      "packages/gateway/src/subprocessRunner.ts",
      "packages/gateway/src/v3ToolFailureReporter.ts",
      "packages/gateway/src/engine/antigravityAdapter.ts",
      "packages/gateway/src/engine/antigravityPromptState.ts",
      "packages/gateway/src/engine/resumedEnvelopeDedup.ts",
      "packages/gateway/src/skillRetrievalShadow.ts",
      "packages/gateway/src/autoDream.ts",
      "packages/commercial/src/intelligentUi/index.ts",
      "packages/commercial/agent-sandbox/platform-runtime/prompts/platform-capabilities.md",
      "packages/commercial/agent-sandbox/ccb-baseline/skills/browser/SKILL.md",
      "packages/mcp-memory/src/memoryTools.ts",
      "packages/storage/src/contextJanitor.ts",
      "packages/storage/src/memoryDir.ts",
      "packages/storage/src/memoryLifecycle.ts",
      "packages/storage/src/projectContext.ts",
    ];
    for (const file of mustHit) {
      assert.ok(
        ids([file]).includes("check:context:static"),
        `expected ${file} to trigger check:context:static`,
      );
    }

    const mustSkip = [
      "docs/playbook.md",
      "README.md",
      "packages/web-react/src/App.tsx",
      "packages/commercial/src/billing/foo.ts",
      "packages/gateway/src/session/engine.ts",
      "packages/channels/telegram/src/bot.ts",
      "packages/cli/src/index.ts",
      "changelog.json",
    ];
    for (const file of mustSkip) {
      assert.equal(
        ids([file]).includes("check:context:static"),
        false,
        `expected unrelated file ${file} to skip check:context:static`,
      );
    }

    assert.equal(gateMeta("check:context:static").cost, "cheap");
    assert.equal(gateMeta("check:context:static").lock, null);

    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.ok(
      pkg.scripts["check:governance:fast"]?.includes("tsx scripts/check-context-static.ts --skip-sub-evals"),
      "check:governance:fast must include fast check-context-static --skip-sub-evals",
    );
  });

  test("run-v5-fast 把 --base 透传给 check:changelog-guard,干净工作树中已提交的 changelog.json 变更真实退出 1", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "oc-fast-base-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      BOSS_APPROVED_CHANGELOG: "0",
    };
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], { env, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.invalid");

    const tsxCli = join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    cpSync(join(REPO_ROOT, "scripts/check-changelog-guard.ts"), join(dir, "scripts/check-changelog-guard.ts"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "fast-base-fixture",
        private: true,
        scripts: {
          "check:changelog-guard": `node ${JSON.stringify(tsxCli)} scripts/check-changelog-guard.ts`,
        },
      }),
    );
    writeFileSync(join(dir, "changelog.json"), "[]\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const baseSha = git("rev-parse", "HEAD");

    // Commit a changelog.json edit and leave working tree 100% clean.
    writeFileSync(join(dir, "changelog.json"), '[{"version":"9.9.9"}]\n');
    git("commit", "-qam", "edit-changelog");
    assert.equal(git("status", "--short"), "", "working tree must be clean");

    const prevBoss = process.env.BOSS_APPROVED_CHANGELOG;
    process.env.BOSS_APPROVED_CHANGELOG = "0";
    try {
      const code = await runFast({ dryRun: false, base: baseSha, cwd: dir });
      assert.equal(code, 1, "committed changelog.json edit must fail with exit 1 when runFast forwards --base");
    } finally {
      if (prevBoss === undefined) delete process.env.BOSS_APPROVED_CHANGELOG;
      else process.env.BOSS_APPROVED_CHANGELOG = prevBoss;
    }
  });
});

describe("check:v5:fast 不得削弱 CI", () => {
  test("package.json 有 check:v5:fast,且它不在 check:v5 链里", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.ok(pkg.scripts["check:v5:fast"], "missing check:v5:fast");
    assert.ok(pkg.scripts["check:v5"], "missing check:v5");
    assert.equal(pkg.scripts["check:v5"].includes("check:v5:fast"), false);
    assert.match(pkg.scripts["check:v5:fast"], /run-v5-fast/);
    // 全量链直接 npm run 数；新增门必须同时进 CI 与 check:v5（OCV5-119 加了 check:test-retries，
    // OCV5-548 加了 test:kernel，OCV5-607 加了 test:ccb:box-context，首屏预算加了 build:web-react）。
    const runs = pkg.scripts["check:v5"].match(/\bnpm run \S+/g) ?? [];
    assert.equal(runs.length, 24, `check:v5 应为 24 个直接步骤,实际 ${runs.length}: ${runs.join(" , ")}`);
    assert.ok(pkg.scripts["check:v5"].includes("check:test-retries"), "check:v5 必须含 check:test-retries");
    assert.ok(pkg.scripts["check:v5"].includes("npm run test:kernel"), "check:v5 必须含 test:kernel");
    assert.ok(pkg.scripts["check:v5"].includes("npm run test:ccb:box-context"), "check:v5 必须含 test:ccb:box-context");
    assert.ok(runs.includes("npm run build:gateway-test-artifacts"), "gateway tests require actual CCB/MCP artifacts");
    assert.ok(runs.indexOf("npm run build:gateway-test-artifacts") < runs.indexOf("npm run test:gateway"));
    assert.ok(runs.includes("npm run build:web-react"), "check:v5 必须含生产构建首屏预算门 build:web-react");
  });

  test("v5-ci.yml 不引用 check:v5:fast", () => {
    const yml = readFileSync(join(REPO_ROOT, ".github/workflows/v5-ci.yml"), "utf8");
    assert.equal(yml.includes("check:v5:fast"), false);
    assert.ok(yml.includes("npm run check:v5:incidents") || yml.includes("check:v5:incidents"));
  });

  test("run-v5-fast --dry-run 对三场景打印选中/跳过/分波,且 exit 0", () => {
    const bin = join(REPO_ROOT, "scripts/run-v5-fast.ts");
    const cases: Array<{ files: string; expect: string; forbid?: string }> = [
      { files: "docs/playbook.md", expect: "nothing to run" },
      { files: "packages/gateway/src/session/engine.ts", expect: "+ test:gateway", forbid: "test:commercial:integ:shard" },
      { files: "packages/protocol/src/frames.ts", expect: "phase very-expensive" },
    ];
    for (const c of cases) {
      const r = spawnSync(
        "npx",
        ["tsx", bin, "--dry-run", "--files", c.files],
        { cwd: REPO_ROOT, encoding: "utf8" },
      );
      const out = `${r.stdout}\n${r.stderr}`;
      assert.equal(r.status, 0, `${c.files} dry-run exit ${r.status}:\n${out}`);
      assert.ok(out.includes(c.expect), `${c.files} missing ${JSON.stringify(c.expect)}:\n${out}`);
      if (c.forbid) assert.equal(out.includes(`+ ${c.forbid}`), false, out);
    }
  });

  test("test:v5:ops 收了选门与 huggingface 桩的单测,防止回归只在本地绿", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.match(pkg.scripts["test:v5:ops"], /selectGates\.test\.ts/);
    assert.match(pkg.scripts["test:v5:ops"], /huggingfaceTransformersStub\.test\.ts/);
  });
});
