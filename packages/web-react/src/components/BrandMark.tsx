/**
 * 品牌标识「从」字方块 —— 落地页、登录页共用的单一权威。
 * 品牌色走 @theme 的 --color-brand(#c7ff64)/--color-brand-fg,固定不随主题变
 * (它是 logo 而非语义色),深浅背景下均成立;发光 shadow 由调用方按场景开关。
 */
export function BrandMark({
  className = 'size-9',
  glow = false,
  fontSize = 'text-[19px]',
  rounded = 'rounded-[11px]',
  flat = false,
}: {
  className?: string
  glow?: boolean
  fontSize?: string
  /** 小尺寸（侧栏 28px）按比例收圆角，避免 11px 圆角在小方块上糊成圆形。 */
  rounded?: string
  /** 不带投影（工作区内的小尺寸品牌位，大投影会显脏）。 */
  flat?: boolean
}) {
  return (
    <span
      aria-hidden
      className={`${className} grid shrink-0 place-items-center ${rounded} bg-brand ${fontSize} font-black leading-none text-brand-fg${
        glow ? ' shadow-brand-glow' : flat ? '' : ' shadow-float'
      }`}
    >
      从
    </span>
  )
}
