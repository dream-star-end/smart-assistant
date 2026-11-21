import type { JSX } from "react";
import { cn } from "../../lib/utils";

export type AtelierIconName =
  | "swarm"
  | "tasks"
  | "sites"
  | "blog"
  | "workbench"
  | "skills"
  | "newChat"
  | "sparkles";

/**
 * 现代双色调几何 SVG 数据规格（24×24 光学网格，零硬编码色，全部走 currentColor + fillOpacity）：
 * - o:  双色调描边路径 [d, fillOpacity?]
 * - f:  无描边柔光/实心填充路径 [d, fillOpacity?]
 * - s:  前景线框路径
 * - so: 次级柔线路径（strokeOpacity 0.55）
 * - r:  圆角矩形 [x, y, w, h, rx, fillOpacity?, rotateDeg?]
 * - e:  椭圆 [cx, cy, rx, ry, rotateDeg?, fillOpacity?]
 * - c:  圆点/圆环 [cx, cy, r, mode?]（0/省略=实心点, 1=柔光底圆, 2=双色调描边圆0.22, 3=双色调描边圆0.14）
 */
export type IconSpec = {
  o?: ReadonlyArray<readonly [string, number?]>;
  f?: ReadonlyArray<readonly [string, number?]>;
  s?: string;
  so?: string;
  r?: ReadonlyArray<readonly [number, number, number, number, number, number?, number?]>;
  e?: ReadonlyArray<readonly [number, number, number, number, number?, number?]>;
  c?: ReadonlyArray<readonly [number, number, number, number?]>;
};

const ATELIER_SPECS: Record<AtelierIconName, IconSpec> = {
  swarm: {
    so: "M12 7.5 7.4 14.6M12 7.5l4.6 7.1M8.2 16h7.6",
    c: [[12, 12, 7.2, 1], [12, 12.2, 2.1, 2], [12, 5.5, 2, 2], [6.2, 16, 2, 2], [17.8, 16, 2, 2]],
  },
  tasks: {
    r: [[4, 4, 16, 16, 4.5, 0.14]],
    s: "M8.2 10.2l1.6 1.6 3-3.2M8.2 15.4h7.6M14.4 10.2h1.6",
  },
  sites: {
    c: [[12, 12, 8.2, 3]],
    e: [[12, 12, 3.8, 8.2]],
    s: "M4.2 9.5h15.6M4.2 14.5h15.6",
  },
  blog: {
    o: [
      ["M4.2 6.2a2.5 2.5 0 0 1 2.5-2.5h3.8c1 0 1.5.7 1.5 1.7v14.8c0-1-.7-1.7-1.7-1.7H6.7a2.5 2.5 0 0 1-2.5-2.5Z", 0.16],
      ["M19.8 6.2a2.5 2.5 0 0 0-2.5-2.5h-3.8c-1 0-1.5.7-1.5 1.7v14.8c0-1 .7-1.7 1.7-1.7h3.6a2.5 2.5 0 0 0 2.5-2.5Z", 0.08],
    ],
    s: "M15 8.5h2.2M15 12h2.2",
  },
  workbench: {
    r: [[3.5, 4.2, 17, 15.6, 3.4, 0.13]],
    s: "M9.5 4.2v15.6M9.5 11.2h11",
    c: [[6.5, 8, 0.9], [6.5, 11.2, 0.9]],
  },
  skills: {
    o: [["M12 3.5l7.4 4.3v8.4L12 20.5l-7.4-4.3V7.8Z", 0.14]],
    s: "M12 12l7.4-4.2M12 12v8.5M12 12 4.6 7.8",
    c: [[12, 12, 1.4]],
  },
  newChat: {
    o: [
      ["M13.5 4.2H7.2a3.2 3.2 0 0 0-3.2 3.2v9.4a3.2 3.2 0 0 0 3.2 3.2h9.4a3.2 3.2 0 0 0 3.2-3.2v-6.3", 0.13],
      ["M17.5 3.8l2.7 2.7-7.4 7.4-3.3.6.6-3.3Z", 0.2],
    ],
  },
  sparkles: {
    o: [["M10.5 3.6c.6 3.7 2.4 5.5 6.1 6.1-3.7.6-5.5 2.4-6.1 6.1-.6-3.7-2.4-5.5-6.1-6.1 3.7-.6 5.5-2.4 6.1-6.1Z", 0.2]],
    f: [["M17.6 14.4c.3 1.7 1.1 2.5 2.8 2.8-1.7.3-2.5 1.1-2.8 2.8-.3-1.7-1.1-2.5-2.8-2.8 1.7-.3 2.5-1.1 2.8-2.8Z", 1]],
  },
};

export function RenderIconSpec({
  spec,
  size = 16,
  className,
}: {
  spec: IconSpec;
  size?: number;
  className?: string;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("shrink-0", className)}
    >
      {spec.c?.map(([cx, cy, r, mode], i) =>
        mode === 1 ? (
          <circle key={`h${i}`} cx={cx} cy={cy} r={r} fill="currentColor" fillOpacity="0.14" stroke="none" />
        ) : null,
      )}
      {spec.e?.map(([cx, cy, rx, ry, rot, fo], i) => (
        <ellipse
          key={`e${i}`}
          cx={cx}
          cy={cy}
          rx={rx}
          ry={ry}
          transform={rot ? `rotate(${rot} ${cx} ${cy})` : undefined}
          fill={fo ? "currentColor" : undefined}
          fillOpacity={fo}
        />
      ))}
      {spec.r?.map(([x, y, w, h, rx, fo, rot], i) => (
        <rect
          key={`r${i}`}
          x={x}
          y={y}
          width={w}
          height={h}
          rx={rx}
          transform={rot ? `rotate(${rot} 12 12)` : undefined}
          fill={fo ? "currentColor" : undefined}
          fillOpacity={fo}
        />
      ))}
      {spec.o?.map(([d, fo], i) => (
        <path key={`o${i}`} d={d} fill="currentColor" fillOpacity={fo ?? 0.15} />
      ))}
      {spec.f?.map(([d, fo], i) => (
        <path key={`f${i}`} d={d} fill="currentColor" fillOpacity={fo ?? 0.14} stroke="none" />
      ))}
      {spec.so && <path d={spec.so} strokeOpacity="0.55" />}
      {spec.s && <path d={spec.s} />}
      {spec.c?.map(([cx, cy, r, mode], i) =>
        mode === 1 ? null : mode === 2 || mode === 3 ? (
          <circle key={`c${i}`} cx={cx} cy={cy} r={r} fill="currentColor" fillOpacity={mode === 2 ? 0.22 : 0.14} />
        ) : (
          <circle key={`c${i}`} cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
        ),
      )}
    </svg>
  );
}

export function AtelierIcon({
  name,
  size = 16,
  className,
}: {
  name: AtelierIconName;
  size?: number;
  className?: string;
}): JSX.Element {
  return <RenderIconSpec spec={ATELIER_SPECS[name]} size={size} className={className} />;
}
