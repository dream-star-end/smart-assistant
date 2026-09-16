/**
 * 教程中心「品牌深蓝」hero 的模块级 token（tutorials 审计 TU-34）。
 *
 * 此前 TutorialCenter / CaseShowroom / SignatureShowcases / CaseFieldReportVisual 各自写死
 * `#07111f / #080e19 / #101624 / #152442 / #102b29` 十余处：一来绕开设计系统、二来暗色主题下
 * 与 `--bg:#0c0c11` 几乎同色，hero 卡失去边界。设计系统里没有等价的品牌深蓝，改 `bg-fg` 会让 hero
 * 亮色下成纯黑、暗色下反转成浅底，与图稿 / 作品封面的深色调冲突（tutorials.md §4 TU-34），所以这里
 * 把它收成 CSS 变量：值只在本文件出现，浅色保留品牌深蓝，暗色抬亮一档并给 1px 描边让卡片从页面
 * 底色里分出来。日后 shell 若愿意收编，把 `--hero-bg / --hero-fg / --hero-line` 搬进 `styles.css`
 * 的 `@theme`、下面的 `[--hero-*:…]` 删掉即可，消费方一行不用改。
 *
 * 用法：容器加 `HERO_SURFACE_CLASS`（变量 + 底色 + 前景 + 描边）；只想拿变量自己上色（渐变遮罩、
 * 带透明度的角标）就用 `HERO_THEME_VARS` 再写 `bg-(--hero-bg)/90`、`from-(--hero-bg)`。
 * 前景层次仍用 `text-(--hero-fg)/70` 之类的透明度分层。
 */

/** 品牌深蓝：只声明变量，不上色。 */
export const HERO_THEME_VARS =
  "[--hero-bg:#07111f] [--hero-fg:#ffffff] [--hero-line:rgb(255_255_255/0.10)] " +
  "dark:[--hero-bg:#141d33] dark:[--hero-line:rgb(255_255_255/0.18)]";

/** 精选作品「薄荷」变体（数据看板类结果封面）：同一套变量名，只换值。 */
export const HERO_MINT_THEME_VARS =
  "[--hero-bg:#102b29] [--hero-fg:#ffffff] [--hero-line:rgb(255_255_255/0.12)] " +
  "dark:[--hero-bg:#17403c] dark:[--hero-line:rgb(255_255_255/0.2)]";

/** 精选作品「海军蓝」变体（市场简报类结果封面）。 */
export const HERO_NAVY_THEME_VARS =
  "[--hero-bg:#152442] [--hero-fg:#ffffff] [--hero-line:rgb(255_255_255/0.12)] " +
  "dark:[--hero-bg:#1d3160] dark:[--hero-line:rgb(255_255_255/0.2)]";

/** 把变量上到表面：底色 + 前景 + 1px 描边。 */
const HERO_SURFACE = "bg-(--hero-bg) text-(--hero-fg) border border-(--hero-line)";

export const HERO_SURFACE_CLASS = `${HERO_THEME_VARS} ${HERO_SURFACE}`;
export const HERO_MINT_SURFACE_CLASS = `${HERO_MINT_THEME_VARS} ${HERO_SURFACE}`;
export const HERO_NAVY_SURFACE_CLASS = `${HERO_NAVY_THEME_VARS} ${HERO_SURFACE}`;

/** 供用例断言：hero 表面不该再出现写死的十六进制底色 / 渐变色。 */
export const HARDCODED_HERO_HEX = /(?:bg|from|via|to)-\[#[0-9a-f]{3,8}\]/i;
