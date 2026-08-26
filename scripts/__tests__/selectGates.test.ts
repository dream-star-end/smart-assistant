/**
 * check:v5:fast 选门对照。先钉三种交付场景的裁剪,再钉「不得削弱 CI」契约。
 *
 * 不跑任何昂贵套件,只对纯函数 + 读 package.json / workflow。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  ALL_GATE_IDS,
  gateMeta,
  groupByPhase,
  selectGates,
} from "../select-gates.ts";

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
    // 全量链保持 19 个直接 npm run；immutable prove 由 test:v5:ops 内的真实仓库门执行
    const runs = pkg.scripts["check:v5"].match(/\bnpm run \S+/g) ?? [];
    assert.equal(runs.length, 19, `check:v5 应为 19 个直接步骤,实际 ${runs.length}: ${runs.join(" , ")}`);
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
