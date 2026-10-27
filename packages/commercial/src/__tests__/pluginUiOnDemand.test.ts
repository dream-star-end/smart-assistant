/**
 * OCV5-393 规则守卫：插件专属的 Intelligent UI 组件定义不进默认上下文，只在加载该插件时读。
 *
 * 守的是「以后所有插件都要遵守」的那条规则，所以按登记表 + 基线目录逐项检查，不写死插件名：
 *   1. 默认上下文（每轮都带的 INTELLIGENT_UI / 输入预测段、基线 AGENTS.md / CLAUDE.md、技能 frontmatter 描述）
 *      里不出现任何插件组件类型；
 *   2. 前端认识的每个组件类型，要么在通用协议里，要么在登记表里恰好属于一个插件；
 *   3. 模型写的插件组件：定义在 <skill>/references/ui-*.md，逐个类型都有定义；SKILL.md 正文只留指向它的指引，
 *      不内联任何插件组件的定义；定义文件小（按需读取的成本有上限）；
 *   4. CLI 产出的插件组件：插件清单 components.ui 用 emit: "cli" 声明同一组类型；
 *   5. 基线里任何 plugin.json 的 components.ui 都必须在登记表里（新插件不能绕过登记表）。
 *
 * 跑法:npx tsx --test src/__tests__/pluginUiOnDemand.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PLUGIN_UI_COMPONENTS, type PluginUiComponentSet, parsePluginManifest, pluginUiOwner, pluginUiTypes } from "@openclaude/protocol";
import { SELFHOST_PLUGIN_SLUGS } from "../plugins/catalogPolicy.js";
import { INPUT_PREDICTION_PROMPT, INTELLIGENT_UI_PROMPT } from "../intelligentUi/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE = resolve(here, "../../agent-sandbox/ccb-baseline");
const SKILLS = join(BASELINE, "skills");
const SCHEMA = resolve(here, "../../../web-react/src/components/iui/schema.ts");
const CORE_UI_PROTOCOL = readFileSync(resolve(here, "../../agent-sandbox/platform-runtime/prompts/system-assistant/references/ui.md"), "utf8");

/**
 * 一个类型在文本里「被定义」：JSON 写法 "type":"x" 或定义行 `- x:` / `- x：`。
 * 带下划线的插件类型名（weibo_hot …）不会是普通单词，出现即算；quote / kline 这类同时是 ths 子命令名，只认定义写法。
 */
function mentions(text: string, type: string): boolean {
  if (new RegExp(`"type"\\s*:\\s*"${type}"|^\\s*- ${type}\\s*[:：]`, "m").test(text)) return true;
  return type.includes("_") && new RegExp(`(^|[^a-z0-9_])${type}([^a-z0-9_]|$)`, "m").test(text);
}

function frontendTypes(): string[] {
  const schema = readFileSync(SCHEMA, "utf8");
  const block = /export const IUI_TYPES[^=]*=\s*\[([\s\S]*?)\]/.exec(schema)?.[1] ?? "";
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

function frontmatter(md: string): string {
  return /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? "";
}

const modelSets = PLUGIN_UI_COMPONENTS.filter((s) => s.author === "model");
const cliSets = PLUGIN_UI_COMPONENTS.filter((s) => s.author === "cli");
const activeAppPlugins: ReadonlySet<string> = new Set(SELFHOST_PLUGIN_SLUGS);

describe("登记表本身", () => {
  test("插件名、类型都不重复；至少覆盖同花顺、微博、知乎、飞书", () => {
    const plugins = PLUGIN_UI_COMPONENTS.map((s) => s.plugin);
    assert.equal(new Set(plugins).size, plugins.length);
    const types = pluginUiTypes();
    assert.equal(new Set(types).size, types.length);
    for (const p of ["ths", "weibo", "zhihu", "feishu"]) assert.ok(plugins.includes(p), p);
    assert.equal(pluginUiOwner("weibo_hot")?.plugin, "weibo");
    assert.equal(pluginUiOwner("table"), null);
  });
});

describe("1. 默认上下文里没有插件组件", () => {
  test("每轮都带的 INTELLIGENT_UI 段与输入预测段不提任何插件组件类型", () => {
    for (const t of pluginUiTypes()) {
      assert.ok(!mentions(INTELLIGENT_UI_PROMPT, t), `INTELLIGENT_UI_PROMPT mentions plugin type ${t}`);
      assert.ok(!mentions(INPUT_PREDICTION_PROMPT, t), `INPUT_PREDICTION_PROMPT mentions plugin type ${t}`);
    }
  });

  test("基线 AGENTS.md / CLAUDE.md 与所有技能的 frontmatter（技能列表里的描述）都不提插件组件类型", () => {
    const always = ["AGENTS.md", "AGENTS.admin.md", "CLAUDE.md", "CLAUDE.admin.md"]
      .map((f) => join(BASELINE, f))
      .filter((f) => existsSync(f))
      .map((f) => [f, readFileSync(f, "utf8")] as const);
    for (const name of readdirSync(SKILLS)) {
      const skill = join(SKILLS, name, "SKILL.md");
      if (existsSync(skill)) always.push([`${skill} (frontmatter)`, frontmatter(readFileSync(skill, "utf8"))]);
    }
    assert.ok(always.length > 10);
    for (const [file, text] of always) {
      for (const t of pluginUiTypes()) assert.ok(!mentions(text, t), `${file} mentions plugin type ${t}`);
    }
  });
});

describe("2. 前端类型的归属", () => {
  test("前端每个类型要么在通用协议里，要么恰好属于一个插件（sources 只做旧消息兼容）", () => {
    const all = frontendTypes();
    assert.ok(all.length >= 30, `parsed types: ${all.join(",")}`);
    const frontendOnly = new Set(["sources"]);
    for (const t of all) {
      if (frontendOnly.has(t)) continue;
      const owners = PLUGIN_UI_COMPONENTS.filter((s) => s.types.includes(t)).length;
      const core = new RegExp(`"type":"${t}"`).test(CORE_UI_PROTOCOL);
      assert.ok(core !== (owners === 1), `${t}: core=${core} pluginOwners=${owners} — must be exactly one of the two`);
    }
    for (const t of pluginUiTypes()) assert.ok(all.includes(t), `registered plugin type ${t} is unknown to the frontend`);
  });
});

describe("3. 模型写的插件组件：定义按需读取", () => {
  for (const set of modelSets) {
    test(`${set.plugin}：定义文件在 references/ui-*.md，逐个类型都有定义，且体积受控`, () => {
      assert.match(set.doc, /^references\/ui-[a-z0-9-]+\.md$/);
      const docPath = join(SKILLS, set.skill, set.doc);
      assert.ok(existsSync(docPath), `${docPath} missing`);
      const doc = readFileSync(docPath, "utf8");
      for (const t of set.types) assert.match(doc, new RegExp(`^- ${t}：`, "m"), `${set.doc} has no definition line for ${t}`);
      for (const other of pluginUiTypes().filter((t) => !set.types.includes(t)))
        assert.ok(!mentions(doc, other), `${set.doc} mentions another plugin's type ${other}`);
      assert.ok(Buffer.byteLength(doc, "utf8") < 2_500, `${set.doc} is ${Buffer.byteLength(doc, "utf8")} bytes`);
      assert.match(doc, /没有该协议时不要写这些块/);
    });

    test(`${set.plugin}：技能只指向在售应用的定义，且不内联任何插件组件定义`, () => {
      const skill = readFileSync(join(SKILLS, set.skill, "SKILL.md"), "utf8");
      // The renderer/registry retains old-message types. The five-app skill must not rediscover retired apps.
      const retiredApp = set.skill === "app-connectors" && !activeAppPlugins.has(set.plugin);
      assert.equal(skill.includes(`\`${set.doc}\``), !retiredApp,
        `${set.skill}/SKILL.md ${retiredApp ? "must not advertise retired" : "must point at"} ${set.doc}`);
      for (const t of pluginUiTypes()) assert.ok(!mentions(skill, t), `${set.skill}/SKILL.md inlines plugin type ${t}`);
    });
  }
});

describe("4. CLI 产出的插件组件", () => {
  for (const set of cliSets) {
    test(`${set.plugin}：plugin.json 的 components.ui 用 emit: "cli" 声明同一组类型`, () => {
      const raw = JSON.parse(readFileSync(join(SKILLS, set.skill, "plugin.json"), "utf8"));
      const r = parsePluginManifest(raw);
      assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.errors));
      if (!r.ok) return;
      const cli = r.manifest.components.ui.filter((u) => "emit" in u);
      assert.deepEqual(cli.flatMap((u) => u.types).sort(), [...set.types].sort());
      assert.equal(set.doc, "SKILL.md");
    });
  }
});

describe("5. 基线插件清单里的组件都已登记", () => {
  test("任何 plugin.json 的 components.ui 都对应登记表里同名插件的同一组类型", () => {
    let seen = 0;
    for (const name of readdirSync(SKILLS)) {
      const manifest = join(SKILLS, name, "plugin.json");
      if (!existsSync(manifest)) continue;
      const r = parsePluginManifest(JSON.parse(readFileSync(manifest, "utf8")));
      assert.ok(r.ok, `${name}: ${r.ok ? "" : JSON.stringify(r.errors)}`);
      if (!r.ok) continue;
      for (const u of r.manifest.components.ui) {
        seen++;
        const set: PluginUiComponentSet | undefined = PLUGIN_UI_COMPONENTS.find((s) => s.plugin === r.manifest.name);
        assert.ok(set, `${name}: components.ui present but plugin is not in PLUGIN_UI_COMPONENTS`);
        for (const t of u.types) assert.ok(set!.types.includes(t), `${name}: ${t} not registered`);
        if ("path" in u) {
          assert.equal(set!.author, "model");
          assert.equal(u.path, set!.doc);
          assert.ok(existsSync(join(SKILLS, name, u.path)), `${name}: ${u.path} missing`);
        }
      }
    }
    assert.ok(seen >= 1);
  });
});

describe("清单校验器：components.ui", () => {
  const base = {
    schema: "openclaude-plugin/1",
    name: "demo-plugin",
    version: "1.0.0",
    displayName: "示例插件",
    description: "一个用来测试 components.ui 校验的示例插件",
    author: { name: "t" },
    tags: ["示例"],
    useCases: ["看一下示例数据"],
    auth: { mode: "none" },
    permissions: { network: [], writes: [], userInteraction: [] },
  };
  const parse = (ui: unknown) =>
    parsePluginManifest({ ...base, components: { skills: [{ path: "SKILL.md" }], ui } });

  test("path 只能是 references/ui-*.md（不能是 SKILL.md）；path 与 emit 二选一；类型名合法且不重复", () => {
    const ok = parse([{ types: ["demo_card"], path: "references/ui-demo.md" }]);
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.ok(parse([{ types: ["demo_card"], emit: "cli" }]).ok);
    const bad = [
      [{ types: ["demo_card"], path: "SKILL.md" }],
      [{ types: ["demo_card"], path: "references/demo.md" }],
      [{ types: ["demo_card"], path: "references/ui-demo.md", emit: "cli" }],
      [{ types: ["demo_card"] }],
      [{ types: ["Demo-Card"], emit: "cli" }],
      [{ types: [], emit: "cli" }],
      [{ types: ["demo_card"], emit: "server" }],
      [{ types: ["demo_card"], emit: "cli" }, { types: ["demo_card"], path: "references/ui-demo.md" }],
    ];
    for (const ui of bad) assert.equal(parse(ui).ok, false, JSON.stringify(ui));
  });
});
