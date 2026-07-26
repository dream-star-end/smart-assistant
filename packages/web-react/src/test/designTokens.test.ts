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
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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

const CSS = readFileSync(locateStylesheet(), "utf8");

/** 取某个主题块({ ... })内的 token 表。light = `:root`,dark = `.dark`。 */
function tokensOf(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`styles.css 缺少 ${selector} 块`);
  const body = CSS.slice(start, CSS.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6,8});/g)) out[m[1]] = m[2];
  return out;
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

type Rgb = [number, number, number];

/** `#rrggbb` 或 `#rrggbbaa`;返回 rgb 与 alpha(缺省 1)。 */
function parseHex(hex: string): { rgb: Rgb; alpha: number } {
  const h = hex.replace("#", "");
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

const THEMES = [
  { name: "light", selector: ":root" },
  { name: "dark", selector: ".dark" },
] as const;

/** 承载文字的语义色。徽章标准组合是 `bg-<t>-soft text-<t>`,两个底都要过。 */
const TEXT_TONES = ["muted", "faint", "accent", "danger", "success", "warning", "info"] as const;
/** 有 -soft 徽章底的语义色(faint/muted 只做纯文字,无 soft 变体)。 */
const BADGE_TONES = ["accent", "danger", "success", "warning", "info"] as const;

describe.each(THEMES)("设计 token 对比度契约 · $name", ({ selector }) => {
  const t = tokensOf(selector);
  const surface = parseHex(t.surface).rgb;
  const bg = parseHex(t.bg).rgb;

  it.each(TEXT_TONES)("--%s 作正文前景 ≥ 4.5:1(vs surface 与 bg)", (tone) => {
    const { rgb } = parseHex(t[tone]);
    expect(contrast(rgb, surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(BADGE_TONES)("--%s 在自身 -soft 徽章底上 ≥ 4.5:1", (tone) => {
    const fg = parseHex(t[tone]).rgb;
    const soft = parseHex(t[`${tone}-soft`]);
    // -soft 是同色低 alpha,徽章渲染在 surface/elevated 上。
    expect(contrast(fg, composite(soft.rgb, soft.alpha, surface))).toBeGreaterThanOrEqual(4.5);
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
