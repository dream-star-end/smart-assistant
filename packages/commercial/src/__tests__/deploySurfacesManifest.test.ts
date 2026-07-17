/**
 * selfheal 批1b — deploy 生效面 manifest 锁定测试(V5-DEPLOY 名下,新增独立文件)。
 *
 * 三件事(契约 §7 / RFC §3):
 *   ① manifest 严格 schema 校验(字段/类型/glob 可编译/verifyLayers 引用的层在仓根
 *      package.json scripts 里真实存在);
 *   ② playbook §4.1 锚点之间内容 === 由 manifest 生成的结果(锁定"表由 manifest 生成");
 *   ③ manual 清单必含 RFC §3 列举的每一类(逐项断言:每个代表路径都被某条 manual glob 命中)。
 *
 * 生成器与 glob→RegExp 编译器都在本文件内(契约 §5:"可以是测试内函数,不必独立脚本"),
 * 并 export 供人工核对/后续复用。分类器(个人版 packages/gateway/src/selfheal/deploySurfaces.ts,
 * P-CLS 名下)必须与本文件的 manual/rules 元素形状(`{glob, surface?, note}`)和 `**` glob 语义
 * 对齐 —— 见报告"与 P-CLS 对账点"。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const MANIFEST_PATH = `${REPO_ROOT}deploy/v5/selfheal-deploy-surfaces.json`;
const PLAYBOOK_PATH = `${REPO_ROOT}docs/V5_DEV_PLAYBOOK.md`;
const ROOT_PKG_PATH = `${REPO_ROOT}package.json`;

const SURFACE_ORDER = ["master", "web", "runtime-source", "platform-runtime", "egress"] as const;
const KNOWN_SURFACES = new Set<string>(SURFACE_ORDER);
const KNOWN_AXES = new Set<string>(["runtime-release", "platform-bundle"]);
const ANCHOR_BEGIN = "<!-- selfheal-deploy-surfaces:begin -->";
const ANCHOR_END = "<!-- selfheal-deploy-surfaces:end -->";

interface Surface {
  label: string;
  deployAction: string;
  verifyLayers: string[];
  requiresAxis: string | null;
  note: string;
}
interface Rule { glob: string; surface: string; note: string }
interface Manual { glob: string; note: string }
interface Manifest {
  schema: string;
  version: number;
  surfaces: Record<string, Surface>;
  rules: Rule[];
  manual: Manual[];
}

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

/**
 * glob → RegExp(picomatch 风格 `**` 语义,test 与分类器必须同源):
 *  - `**`/ 匹配零个或多个目录段(故 `**​/package.json` 命中根 `package.json`);
 *  - `**` 不跟 `/` 时匹配任意(含分隔符);
 *  - `*` 匹配单段内任意非 `/`;`?` 单个非 `/`;其余正则元字符转义。
 * 编译失败(抛异常)即视为 glob 语法非法。
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++; // consume second '*'
        if (glob[i + 1] === "/") {
          i++; // consume '/'
          re += "(?:.*/)?"; // **/ → zero-or-more path segments
        } else {
          re += ".*"; // ** → any run incl. separators
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/** 由 manifest 生成 playbook §4.1 的锚定矩阵段(确定性;测试用它锁定 playbook)。 */
export function generateSurfacesTable(m: Manifest): string {
  const L: string[] = [];
  L.push(ANCHOR_BEGIN);
  L.push("<!-- 本表由 deploy/v5/selfheal-deploy-surfaces.json 生成(改矩阵改 manifest,勿手改本段)。");
  L.push("     生成器/锁定测试:packages/commercial/src/__tests__/deploySurfacesManifest.test.ts。 -->");
  L.push("");
  L.push("| 改动位置(glob) | 生效面 | 必做动作 | verify 层 |");
  L.push("|---|---|---|---|");
  for (const name of SURFACE_ORDER) {
    const s = m.surfaces[name];
    const globs = m.rules
      .filter((r) => r.surface === name)
      .map((r) => "`" + r.glob + "`")
      .join("<br>");
    const layers = s.verifyLayers.length
      ? s.verifyLayers.map((l) => "`" + l + "`").join(", ")
      : "—";
    L.push(`| ${globs} | ${s.label} | ${s.deployAction} | ${layers} |`);
  }
  L.push(
    "| (见下方 manual-only 清单) | **manual-only(fail-closed)** | 人工受控(§4.5 apply / RFC §3);另:rules 零命中 / 未知路径 / 未知 manifest version / symlink·gitlink·typechange 亦整体 manual | — |",
  );
  L.push("");
  L.push("**manual-only globs**(命中任一 → 整体 `manual_required`):");
  L.push("");
  for (const mm of m.manual) {
    L.push(`- \`${mm.glob}\` — ${mm.note}`);
  }
  L.push(ANCHOR_END);
  return L.join("\n");
}

function extractAnchoredBlock(text: string): string {
  const start = text.indexOf(ANCHOR_BEGIN);
  const end = text.indexOf(ANCHOR_END);
  assert.ok(start >= 0, "playbook 缺 begin 锚点");
  assert.ok(end > start, "playbook 缺 end 锚点或顺序错");
  return text.slice(start, end + ANCHOR_END.length);
}

describe("selfheal deploy-surfaces manifest", () => {
  test("① 严格 schema 校验(字段/类型/glob 可编译/verifyLayers 层存在)", () => {
    const m = loadManifest();
    assert.equal(m.schema, "selfheal-deploy-surfaces");
    assert.equal(m.version, 1);
    assert.equal(typeof m.version, "number");
    assert.ok(m.surfaces && typeof m.surfaces === "object", "surfaces 必须是对象");
    assert.ok(Array.isArray(m.rules), "rules 必须是数组");
    assert.ok(Array.isArray(m.manual), "manual 必须是数组");

    // surfaces:键 ⊆ 已知集合,值结构完整,verifyLayers 引用仓根真实脚本。
    const rootScripts: Record<string, string> =
      JSON.parse(readFileSync(ROOT_PKG_PATH, "utf8")).scripts ?? {};
    for (const [name, s] of Object.entries(m.surfaces)) {
      assert.ok(KNOWN_SURFACES.has(name), `未知 surface 名:${name}`);
      assert.equal(typeof s.label, "string");
      assert.ok(s.label.length > 0, `${name}.label 空`);
      assert.equal(typeof s.deployAction, "string");
      assert.ok(s.deployAction.length > 0, `${name}.deployAction 空`);
      assert.ok(Array.isArray(s.verifyLayers), `${name}.verifyLayers 非数组`);
      for (const layer of s.verifyLayers) {
        assert.equal(typeof layer, "string");
        assert.ok(
          Object.prototype.hasOwnProperty.call(rootScripts, layer),
          `${name}.verifyLayers 引用不存在的仓根脚本:${layer}`,
        );
      }
      assert.ok(
        s.requiresAxis === null || KNOWN_AXES.has(s.requiresAxis),
        `${name}.requiresAxis 非法:${String(s.requiresAxis)}`,
      );
      assert.equal(typeof s.note, "string");
    }
    // 五个面必须齐全(生成器按固定顺序渲染)。
    for (const name of SURFACE_ORDER) {
      assert.ok(m.surfaces[name], `manifest 缺 surface:${name}`);
    }

    // rules:glob 可编译、surface 合法、note 存在。
    for (const r of m.rules) {
      assert.equal(typeof r.glob, "string");
      assert.ok(r.glob.length > 0, "rule.glob 空");
      assert.doesNotThrow(() => globToRegExp(r.glob), `rule glob 编译失败:${r.glob}`);
      assert.ok(KNOWN_SURFACES.has(r.surface), `rule.surface 未知:${r.surface}`);
      assert.ok(m.surfaces[r.surface], `rule.surface 未在 surfaces 定义:${r.surface}`);
      assert.equal(typeof r.note, "string");
      assert.ok(r.note.length > 0, `rule ${r.glob} 缺 note`);
    }
    // manual:glob 可编译、note 存在。
    for (const mm of m.manual) {
      assert.equal(typeof mm.glob, "string");
      assert.ok(mm.glob.length > 0, "manual.glob 空");
      assert.doesNotThrow(() => globToRegExp(mm.glob), `manual glob 编译失败:${mm.glob}`);
      assert.equal(typeof mm.note, "string");
      assert.ok(mm.note.length > 0, `manual ${mm.glob} 缺 note`);
    }
  });

  test("② playbook §4.1 锚点内容 === 由 manifest 生成", () => {
    const m = loadManifest();
    const generated = generateSurfacesTable(m);
    const playbook = readFileSync(PLAYBOOK_PATH, "utf8");
    const anchored = extractAnchoredBlock(playbook);
    assert.equal(
      anchored,
      generated,
      "playbook §4.1 锚定段与 manifest 生成结果漂移 —— 勿手改 playbook,改 manifest 后重生成锚定段",
    );
  });

  test("③ manual 清单覆盖 RFC §3 每一类(逐项代表路径命中某条 manual glob)", () => {
    const m = loadManifest();
    const manualRes = m.manual.map((mm) => globToRegExp(mm.glob));
    const isManual = (p: string) => manualRes.some((re) => re.test(p));

    // RFC §3 manual-only 逐类 → 代表路径(本仓真实布局)。
    const categories: Record<string, string> = {
      "DB migrations": "packages/commercial/src/db/migrations/0161_selfheal_release_requests.sql",
      "env overrides": "deploy/v5/commercial-v5.env.overrides",
      "scripts/**": "scripts/deploy-v5.sh",
      "deploy/**": "deploy/v5/release-metadata.json",
      ".github/**": ".github/workflows/ci.yml",
      "任意 *.sh": "packages/commercial/agent-sandbox/build-image.sh",
      "package.json(嵌套层级)": "packages/gateway/package.json",
      "package.json(仓根)": "package.json",
      "package-lock.json": "package-lock.json",
      "bun lockfile": "bun.lock",
      "pnpm lockfile": "pnpm-lock.yaml",
      "yarn lockfile": "yarn.lock",
      "*.lockb 通配(非 bun 名亦命中,验 **/*.lockb 生效)": "packages/x/foo.lockb",
      "Cargo.lock(嵌套 crate)": "crates/x/Cargo.lock",
      "Dockerfile / 镜像工具链": "packages/commercial/agent-sandbox/Dockerfile.openclaude-runtime",
      "sudoers 类": "packages/commercial/agent-sandbox/sudoers",
      "agent-sandbox/ccb-baseline/**": "packages/commercial/agent-sandbox/ccb-baseline/AGENTS.md",
      "自愈 TCB(selfheal 目录)": "packages/commercial/src/selfheal/policy.ts",
      "自愈 TCB(selfhealRepairs.ts)": "packages/commercial/src/http/internal/selfhealRepairs.ts",
      "自愈审批链 TCB(selfhealOps)": "packages/commercial/src/admin/selfhealOps.ts",
      "自愈审批链 TCB(http/admin/selfheal)": "packages/commercial/src/http/admin/selfheal.ts",
      "自愈审批链 TCB(admin audit glob)": "packages/commercial/src/admin/auditActions.ts",
      "分类器 manifest 自身": "deploy/v5/selfheal-deploy-surfaces.json",
      "AGENTS.md": "AGENTS.md",
      "CLAUDE.md": "CLAUDE.md",
      "changelog.json": "changelog.json",
    };
    for (const [cat, path] of Object.entries(categories)) {
      assert.ok(isManual(path), `RFC §3 manual 类 [${cat}] 代表路径未被任何 manual glob 命中:${path}`);
    }
  });

  test("glob 语义自检(**​/ 匹配零段;* 不跨 /)", () => {
    assert.ok(globToRegExp("**/package.json").test("package.json"), "**/ 应匹配根文件");
    assert.ok(globToRegExp("**/package.json").test("packages/gateway/package.json"));
    assert.ok(!globToRegExp("packages/commercial/**").test("packages/commercialX/foo.ts"), "* 不应越界匹配相邻目录名");
    assert.ok(globToRegExp("packages/commercial/**").test("packages/commercial/src/egress/x.ts"));
    assert.ok(globToRegExp("**/*.sh").test("scripts/a/b.sh"));
    assert.ok(!globToRegExp("**/*.sh").test("scripts/a.sh.bak"));
  });
});
