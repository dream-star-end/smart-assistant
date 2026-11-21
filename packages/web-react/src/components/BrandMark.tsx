/**
 * 品牌标识「从」字方块 —— 落地页、登录页共用的单一权威。
 * 品牌色走 @theme 的 --color-brand(#c7ff64)/--color-brand-fg,固定不随主题变
 * (它是 logo 而非语义色),深浅背景下均成立;发光 shadow 由调用方按场景开关。
 */
export function BrandMark({
  className = 'size-9',
  glow = false,
  fontSize = 'text-lg',
  rounded = 'rounded-md',
  flat = false,
}: {
  className?: string
  glow?: boolean
  fontSize?: string
  /** 小尺寸（侧栏 26px）按比例收圆角，避免大圆角在小方块上糊成圆形。 */
  rounded?: string
  /** 不带外投影（工作区内的小尺寸品牌位，大投影会显脏；仍保留内高光雕塑感）。 */
  flat?: boolean
}) {
  return (
    <span
      aria-hidden
      className={`${className} oc-shimmer-sheen relative grid shrink-0 select-none place-items-center overflow-hidden ${rounded} bg-brand ${fontSize} font-black leading-none tracking-tight text-brand-fg ring-1 ring-inset ring-black/15 transition-transform duration-200 ease-spring before:pointer-events-none before:absolute before:inset-0 before:bg-gradient-to-b before:from-white/40 before:via-white/5 before:to-black/10${
        glow ? ' shadow-brand-glow' : flat ? ' shadow-xs' : ' shadow-float'
      }`}
    >
      <span className="relative z-[1] drop-shadow-xs">从</span>
    </span>
  )
}
