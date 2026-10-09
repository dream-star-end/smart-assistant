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
  INTELLIGENT_UI_PROMPT,
  INTELLIGENT_UI_SLOT_NAME,
  intelligentUiFeatureView,
  intelligentUiPrefEnabled,
  isIntelligentUiServerEnabled,
  resolveIntelligentUiSlot,
} from "../intelligentUi/index.js";

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

describe("resolveIntelligentUiSlot", () => {
  const prefs = (p: { intelligent_ui?: boolean }) => async () => ({ prefs: p });

  test("总开关开 + 偏好未设 → 下发协议", async () => {
    const slot = await resolveIntelligentUiSlot(3, { env: {}, readPrefs: prefs({}) });
    assert.deepEqual(slot, { name: INTELLIGENT_UI_SLOT_NAME, content: INTELLIGENT_UI_PROMPT });
  });
  test("偏好关 → null", async () => {
    assert.equal(await resolveIntelligentUiSlot(3, { env: {}, readPrefs: prefs({ intelligent_ui: false }) }), null);
  });
  test("总开关关 → null,且不读偏好", async () => {
    let read = false;
    const slot = await resolveIntelligentUiSlot(3, {
      env: { OC_INTELLIGENT_UI: "off" },
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

describe("协议文案", () => {
  test("覆盖前端支持的全部组件类型,且只写前端认识的类型", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const schema = readFileSync(resolve(here, "../../../web-react/src/components/iui/schema.ts"), "utf8");
    const block = /export const IUI_TYPES[^=]*=\s*\[([\s\S]*?)\]/.exec(schema)?.[1] ?? "";
    const types = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    assert.ok(types.length >= 10, `parsed types: ${types.join(",")}`);
    for (const t of types) assert.match(INTELLIGENT_UI_PROMPT, new RegExp(`"type":"${t}"`), t);
    const advertised = [...INTELLIGENT_UI_PROMPT.matchAll(/"type":"([a-z_]+)"/g)].map((m) => m[1]!);
    for (const t of advertised) assert.ok(types.includes(t), `prompt advertises unknown type ${t}`);
  });

  test("示例块本身是合法 JSON:分段里放计算器(带曲线与占比)", () => {
    const m = /```ui\n(.+)\n```/.exec(INTELLIGENT_UI_PROMPT);
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
    const line = /icon 可选:([^\n。]+)/.exec(INTELLIGENT_UI_PROMPT)?.[1] ?? "";
    const advertised = line.trim().split(/\s+/);
    assert.ok(advertised.length >= 40);
    for (const name of advertised) assert.ok(known.has(name), `prompt advertises unknown icon ${name}`);
  });

  test("测验类走 quiz 组件:组件能做的事不改用 htmlpreview,且声明优先于平台的 htmlpreview 段落", () => {
    assert.match(INTELLIGENT_UI_PROMPT, /测验、知识问答[^\n]*一律用 ui 组件[^\n]*不要为它们另做 htmlpreview/);
    assert.match(INTELLIGENT_UI_PROMPT, /以本段为准/);
    assert.match(INTELLIGENT_UI_PROMPT, /- quiz:[^\n]*出题考考大家/);
    assert.doesNotMatch(INTELLIGENT_UI_PROMPT, /小工具或小游戏用/);
  });
  test("体积受控(系统提示每轮都带;第二轮组件补齐后上限 9KB)", () => {
    assert.ok(Buffer.byteLength(INTELLIGENT_UI_PROMPT, "utf8") < 9_000, String(Buffer.byteLength(INTELLIGENT_UI_PROMPT, "utf8")));
  });
});
