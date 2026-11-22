/**
 * 设计 token 的可访问性契约(单一权威 = src/styles.css)。
 *
 * 为什么存在(2026-07-26 UI/UX 改造批):浅色主题曾系统性不达 WCAG AA ——
 * `--faint` 3.37:1 却承载全站说明与引导文案、`--warning` 2.83:1 连大字标准都不够、
 * `--ring` 是 35% 半透明合成后仅 ≈1.6:1(键盘用户看不见焦点)。这类缺陷靠人眼
 * review 抓不住,也没有任何测试拦得住,改回去只需要一次"顺手调个色"。
 *
 * 本测试直接解析 styles.css 文本(不依赖浏览器/jsdom 的 CSS 计算),把每个
 * token 的实际用途对应到 WCAG 阈值上:
 *   - 文字类前景 ≥ 4.5:1(AA 正文)——注意要同时对 surface 和自身 -soft 徽章底成立,
 *     因为 `bg-*-soft text-*` 是仓内徽章的标准组合;
 *   - 非文字类(焦点环 / 控件边界)≥ 3:1(AA 非文本对比)。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 定位 styles.css。不能用 `new URL(..., import.meta.url)` —— jsdom 环境下
 * import.meta.url 不是 file: scheme,fileURLToPath 会抛 ERR_INVALID_URL_SCHEME。
 * 从 cwd 逐级上溯,兼容"从包内跑"与"从仓库根跑 workspace 测试"两种启动方式。
 */
function locateStylesheet(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    for (const candidate of [
      resolve(dir, "src/styles.css"),
      resolve(dir, "packages/web-react/src/styles.css"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    dir = resolve(dir, "..");
  }
  throw new Error(`找不到 styles.css(cwd=${process.cwd()})`);
}

const STYLESHEET = locateStylesheet();
const LANDING_STYLESHEET = resolve(dirname(STYLESHEET), "styles/landing.css");
const CSS = readFileSync(STYLESHEET, "utf8");
const THEME_CSS = existsSync(LANDING_STYLESHEET)
  ? `${CSS}\n${readFileSync(LANDING_STYLESHEET, "utf8")}`
  : CSS;

/**
 * 取某个主题块({ ... })内的 token 表。light = `:root`,dark = `.dark`,landing = `.congjian-landing`。
 * 颜色值收 `#rrggbb[aa]` 与 `rgba(r, g, b, a)` 两种写法(营销主题的 -soft / border 用 rgba);
 * 渐变(--aurora / --grad-cta)不是单色,不入表。`--color-*` 是 Tailwind 编译后的双写,跳过,
 * 只看底层 token。
 */
function tokensOf(selector: string): Record<string, string> {
  const start = THEME_CSS.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`主题样式表缺少 ${selector} 块`);
  const body = THEME_CSS.slice(start, THEME_CSS.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6,8}|rgba?\([^)]*\));/g)) {
    if (m[1].startsWith("color-")) continue;
    out[m[1]] = m[2];
  }
  // 同一块里用 var() 指向本块另一个颜色 token 的别名(如 .dark 的 --shine-base: var(--faint))
  // 也是「定义了」,取被指向 token 的值;指向本块没有的 token 仍算缺失。
  for (const m of body.matchAll(/--([\w-]+):\s*var\(--([\w-]+)\);/g)) {
    if (m[1].startsWith("color-") || out[m[1]] !== undefined) continue;
    if (out[m[2]] !== undefined) out[m[1]] = out[m[2]];
  }
  return out;
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

type Rgb = [number, number, number];

/** `#rrggbb` / `#rrggbbaa` / `rgba(r, g, b, a)`;返回 rgb 与 alpha(缺省 1)。 */
function parseHex(color: string): { rgb: Rgb; alpha: number } {
  if (color === undefined) throw new Error("token 缺失(undefined)—— 见「四套主题 token 键集合一致」用例");
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color.trim());
  if (fn) {
    return {
      rgb: [Number(fn[1]), Number(fn[2]), Number(fn[3])],
      alpha: fn[4] === undefined ? 1 : Number(fn[4]),
    };
  }
  const h = color.replace("#", "");
  const rgb: Rgb = [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
  const alpha = h.length >= 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { rgb, alpha };
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrast(fg: Rgb, bg: Rgb): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** 半透明前景合成到不透明底上(徽章 -soft 底的真实呈现)。 */
function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((c, i) => c * alpha + bg[i] * (1 - alpha)) as Rgb;
}

/**
 * 仓内共四套完整 token:`:root` / `.dark` / `.congjian-landing`(营销主题)/ `.preview-shell`。
 * 前三套纳入守卫(shell 审计 S-05:原先只守前两套,营销主题的 --faint 4.38:1 与漏定义的
 * --danger 都没人拦)。`.preview-shell` 用 `--preview-*` 前缀且 surface 是半透明 rgba,
 * 需要先定义"合成到哪个底上"才有意义,本批先不纳入,记为遗留。
 */
const THEMES = [
  { name: "light", selector: ":root" },
  { name: "dark", selector: ".dark" },
  { name: "landing", selector: ".congjian-landing" },
] as const;

/** 承载文字的语义色。徽章标准组合是 `bg-<t>-soft text-<t>`,两个底都要过。 */
const TEXT_TONES = ["muted", "faint", "accent", "danger", "success", "warning", "info"] as const;
/** 有 -soft 徽章底的语义色(faint/muted 只做纯文字,无 soft 变体)。 */
const BADGE_TONES = ["accent", "danger", "success", "warning", "info"] as const;
/** 填充用法:`bg-<t> text-<t>-fg`(Button primary / accent / danger)。 */
const FILL_PAIRS = [
  ["primary", "primary-fg"],
  ["accent", "accent-fg"],
  ["danger", "danger-fg"],
  ["success", "success-fg"],
  ["warning", "warning-fg"],
] as const;

describe("四套主题 token 键集合一致(漏写一个 token 就会回落到别的主题)", () => {
  const base = Object.keys(tokensOf(":root")).sort();
  it.each(THEMES.filter((th) => th.selector !== ":root"))("$name 不缺 :root 里的任何颜色 token", ({ selector }) => {
    const keys = new Set(Object.keys(tokensOf(selector)));
    const missing = base.filter((k) => !keys.has(k));
    expect(missing).toEqual([]);
  });
});

describe.each(THEMES)("设计 token 对比度契约 · $name", ({ selector }) => {
  const t = tokensOf(selector);
  const surface = parseHex(t.surface).rgb;
  const bg = parseHex(t.bg).rgb;
  const elevated = parseHex(t.elevated).rgb;

  it.each(FILL_PAIRS)("--%s 作填充底、--%s 作其前景 ≥ 4.5:1(Button 填充变体)", (fill, fg) => {
    expect(contrast(parseHex(t[fg]).rgb, parseHex(t[fill]).rgb)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(TEXT_TONES)("--%s 作正文前景 ≥ 4.5:1(vs surface 与 bg)", (tone) => {
    const { rgb } = parseHex(t[tone]);
    expect(contrast(rgb, surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb, bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb, elevated)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(BADGE_TONES)("--%s 在自身 -soft 徽章底上 ≥ 4.5:1", (tone) => {
    const fg = parseHex(t[tone]).rgb;
    const soft = parseHex(t[`${tone}-soft`]);
    const sidebar = parseHex(t.sidebar).rgb;
    const hover = parseHex(t.hover);
    const hoverSurface = composite(hover.rgb, hover.alpha, surface);
    // -soft 是同色低 alpha,徽章渲染在 surface / sidebar / hover 叠底上都必须达 WCAG AA。
    expect(contrast(fg, composite(soft.rgb, soft.alpha, surface))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(fg, composite(soft.rgb, soft.alpha, sidebar))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(fg, composite(soft.rgb, soft.alpha, hoverSurface))).toBeGreaterThanOrEqual(4.5);
  });

  it("--ring 是实色且 ≥ 3:1(半透明焦点环等于没有焦点环)", () => {
    const { rgb, alpha } = parseHex(t.ring);
    expect(alpha).toBe(1);
    expect(contrast(rgb, surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(rgb, bg)).toBeGreaterThanOrEqual(3);
  });

  it("--border-control ≥ 3:1(输入框边界必须看得见,与作分隔线的 --border 分开取色)", () => {
    const { rgb } = parseHex(t["border-control"]);
    expect(contrast(rgb, surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(rgb, bg)).toBeGreaterThanOrEqual(3);
  });

  it("--skeleton 与 surface 可辨(骨架屏不能是隐形的)", () => {
    // 骨架不是文本,不适用 AA;要的是"一眼看出这里有东西在加载"。
    // 原实现复用 --hover(浅色 4% 墨)合成后仅 1.05:1,等于白屏。
    expect(contrast(parseHex(t.skeleton).rgb, surface)).toBeGreaterThanOrEqual(1.2);
  });
});

describe("双主题空间景深投影契约（OCV5-817）", () => {
  it("@theme 投影引用语义变量，且 .dark 提供暗部投影与顶部高光描边", () => {
    const themeBlock = CSS.slice(CSS.indexOf("@theme {"), CSS.indexOf("\n}", CSS.indexOf("@theme {")));
    expect(themeBlock).toMatch(/--shadow-soft:\s*var\(--shadow-soft-val\);/);
    expect(themeBlock).toMatch(/--shadow-pop:\s*var\(--shadow-pop-val\);/);
    expect(themeBlock).toMatch(/--shadow-float:\s*var\(--shadow-float-val\);/);

    const darkBlock = CSS.slice(CSS.indexOf(".dark {"), CSS.indexOf("\n}", CSS.indexOf(".dark {")));
    expect(darkBlock).toMatch(/--shadow-soft-val:[^;]*inset 0 1px 0 rgba\(255,\s*255,\s*255,/);
    expect(darkBlock).toMatch(/--shadow-pop-val:[^;]*inset 0 1px 0 rgba\(255,\s*255,\s*255,/);
    expect(darkBlock).toMatch(/--shadow-float-val:[^;]*inset 0 1px 0 rgba\(255,\s*255,\s*255,/);
  });
});

describe("排版 scale 契约", () => {
  it("@theme 定义了语义字号档位", () => {
    for (const name of ["title", "section", "body", "meta", "caption", "micro"]) {
      expect(CSS).toMatch(new RegExp(`--text-${name}:\\s*[\\d.]+px;`));
    }
  });

  it("不得重定义 Tailwind 原厂 text-base/text-sm(会击穿 Input 的 iOS 防缩放)", () => {
    // ui/Input.tsx 用 `text-base md:text-sm` 防 iOS Safari 在 <16px 时放大整页且不回弹。
    // 一旦在 @theme 里把 --text-base 改小,全站输入框的这条防线同时失效。
    expect(CSS).not.toMatch(/--text-base:/);
    expect(CSS).not.toMatch(/--text-sm:/);
    expect(CSS).not.toMatch(/--text-xs:/);
    expect(CSS).not.toMatch(/--text-lg:/);
  });
});

describe("状态语义别名(UI-SPEC §4.3,lib/ui/statusTone.ts)", () => {
  const ALIASES = {
    "status-running": "accent",
    "status-attention": "warning",
    "status-done": "success",
    "status-failed": "danger",
    "status-idle": "faint",
  } as const;

  it.each(THEMES)("$name 的 --status-* 指向本主题自己的语义色", ({ selector }) => {
    const t = tokensOf(selector);
    for (const [alias, base] of Object.entries(ALIASES)) {
      expect(t[alias], `--${alias}`).toBeDefined();
      expect(t[alias], `--${alias}`).toBe(t[base]);
    }
  });

  it("工具类经 @theme inline 引用别名(在使用处求值,局部换肤容器取自己的值)", () => {
    const inline = /@theme inline \{([^}]*)\}/.exec(CSS)?.[1] ?? "";
    for (const alias of Object.keys(ALIASES)) {
      expect(inline).toMatch(new RegExp(`--color-${alias}:\\s*var\\(--${alias}\\);`));
    }
  });
});

describe("中文字体栈(UI-SPEC §4.1)", () => {
  it("覆盖鸿蒙 / 小米 / 安卓 / Linux 的系统黑体,Inter 仍排第一;苹果、Windows 先命中原有字体", () => {
    const stack = /--font-sans:([^;]+);/.exec(CSS)?.[1].trim() ?? "";
    expect(stack.startsWith('"Inter Variable"')).toBe(true);
    const order = [
      "PingFang SC",
      "Microsoft YaHei",
      "HarmonyOS Sans SC",
      "MiSans",
      "Noto Sans SC",
      "Source Han Sans SC",
    ].map((f) => stack.indexOf(`"${f}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

function formatGateError(ruleId: string, target: string, violation: string, why: string, howToFix: string): string {
  return [
    `[GATE-ERROR] ${ruleId} at ${target}`,
    `  Violation : ${violation}`,
    `  Why       : ${why}`,
    `  How to Fix: ${howToFix}`,
    "  Re-verify : npx vitest run packages/web-react/src/test/designTokens.test.ts",
  ].join("\n");
}

function zIndexTokensOfRoot(): Record<string, number> {
  const start = CSS.indexOf(":root {");
  if (start === -1) throw new Error("styles.css 缺少 :root 块");
  const body = CSS.slice(start, CSS.indexOf("\n}", start));
  const out: Record<string, number> = {};
  for (const m of body.matchAll(/--(z-[\w-]+):\s*(-?\d+);/g)) {
    out[m[1]] = Number.parseInt(m[2], 10);
  }
  return out;
}

describe("集中 11 档 --z-* 语义层级阶梯契约（OCV5-847）", () => {
  const EXPECTED_Z_LADDER = [
    ["z-base", 0],
    ["z-sticky", 10],
    ["z-sidebar", 20],
    ["z-header", 30],
    ["z-popover-inline", 40],
    ["z-drawer", 50],
    ["z-modal", 60],
    ["z-viewer", 70],
    ["z-popover-portal", 80],
    ["z-tooltip", 90],
    ["z-toast", 100],
  ] as const;

  const zTokens = zIndexTokensOfRoot();

  it(":root 定义全部 11 档 --z-* 层级 Token 且严格单调递增", () => {
    const missing = EXPECTED_Z_LADDER.filter(([key]) => zTokens[key] === undefined).map(([key]) => `--${key}`);
    expect(
      missing,
      formatGateError(
        "UI-ZINDEX-TOKENS",
        "packages/web-react/src/styles.css",
        `缺失层级 Token: ${missing.join(", ")}`,
        "全站层叠顺序以 styles.css :root 的 11 档 --z-* 为单一权威，杜绝裸 z-[60..999] 竞价",
        "在 packages/web-react/src/styles.css 的 :root 块中补齐全部 11 档 --z-* 声明",
      ),
    ).toEqual([]);

    for (const [key, expectedVal] of EXPECTED_Z_LADDER) {
      expect(
        zTokens[key],
        formatGateError(
          "UI-ZINDEX-TOKENS",
          "packages/web-react/src/styles.css",
          `--${key} 当前值 ${zTokens[key]} 与契约档位 ${expectedVal} 不一致`,
          "11 档 --z-* 阶梯间距为 10，便于清晰分层且避免跨组件层叠冲突",
          `将 styles.css :root 中的 --${key} 设为 ${expectedVal}`,
        ),
      ).toBe(expectedVal);
    }

    for (let i = 0; i < EXPECTED_Z_LADDER.length - 1; i += 1) {
      const [loKey] = EXPECTED_Z_LADDER[i];
      const [hiKey] = EXPECTED_Z_LADDER[i + 1];
      expect(
        zTokens[loKey],
        formatGateError(
          "UI-ZINDEX-ORDER",
          "packages/web-react/src/styles.css",
          `--${loKey}(${zTokens[loKey]}) 未严格小于 --${hiKey}(${zTokens[hiKey]})`,
          "11 档 --z-* 必须严格单调递增，确保高阶浮层不被低阶容器遮挡",
          `调整 :root 中 --${loKey} < --${hiKey}`,
        ),
      ).toBeLessThan(zTokens[hiKey]);
    }
  });

  it("Radix Portal 浮层严格高于查看器/弹窗/抽屉/页内浮层（popover-portal > viewer > modal > drawer > popover-inline）", () => {
    const chain = ["z-popover-inline", "z-drawer", "z-modal", "z-viewer", "z-popover-portal"] as const;
    for (let i = 0; i < chain.length - 1; i += 1) {
      const lower = chain[i];
      const higher = chain[i + 1];
      expect(
        zTokens[higher],
        formatGateError(
          "UI-ZINDEX-PORTAL-PRECEDENCE",
          "packages/web-react/src/styles.css",
          `--${higher}(${zTokens[higher]}) 必须严格大于 --${lower}(${zTokens[lower]})`,
          "全屏图片查看器/弹窗/抽屉内打开的 Radix Portal 下拉菜单不可被父浮层遮挡",
          "保持 --z-popover-portal > --z-viewer > --z-modal > --z-drawer > --z-popover-inline",
        ),
      ).toBeGreaterThan(zTokens[lower]);
    }
  });
});

/**
 * 防回潮计数门(UI-SPEC §4.1 / §4.4):按目录数「绕过 token 的写法」,**只准降不准升**。
 *
 * 豁免表拆入 A 类受保护文件 packages/web-react/design-tokens-exempt.json（CODEOWNERS 锁定）；
 * 计数基线拆入 B 类棘轮文件 packages/web-react/design-tokens-counts.json（允许清债递减，CI --base 阻断抬升）。
 */
const WEB_REACT_PKG_DIR = resolve(dirname(STYLESHEET), "..");
const DRIFT_EXEMPT_PATH = resolve(WEB_REACT_PKG_DIR, "design-tokens-exempt.json");
const DRIFT_COUNTS_PATH = resolve(WEB_REACT_PKG_DIR, "design-tokens-counts.json");

type ExemptFileShape = {
  patterns: Array<string | { regex: string; reason?: string }>;
};

function loadDriftExempt(): RegExp[] {
  const raw = JSON.parse(readFileSync(DRIFT_EXEMPT_PATH, "utf8")) as ExemptFileShape;
  if (!raw || !Array.isArray(raw.patterns)) {
    throw new Error(
      formatGateError(
        "UI-TOKEN-EXEMPT-SCHEMA",
        "packages/web-react/design-tokens-exempt.json",
        "缺少 patterns 数组",
        "豁免表属于 A 类受保护门禁配置",
        "恢复 design-tokens-exempt.json 的 { patterns: [{ regex, reason }] } 结构",
      ),
    );
  }
  return raw.patterns.map((entry) => new RegExp(typeof entry === "string" ? entry : entry.regex));
}

const DRIFT_EXEMPT = loadDriftExempt();
const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const count = (code: string, re: RegExp) => code.match(re)?.length ?? 0;

const DRIFT_METRICS = {
  pxText: (code: string) => count(code, /\btext-\[\d+(?:\.\d+)?px\]/g),
  rawColor: (code: string) =>
    count(code, /(?<![\w&#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g) +
    count(code, /\brgba?\(/g),
  paletteColor: (code: string) =>
    count(
      code,
      new RegExp(
        `\\b(?:bg|text|border|ring|from|via|to|fill|stroke|outline|divide|decoration|shadow|caret|placeholder)-(?:${PALETTE})-\\d{2,3}\\b`,
        "g",
      ),
    ),
  radius: (code: string) =>
    count(code, /\brounded(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?-\[[^\]\s]+\]/g),
  adhocDot: (code: string, file: string) => {
    if (file === "components/ui/StatusPill.tsx") return 0;
    const statusBg = new RegExp(
      `(?:^|\\s)bg-(?:accent|success|warning|danger|info|faint|muted|status-[a-z]+|(?:${PALETTE})-\\d{2,3})(?=[\\s/]|$)`,
    );
    let n = 0;
    for (const m of code.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
      const s = m[2];
      if (
        /\brounded-full\b/.test(s) &&
        /(?:^|\s)(?:size|h|w)-(?:1|1\.5|2|2\.5|\[\d+(?:\.\d+)?px\])(?=\s|$)/.test(s) &&
        statusBg.test(s)
      )
        n += 1;
    }
    return n;
  },
  adhocError: (code: string) =>
    count(code, /(?:^|[\s"'`])(?:bg-danger-soft|bg-danger\/\d+|border-danger(?:\/\d+)?)(?=[\s"'`]|$)/gm),
} satisfies Record<string, (code: string, file: string) => number>;

type DriftMetric = keyof typeof DRIFT_METRICS;

const DRIFT_REMEDIATION: Record<DriftMetric, string> = {
  pxText: "用语义字号类 text-title / text-section / text-body / text-meta / text-caption 替代 text-[Npx]（或运行 scripts/codemod-text-size-tokens.mjs）；严禁覆写 text-base",
  rawColor: "改用 styles.css 语义 Token（bg-surface / bg-bg / text-fg / text-muted / var(--accent) / color-mix(...)），严禁新增硬编码 #hex 或 rgba()",
  paletteColor: "改用语义颜色类（text-muted / bg-surface / border-border / text-danger 等）替代 Tailwind 原始调色板类",
  radius: "改用设计系统圆角档位 rounded-xs / rounded-sm / rounded-md / rounded-lg / rounded-xl / rounded-full 替代 rounded-[Npx]",
  adhocDot: "复用 components/ui/StatusPill.tsx 状态指示原语，勿手写 rounded-full 状态圆点",
  adhocError: "复用 components/ui/Notice 或 Alert 原语呈现错误提示，勿手拼 bg-danger-soft / border-danger",
};

function loadDriftBaseline(): Record<DriftMetric, Record<string, number>> {
  const parsed = JSON.parse(readFileSync(DRIFT_COUNTS_PATH, "utf8")) as Record<string, Record<string, number>>;
  for (const metric of Object.keys(DRIFT_METRICS) as DriftMetric[]) {
    if (!parsed || typeof parsed[metric] !== "object" || parsed[metric] === null) {
      throw new Error(
        formatGateError(
          "UI-TOKEN-COUNTS-SCHEMA",
          "packages/web-react/design-tokens-counts.json",
          `缺少指标 ${metric} 的目录计数表`,
          "B 类计数棘轮必须完整覆盖全部 6 项指标且仅允许清债递减",
          `检查 packages/web-react/design-tokens-counts.json 的 ${metric} 键`,
        ),
      );
    }
  }
  return parsed as Record<DriftMetric, Record<string, number>>;
}

const DRIFT_BASELINE = loadDriftBaseline();

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");
}

/** 目录粒度:components 下按子目录,components 根下的文件归「components/*」,其余按顶层目录。 */
function bucketOf(rel: string): string {
  const parts = rel.split("/");
  if (parts[0] === "components") return parts.length >= 3 ? `components/${parts[1]}` : "components/*";
  return parts.length >= 2 ? parts[0] : "(root)";
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

function countDrift(): Record<DriftMetric, Record<string, number>> {
  const src = dirname(STYLESHEET);
  const metrics = Object.keys(DRIFT_METRICS) as DriftMetric[];
  const out = Object.fromEntries(metrics.map((k) => [k, {}])) as Record<DriftMetric, Record<string, number>>;
  for (const abs of walk(src)) {
    const rel = relative(src, abs).split(sep).join("/");
    if (DRIFT_EXEMPT.some((re) => re.test(rel))) continue;
    const code = stripComments(readFileSync(abs, "utf8"));
    const bucket = bucketOf(rel);
    for (const k of metrics) {
      const n = DRIFT_METRICS[k](code, rel);
      if (n) out[k][bucket] = (out[k][bucket] ?? 0) + n;
    }
  }
  return out;
}

describe("防回潮计数门(只准降不准升)", () => {
  const now = countDrift();
  it.each(Object.keys(DRIFT_METRICS) as DriftMetric[])("%s:各目录不超过基线", (metric) => {
    const over = Object.entries(now[metric])
      .filter(([bucket, n]) => n > (DRIFT_BASELINE[metric][bucket] ?? 0))
      .map(([bucket, n]) => `${bucket}: ${n} > 基线 ${DRIFT_BASELINE[metric][bucket] ?? 0}`);
    // 超了 = 新代码又绕过了 token / 原语:改用语义 token、StatusPill、Notice,不要调高基线。
    // 现值整表打在失败信息里,清掉一批之后照它把 design-tokens-counts.json 改小。
    expect(
      over,
      formatGateError(
        `UI-TOKEN-DRIFT-${metric.toUpperCase()}`,
        "packages/web-react/design-tokens-counts.json",
        `${over.join("; ")} (现值 ${metric} = ${JSON.stringify(now[metric])})`,
        "设计 Token 防回潮棘轮只降不升，禁止新代码绕过 Clarvy Atelier 语义原语",
        `${DRIFT_REMEDIATION[metric]}；切勿调高 design-tokens-counts.json`,
      ),
    ).toEqual([]);
  });
});
