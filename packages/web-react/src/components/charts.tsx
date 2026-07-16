import type { ChartConfiguration } from "chart.js";
import { type DependencyList, type ReactNode, type RefObject, useEffect } from "react";
import { Card, PanelHeader } from "./ui";

/**
 * 图表栈（全站唯一封装，管理后台与用户端设置/计费共用）—— 与用户端 RichBlocks.ChartBlock 同款：
 *  - 动态 `import('chart.js/auto')`（首屏零 chart.js，出现图表页才下载该 chunk）；
 *  - 颜色**全部**从 CSS token 读（getComputedStyle），不手抄 hex 副本 → token 改版不漂移；
 *  - 主题切换（<html>.dark class 变化）经 MutationObserver 重渲染，已画的图不留旧配色；
 *  - 卸载 / deps 变化 destroy，无 canvas 泄漏。
 *
 * 分类色板顺序：accent → info → success → warning → danger → muted。
 */

export type ChartTheme = {
  /** 读任意 CSS 变量（不带 -- 前缀），trim 后返回；空则回退灰。 */
  color: (name: string) => string;
  /** 分类色板（accent→info→success→warning→danger→muted）。 */
  palette: string[];
  /** 细网格线颜色（border token 低透明）。 */
  grid: string;
  /** 轴文字 / 图例文字（muted）。 */
  text: string;
  /** 边框 token（tooltip 描边）。 */
  border: string;
  /** 抬升表面（tooltip 底色）。 */
  elevated: string;
  /** 前景文字（tooltip 标题/正文）。 */
  fg: string;
  isDark: boolean;
};

const PALETTE_TOKENS = ["accent", "info", "success", "warning", "danger", "muted"] as const;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

function readChartTheme(): ChartTheme {
  const color = (name: string) => cssVar(name) || "#8b8b97";
  const isDark = document.documentElement.classList.contains("dark");
  return {
    color,
    palette: PALETTE_TOKENS.map(color),
    grid: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
    text: color("muted"),
    border: color("border"),
    elevated: color("elevated"),
    fg: color("fg"),
    isDark,
  };
}

/**
 * 字符串大数 → chart.js 绘图数值（**仅供绘图几何，非计费权威**；非法/非有限按 0）。
 * 计费口径展示始终走 formatCredits/formatCompactCount（全程字符串，绝不 Number 化）；
 * 唯有喂给 chart.js 的 dataset 才在此收口做一次数值化。
 */
export function chartNum(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** hex(#rgb/#rrggbb/#rrggbbaa) → rgba(…,alpha)。非 hex 原样返回。 */
export function withAlpha(hex: string, alpha: number): string {
  let h = hex.trim();
  if (!h.startsWith("#")) return h;
  h = h.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 8) h = h.slice(0, 6); // 丢弃已有 alpha，用参数 alpha
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 把 canvas ref 接上一张 chart.js 图。configBuilder 收到当前主题 token，返回完整 config；
 * deps 变化重建。**主题切换自动重渲染**（无需把主题放进 deps）。
 *
 * 用法：
 *   const ref = useRef<HTMLCanvasElement>(null);
 *   useChart(ref, (theme) => lineConfig(theme, { labels, series }), [data]);
 *   // JSX: <ChartCard title="…"><canvas ref={ref} /></ChartCard>
 */
export function useChart(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  configBuilder: (theme: ChartTheme) => ChartConfiguration,
  deps: DependencyList,
): void {
  useEffect(() => {
    let alive = true;
    // biome-ignore lint/suspicious/noExplicitAny: chart.js 实例类型经 dynamic import 拿不到静态类型
    let chart: any = null;
    let mo: MutationObserver | null = null;

    const render = async () => {
      const mod = await import("chart.js/auto");
      const Chart = mod.default;
      if (!alive || !canvasRef.current) return;
      if (chart) {
        try {
          chart.destroy();
        } catch {
          /* ignore */
        }
        chart = null;
      }
      const config = configBuilder(readChartTheme());
      // biome-ignore lint/suspicious/noExplicitAny: 动态 config
      chart = new Chart(canvasRef.current, config as any);
    };

    void render();
    // 主题切换（.dark class 变化）→ 用新 token 重绘。
    mo = new MutationObserver(() => void render());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      alive = false;
      mo?.disconnect();
      if (chart) {
        try {
          chart.destroy();
        } catch {
          /* ignore */
        }
      }
    };
    // configBuilder 随 deps 更新（调用方控制），不单独进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// ── 图表卡外框 ──────────────────────────────────────────────────────────
/**
 * 图表卡：统一头部（标题/说明/右侧 action）+ 定高画布容器。
 * 内部放 `<canvas ref={ref} />`；高度由本卡控制（chart maintainAspectRatio:false）。
 */
export function ChartCard({
  title,
  hint,
  action,
  height = 260,
  children,
  className,
  ariaLabel,
  dataTable,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  height?: number;
  children: ReactNode;
  className?: string;
  /** 图表的屏幕阅读器名称；未提供时沿用可见标题。 */
  ariaLabel?: string;
  /** 与画布同源的文本数据。视觉保持 canvas，读屏改读精确字符串表格。 */
  dataTable?: {
    columns: readonly string[];
    rows: readonly (readonly string[])[];
    emptyText?: string;
  };
}) {
  const accessibleLabel = ariaLabel ?? title;
  return (
    // biome-ignore lint/a11y/useSemanticElements: 图表是有名称的内容组，不是表单控件组，fieldset 语义不适用。
    <Card className={className} role="group" aria-label={accessibleLabel}>
      <PanelHeader title={title} hint={hint} action={action} />
      <div className="px-4 pb-4">
        <div className="relative w-full" style={{ height }} aria-hidden={dataTable ? true : undefined}>
          {children}
        </div>
        {dataTable &&
          (dataTable.rows.length > 0 ? (
            <table className="sr-only">
              <caption>{accessibleLabel}</caption>
              <thead>
                <tr>
                  {dataTable.columns.map((column) => (
                    <th key={column} scope="col">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dataTable.rows.map((row) => (
                  <tr key={row[0]}>
                    {dataTable.columns.map((column, cellIndex) =>
                      cellIndex === 0 ? (
                        <th key={column} scope="row">
                          {row[cellIndex]}
                        </th>
                      ) : (
                        <td key={column}>{row[cellIndex]}</td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="sr-only">{dataTable.emptyText ?? "暂无数据"}</p>
          ))}
      </div>
    </Card>
  );
}

// ── 房子风格的 config 构造器 ─────────────────────────────────────────────

const houseTooltip = (theme: ChartTheme) => ({
  backgroundColor: theme.elevated,
  titleColor: theme.fg,
  bodyColor: theme.fg,
  borderColor: theme.border,
  borderWidth: 1,
  padding: 10,
  cornerRadius: 8,
  boxPadding: 4,
  usePointStyle: true,
});

const houseLegend = (theme: ChartTheme, position: "top" | "right" | "bottom" = "top") => ({
  position,
  align: "end" as const,
  labels: {
    color: theme.text,
    boxWidth: 10,
    boxHeight: 10,
    usePointStyle: true,
    padding: 14,
    font: { size: 11 },
  },
});

const houseScales = (theme: ChartTheme, opts?: { stacked?: boolean; hideX?: boolean }) => ({
  x: {
    stacked: opts?.stacked,
    grid: { display: false },
    border: { display: false },
    ticks: { color: theme.text, font: { size: 11 }, maxRotation: 0, autoSkipPadding: 12 },
    display: !opts?.hideX,
  },
  y: {
    stacked: opts?.stacked,
    beginAtZero: true,
    grid: { color: theme.grid },
    border: { display: false },
    ticks: { color: theme.text, font: { size: 11 }, maxTicksLimit: 6, padding: 6 },
  },
});

export type LineSeries = {
  label: string;
  data: number[];
  /** 色板外自定颜色 token（如 'success'）；缺省按 series 序取色板。 */
  colorToken?: string;
  /** 填充到 x 轴（面积图）。 */
  fill?: boolean;
};

/** 折线/面积趋势图。 */
export function lineConfig(
  theme: ChartTheme,
  o: { labels: (string | number)[]; series: LineSeries[] },
): ChartConfiguration {
  const single = o.series.length <= 1;
  return {
    type: "line",
    data: {
      labels: o.labels,
      datasets: o.series.map((s, i) => {
        const c = s.colorToken ? theme.color(s.colorToken) : theme.palette[i % theme.palette.length];
        return {
          label: s.label,
          data: s.data,
          borderColor: c,
          backgroundColor: s.fill ? withAlpha(c, theme.isDark ? 0.18 : 0.12) : c,
          fill: s.fill ?? false,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBorderWidth: 2,
          pointHoverBackgroundColor: c,
        };
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: !single, ...houseLegend(theme) },
        tooltip: houseTooltip(theme),
      },
      scales: houseScales(theme),
    },
  };
}

/** 柱状分布图（可堆叠 / 水平）。 */
export function barConfig(
  theme: ChartTheme,
  o: {
    labels: (string | number)[];
    series: LineSeries[];
    stacked?: boolean;
    horizontal?: boolean;
  },
): ChartConfiguration {
  const single = o.series.length <= 1;
  return {
    type: "bar",
    data: {
      labels: o.labels,
      datasets: o.series.map((s, i) => {
        const c = s.colorToken ? theme.color(s.colorToken) : theme.palette[i % theme.palette.length];
        return {
          label: s.label,
          data: s.data,
          backgroundColor: single ? withAlpha(c, theme.isDark ? 0.85 : 0.9) : c,
          borderRadius: 5,
          borderSkipped: false,
          maxBarThickness: 42,
          categoryPercentage: 0.7,
          barPercentage: 0.86,
        };
      }),
    },
    options: {
      indexAxis: o.horizontal ? "y" : "x",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: !single, ...houseLegend(theme) },
        tooltip: houseTooltip(theme),
      },
      scales: houseScales(theme, { stacked: o.stacked }),
    },
  };
}

/** 环形构成图（图例默认右侧）。 */
export function donutConfig(
  theme: ChartTheme,
  o: {
    labels: string[];
    data: number[];
    colorTokens?: string[];
    legend?: "right" | "bottom" | "none";
  },
): ChartConfiguration {
  const colors = o.labels.map((_, i) =>
    o.colorTokens?.[i] ? theme.color(o.colorTokens[i]) : theme.palette[i % theme.palette.length],
  );
  const legend = o.legend ?? "right";
  // cutout 是 doughnut 专属 option（不在跨类型的 ChartConfiguration 公共 options 上），
  // 故本地按 "doughnut" 精确类型构造，再拓宽回统一的 ChartConfiguration 返回。
  const config: ChartConfiguration<"doughnut"> = {
    type: "doughnut",
    data: {
      labels: o.labels,
      datasets: [
        {
          data: o.data,
          backgroundColor: colors,
          borderColor: theme.elevated,
          borderWidth: 2,
          hoverOffset: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "62%",
      plugins: {
        legend:
          legend === "none"
            ? { display: false }
            : {
                display: true,
                position: legend,
                labels: {
                  color: theme.text,
                  boxWidth: 10,
                  boxHeight: 10,
                  usePointStyle: true,
                  padding: 12,
                  font: { size: 11 },
                },
              },
        tooltip: houseTooltip(theme),
      },
    },
  };
  return config as ChartConfiguration;
}

/** 行内迷你趋势（无轴/无图例/无 tooltip）。放表格单元或 StatCard 旁。 */
export function sparklineConfig(
  theme: ChartTheme,
  o: { data: number[]; colorToken?: string; fill?: boolean },
): ChartConfiguration {
  const c = o.colorToken ? theme.color(o.colorToken) : theme.palette[0];
  return {
    type: "line",
    data: {
      labels: o.data.map((_, i) => i),
      datasets: [
        {
          data: o.data,
          borderColor: c,
          backgroundColor: (o.fill ?? true) ? withAlpha(c, 0.16) : c,
          fill: o.fill ?? true,
          tension: 0.4,
          borderWidth: 1.5,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
      elements: { line: { borderCapStyle: "round" } },
    },
  };
}
