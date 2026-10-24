/**
 * Intelligent UI(OCV5-361,个人版)master 侧:总开关、偏好默认值、slot 解析、协议文案与前端一致。
 *
 * 跑法:npx tsx --test src/__tests__/intelligentUi.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildIntelligentUiPrompt,
  INPUT_PREDICTION_PROMPT,
  INTELLIGENT_UI_PROMPT,
  INTELLIGENT_UI_SLOT_NAME,
  inputPredictionFeatureView,
  inputPredictionPrefEnabled,
  intelligentUiFeatureView,
  intelligentUiPrefEnabled,
  isInputPredictionServerEnabled,
  isIntelligentUiServerEnabled,
  resolveIntelligentUiSlot,
} from "../intelligentUi/index.js";
import { pluginUiTypes } from "@openclaude/protocol";

describe("总开关 OC_INTELLIGENT_UI", () => {
  test("缺省与常见真值 → 启用", () => {
    for (const v of [undefined, "", "1", "on", "true", "yes"]) {
      assert.equal(isIntelligentUiServerEnabled({ OC_INTELLIGENT_UI: v }), true, String(v));
    }
  });
  test("0 / off / false → 禁用(大小写、空白不敏感)", () => {
    for (const v of ["0", "off", "OFF", " false ", "no", "disabled"]) {
      assert.equal(isIntelligentUiServerEnabled({ OC_INTELLIGENT_UI: v }), false, v);
    }
  });
});

describe("用户偏好", () => {
  test("缺省视为开,只有显式 false 才关", () => {
    assert.equal(intelligentUiPrefEnabled(undefined), true);
    assert.equal(intelligentUiPrefEnabled({}), true);
    assert.equal(intelligentUiPrefEnabled({ intelligent_ui: true }), true);
    assert.equal(intelligentUiPrefEnabled({ intelligent_ui: false }), false);
  });
  test("features 视图:总开关关时 enabled 也为 false", () => {
    assert.deepEqual(intelligentUiFeatureView({}, {}), { available: true, enabled: true });
    assert.deepEqual(intelligentUiFeatureView({ intelligent_ui: false }, {}), { available: true, enabled: false });
    assert.deepEqual(intelligentUiFeatureView({}, { OC_INTELLIGENT_UI: "0" }), { available: false, enabled: false });
  });
});

describe("输入预测开关(OCV5-375)", () => {
  test("总开关 OC_INPUT_PREDICTION:缺省开,0 / off 关", () => {
    assert.equal(isInputPredictionServerEnabled({}), true);
    assert.equal(isInputPredictionServerEnabled({ OC_INPUT_PREDICTION: " OFF " }), false);
  });
  test("偏好缺省开;features 视图跟总开关", () => {
    assert.equal(inputPredictionPrefEnabled(undefined), true);
    assert.equal(inputPredictionPrefEnabled({ input_prediction: false }), false);
    assert.deepEqual(inputPredictionFeatureView({}, {}), { available: true, enabled: true });
    assert.deepEqual(inputPredictionFeatureView({}, { OC_INPUT_PREDICTION: "0" }), { available: false, enabled: false });
  });
});

describe("resolveIntelligentUiSlot", () => {
  const prefs = (p: { intelligent_ui?: boolean; input_prediction?: boolean }) => async () => ({ prefs: p });
  const both = `${INTELLIGENT_UI_PROMPT}\n\n${INPUT_PREDICTION_PROMPT}`;

  test("总开关开 + 偏好未设 → 组件协议 + 输入预测", async () => {
    const slot = await resolveIntelligentUiSlot(3, { env: {}, readPrefs: prefs({}) });
    assert.deepEqual(slot, { name: INTELLIGENT_UI_SLOT_NAME, content: both });
  });
  test("各自的偏好或总开关只去掉自己那段", async () => {
    const onlyPredict = { name: INTELLIGENT_UI_SLOT_NAME, content: INPUT_PREDICTION_PROMPT };
    const onlyIui = { name: INTELLIGENT_UI_SLOT_NAME, content: INTELLIGENT_UI_PROMPT };
    assert.deepEqual(await resolveIntelligentUiSlot(3, { env: {}, readPrefs: prefs({ intelligent_ui: false }) }), onlyPredict);
    assert.deepEqual(await resolveIntelligentUiSlot(3, { env: { OC_INTELLIGENT_UI: "0" }, readPrefs: prefs({}) }), onlyPredict);
    assert.deepEqual(await resolveIntelligentUiSlot(3, { env: {}, readPrefs: prefs({ input_prediction: false }) }), onlyIui);
    assert.deepEqual(await resolveIntelligentUiSlot(3, { env: { OC_INPUT_PREDICTION: "off" }, readPrefs: prefs({}) }), onlyIui);
  });
  test("两个偏好都关 → null", async () => {
    assert.equal(
      await resolveIntelligentUiSlot(3, { env: {}, readPrefs: prefs({ intelligent_ui: false, input_prediction: false }) }),
      null,
    );
  });
  test("两个总开关都关 → null,且不读偏好", async () => {
    let read = false;
    const slot = await resolveIntelligentUiSlot(3, {
      env: { OC_INTELLIGENT_UI: "off", OC_INPUT_PREDICTION: "off" },
      readPrefs: async () => {
        read = true;
        return { prefs: {} };
      },
    });
    assert.equal(slot, null);
    assert.equal(read, false);
  });
  test("uid 以字符串传给偏好读取", async () => {
    let got: string | undefined;
    await resolveIntelligentUiSlot(42, {
      env: {},
      readPrefs: async (uid) => {
        got = uid;
        return { prefs: {} };
      },
    });
    assert.equal(got, "42");
  });
});

const guideRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../agent-sandbox/platform-runtime/prompts/system-assistant/references");
const CORE_UI_PROTOCOL = readFileSync(resolve(guideRoot, "ui.md"), "utf8");
const PREDICTION_PROTOCOL = readFileSync(resolve(guideRoot, "input-prediction.md"), "utf8");

describe("协议文案", () => {
  test("覆盖前端支持的全部组件类型,且只写前端认识的类型", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const schema = readFileSync(resolve(here, "../../../web-react/src/components/iui/schema.ts"), "utf8");
    const block = /export const IUI_TYPES[^=]*=\s*\[([\s\S]*?)\]/.exec(schema)?.[1] ?? "";
    const all = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    // OCV5-383 / OCV5-393: plugin-only components (同花顺 market blocks printed by its CLI; 微博 / 知乎 / 飞书
    // blocks defined in each plugin's references/ui-*.md) reach the model only with the plugin, never via
    // this every-turn prompt. The registry says which types those are (pluginUiOnDemand.test.ts guards it).
    const cliOnly = new Set(pluginUiTypes());
    assert.ok(cliOnly.size >= 10, `registered plugin types: ${[...cliOnly].join(",")}`);
    for (const t of ["quote", "kline", "intraday", "stocklist"]) assert.ok(cliOnly.has(t), t);
    const types = all.filter((t) => !cliOnly.has(t));
    assert.ok(types.length >= 10, `parsed types: ${types.join(",")}`);
    // sources 只在前端兼容旧消息和同花顺插件输出,不对模型宣传(OCV5-389)。
    const frontendOnly = new Set(["sources"]);
    for (const t of types) {
      if (frontendOnly.has(t)) continue;
      assert.match(CORE_UI_PROTOCOL, new RegExp(`"type":"${t}"`), t);
    }
    for (const t of [...cliOnly, ...frontendOnly]) assert.doesNotMatch(CORE_UI_PROTOCOL, new RegExp(`"type":"${t}"`), t);
    const advertised = [...CORE_UI_PROTOCOL.matchAll(/"type":"([a-z_]+)"/g)].map((m) => m[1]!);
    for (const t of advertised) assert.ok(types.includes(t), `prompt advertises unknown type ${t}`);
  });

  test("示例块本身是合法 JSON:分段里放计算器(带曲线与占比)", () => {
    const m = /```ui\n(.+)\n```/.exec(CORE_UI_PROTOCOL);
    assert.ok(m);
    const v = JSON.parse(m![1]!) as { type: string; tabs: { block: { type: string; chart?: unknown; breakdown?: unknown } }[] };
    assert.equal(v.type, "tabs");
    assert.equal(v.tabs[0]!.block.type, "calculator");
    assert.ok(v.tabs[0]!.block.chart && v.tabs[0]!.block.breakdown);
  });

  test("提示词里列的图标名前端都认识", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, "../../../web-react/src/components/iui/icons.ts"), "utf8");
    const icons = /const ICON_SOURCES = \{([\s\S]*?)\} as const/.exec(source)?.[1] ?? "";
    const known = new Set([...icons.matchAll(/^\s*"?([a-z-]+)"?:/gm)].map((x) => x[1]!));
    assert.ok(known.size >= 40, `parsed icons: ${known.size}`);
    const line = /icon 可选:([^\n。]+)/.exec(CORE_UI_PROTOCOL)?.[1] ?? "";
    const advertised = line.trim().split(/\s+/);
    assert.ok(advertised.length >= 40);
    for (const name of advertised) assert.ok(known.has(name), `prompt advertises unknown icon ${name}`);
  });

  test("测验类走 quiz 组件:组件能做的事不改用 htmlpreview(平台 htmlpreview 段落同样这样写,OCV5-382)", () => {
    assert.match(CORE_UI_PROTOCOL, /测验、知识问答[^\n]*一律用 ui 组件[^\n]*不要为它们另做 htmlpreview/);
    assert.doesNotMatch(CORE_UI_PROTOCOL, /以本段为准/);
    assert.match(CORE_UI_PROTOCOL, /- quiz:[^\n]*出题考考大家/);
    assert.doesNotMatch(CORE_UI_PROTOCOL, /小工具或小游戏用/);
  });
  test("第三轮:来源只用真实链接、成稿与大纲的用法写明、表格说明筛选与下载", () => {
    assert.match(CORE_UI_PROTOCOL, /普通 Markdown 写参考来源[^\n]*不要用 ui 组件[^\n]*本轮工具真实返回或用户给出[^\n]*绝不编造链接/);
    assert.match(CORE_UI_PROTOCOL, /- draft:[^\n]*original[^\n]*修改对比/);
    assert.match(CORE_UI_PROTOCOL, /层级结构\(大纲、思维导图、组织架构\)用 outline/);
    assert.match(CORE_UI_PROTOCOL, /- table:[^\n]*可下载 CSV,行多时可筛选/);
  });
  test("文字里的引号写成「」或“”(canary 里 deepseek 把英文双引号直接写进 JSON 字符串)", () => {
    assert.match(CORE_UI_PROTOCOL, /合法 JSON 对象\([^)\n]*引号用「」或“”,不要用英文双引号\)/);
  });

  test("常驻只有加载入口，完整协议按需提供且索引不内联schema", () => {
    assert.match(INTELLIGENT_UI_PROMPT, /oc-system skill ui/);
    assert.match(INPUT_PREDICTION_PROMPT, /oc-system skill input-prediction/);
    for (const index of [INTELLIGENT_UI_PROMPT, INPUT_PREDICTION_PROMPT]) {
      assert.doesNotMatch(index, /"type"\s*:|```ui|\"columns\"|\"formula\"/);
    }
    assert.ok(Buffer.byteLength(INTELLIGENT_UI_PROMPT) < Buffer.byteLength(CORE_UI_PROTOCOL));
  });

  test("输入预测:示例块是合法 JSON、类型 next、要求放在最后;完整正文按需加载", () => {
    const m = /```ui\n(\{[^\n]*\})\n```/.exec(PREDICTION_PROTOCOL);
    assert.ok(m);
    assert.equal((JSON.parse(m[1]!) as { type: string }).type, "next");
    assert.match(PREDICTION_PROTOCOL, /最后一个块/);
    assert.match(PREDICTION_PROTOCOL, /不是你的建议/);
    assert.ok(PREDICTION_PROTOCOL.trim().length > 0);
  });
});


describe("taskboard component-only projection", () => {
  test("uses the same uid preference and never includes input prediction", async () => {
    const seen: string[] = [];
    for (const input_prediction of [true, false]) {
      const result = await resolveIntelligentUiSlot(765, { surface: "taskboard", env: {}, readPrefs: async (uid) => {
        seen.push(uid); return { prefs: { intelligent_ui: true, input_prediction } };
      } });
      assert.deepEqual(result, { name: INTELLIGENT_UI_SLOT_NAME, content: INTELLIGENT_UI_PROMPT });
    }
    assert.deepEqual(seen, ["765", "765"]);
    assert.equal(await resolveIntelligentUiSlot(765, { surface: "taskboard", env: {}, readPrefs: async () => ({ prefs: { intelligent_ui: false, input_prediction: true } }) }), null);
    assert.equal(await resolveIntelligentUiSlot(765, { surface: "taskboard", env: { OC_INTELLIGENT_UI: "0", OC_INPUT_PREDICTION: "1" }, readPrefs: async () => { throw new Error("must not read when component surface is off"); } }), null);
  });
  test("preserves the exact existing webchat text and separators", () => {
    assert.equal(buildIntelligentUiPrompt({ componentsEnabled: true, predictionEnabled: true }), `${INTELLIGENT_UI_PROMPT}\n\n${INPUT_PREDICTION_PROMPT}`);
    assert.equal(buildIntelligentUiPrompt({ componentsEnabled: true, predictionEnabled: true, surface: "taskboard" }), INTELLIGENT_UI_PROMPT);
    assert.equal(buildIntelligentUiPrompt({ componentsEnabled: false, predictionEnabled: true, surface: "taskboard" }), null);
  });
});
