/**
 * 品牌标识「从」字方块 —— 落地页、登录页共用的单一权威。
 * 品牌色 #c7ff64 固定不随主题变(它是 logo 而非语义色),
 * 深浅背景下均成立;发光 shadow 由调用方按场景开关。
 */
export function BrandMark({
  className = 'size-9',
  glow = false,
  fontSize = 'text-[19px]',
}: {
  className?: string
  glow?: boolean
  fontSize?: string
}) {
  return (
    <span
      aria-hidden
      className={`${className} grid shrink-0 place-items-center rounded-[11px] bg-[#c7ff64] ${fontSize} font-black leading-none text-[#0a0b09]${
        glow ? ' shadow-[0_0_30px_rgba(199,255,100,0.16)]' : ' shadow-float'
      }`}
    >
      从
    </span>
  )
}
