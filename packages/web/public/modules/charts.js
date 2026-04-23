/**
 * 超管 dashboard 图表 helper。
 *
 * 封装 Chart.js 4.x UMD(挂 window.Chart)的通用图表构造函数,
 * 统一读 CSS 设计 token(--accent/--ok/--warn/--danger/--muted/--text/--border)
 * 做颜色,保证深浅主题切换时图表自动适配。
 *
 * 所有导出的 helper 都是幂等的:若 canvas 上已存在 chart,先 destroy 再新建。
 * 这样 dashboard 支持周期性刷新 / 参数切换,不泄漏旧实例。
 *
 * 使用前提:
 *   - <script src="/vendor/chart.umd.min.js"> 先加载
 *   - canvas 元素已在 DOM 中
 *
 * API 约定:
 *   lineChart(canvas, { labels, series: [{ label, data, color?, fill? }] })
 *   barChart (canvas, { labels, series: [{ label, data, color? }] })
 *   donutChart(canvas, { labels, values, colors })
 */

const chartRegistry = new WeakMap();

/** 从 :root 读 CSS token 化成 RGB(a) 字符串。不存在时退到 fallback。 */
function cssVar(name, fallback = "#888") {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** 把 "#rrggbb" 转成 "rgba(r, g, b, a)"。已是 rgba/rgb 直接返(alpha 忽略)。 */
function withAlpha(color, alpha = 1) {
  if (!color) return `rgba(0,0,0,${alpha})`;
  if (color.startsWith("rgb")) return color;
  const h = color.replace("#", "");
  if (h.length !== 6) return color;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 统一图表全局默认(字体/颜色/border),每次调用前刷(主题切换生效)。 */
function applyGlobalDefaults() {
  const C = window.Chart;
  if (!C) return;
  C.defaults.font.family = cssVar("--font-sans",
    "-apple-system, BlinkMacSystemFont, Inter, sans-serif");
  C.defaults.font.size = 12;
  C.defaults.color = cssVar("--muted", "#888");
  C.defaults.borderColor = cssVar("--border", "#ccc");
  C.defaults.animation.duration = 300;
  C.defaults.plugins.legend.labels.color = cssVar("--text-soft", "#888");
  C.defaults.plugins.tooltip.backgroundColor = cssVar("--panel-2", "#222");
  C.defaults.plugins.tooltip.titleColor = cssVar("--text-strong", "#fff");
  C.defaults.plugins.tooltip.bodyColor = cssVar("--text", "#ddd");
  C.defaults.plugins.tooltip.borderColor = cssVar("--border-strong", "#555");
  C.defaults.plugins.tooltip.borderWidth = 1;
  C.defaults.plugins.tooltip.padding = 10;
  C.defaults.plugins.tooltip.cornerRadius = 8;
  C.defaults.plugins.tooltip.displayColors = true;
}

/** 销毁 canvas 上的旧 chart(若有)。 */
function destroyIfAny(canvas) {
  const prev = chartRegistry.get(canvas);
  if (prev) {
    try { prev.destroy(); } catch {}
    chartRegistry.delete(canvas);
  }
}

/** Chart.js 未加载时的降级提示。 */
function ensureChartLib() {
  if (typeof window.Chart !== "function") {
    console.warn("[charts] Chart.js UMD not loaded — falling back to empty canvas");
    return false;
  }
  return true;
}

/**
 * 折线图(多 series)。series 每条可指定颜色(不指定走 accent/ok/warn/danger 轮询)。
 */
export function lineChart(canvas, { labels, series, yFormatter } = {}) {
  if (!canvas || !ensureChartLib()) return null;
  applyGlobalDefaults();
  destroyIfAny(canvas);
  const palette = [
    cssVar("--accent", "#d97757"),
    cssVar("--ok", "#86c781"),
    cssVar("--warn", "#e8b64c"),
    cssVar("--danger", "#e06c6c"),
  ];
  const datasets = (series || []).map((s, i) => {
    const color = s.color || palette[i % palette.length];
    return {
      label: s.label,
      data: s.data,
      borderColor: color,
      backgroundColor: s.fill ? withAlpha(color, 0.12) : "transparent",
      borderWidth: 2,
      fill: !!s.fill,
      tension: 0.3,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: color,
      pointHoverBorderColor: cssVar("--bg", "#1a1a1d"),
      pointHoverBorderWidth: 2,
    };
  });
  const chart = new window.Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", align: "end",
          labels: { boxWidth: 12, boxHeight: 12, padding: 14 } },
        tooltip: {
          callbacks: yFormatter
            ? { label: (ctx) => `${ctx.dataset.label}: ${yFormatter(ctx.parsed.y)}` }
            : undefined,
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxRotation: 0, autoSkipPadding: 18 },
        },
        y: {
          beginAtZero: true,
          grid: { color: cssVar("--border-subtle", "#2a2a2a") },
          ticks: yFormatter ? { callback: (v) => yFormatter(v) } : {},
        },
      },
    },
  });
  chartRegistry.set(canvas, chart);
  return chart;
}

/** 柱状图(stack 可选)。 */
export function barChart(canvas, { labels, series, stacked = false, yFormatter } = {}) {
  if (!canvas || !ensureChartLib()) return null;
  applyGlobalDefaults();
  destroyIfAny(canvas);
  const palette = [
    cssVar("--accent", "#d97757"),
    cssVar("--ok", "#86c781"),
    cssVar("--warn", "#e8b64c"),
    cssVar("--danger", "#e06c6c"),
  ];
  const datasets = (series || []).map((s, i) => {
    const color = s.color || palette[i % palette.length];
    return {
      label: s.label,
      data: s.data,
      backgroundColor: withAlpha(color, 0.85),
      hoverBackgroundColor: color,
      borderRadius: 4,
      borderSkipped: false,
    };
  });
  const chart = new window.Chart(canvas, {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "top", align: "end",
          labels: { boxWidth: 12, boxHeight: 12, padding: 14 } },
        tooltip: {
          callbacks: yFormatter
            ? { label: (ctx) => `${ctx.dataset.label}: ${yFormatter(ctx.parsed.y)}` }
            : undefined,
        },
      },
      scales: {
        x: { stacked, grid: { display: false } },
        y: {
          stacked,
          beginAtZero: true,
          grid: { color: cssVar("--border-subtle", "#2a2a2a") },
          ticks: yFormatter ? { callback: (v) => yFormatter(v) } : {},
        },
      },
    },
  });
  chartRegistry.set(canvas, chart);
  return chart;
}

/** 环形图(账号池状态)。colors 可传 CSS var 名数组(如 ["--ok","--warn","--danger"]) */
export function donutChart(canvas, { labels, values, colors } = {}) {
  if (!canvas || !ensureChartLib()) return null;
  applyGlobalDefaults();
  destroyIfAny(canvas);
  const resolved = (colors || ["--accent", "--ok", "--warn", "--danger"]).map((c) =>
    c.startsWith("--") ? cssVar(c, "#888") : c,
  );
  const chart = new window.Chart(canvas, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: resolved.map((c) => withAlpha(c, 0.85)),
        borderColor: cssVar("--panel", "#222"),
        borderWidth: 2,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "62%",
      plugins: {
        legend: { position: "bottom",
          labels: { boxWidth: 12, boxHeight: 12, padding: 12 } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = ctx.dataset.data.reduce((a, b) => a + (Number(b) || 0), 0);
              const v = Number(ctx.parsed) || 0;
              const pct = total > 0 ? ((v / total) * 100).toFixed(1) : "0.0";
              return `${ctx.label}: ${v} (${pct}%)`;
            },
          },
        },
      },
    },
  });
  chartRegistry.set(canvas, chart);
  return chart;
}

/**
 * 主题切换时外部调用:销毁所有已注册图表。
 * 调用方需要重新 render(调用 lineChart/barChart/donutChart)。
 *
 * WeakMap 无法枚举,所以对特定 canvas 集合显式 destroyIfAny。
 * 实际用法:dashboard 层自己缓存 canvas 引用 + 重新调用 render 函数。
 */
export function destroyChart(canvas) {
  destroyIfAny(canvas);
}

/** 常用数字 formatter,前端复用。 */
export const fmt = {
  /** cents → ¥X.XX */
  yuan: (cents) => `¥${(Number(cents) / 100).toFixed(2)}`,
  /** 压缩数字:1234 → 1.2k,1234567 → 1.2M */
  compact: (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return "0";
    if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return `${v}`;
  },
  /** 百分比 0~1 → "XX.X%" */
  pct: (x) => `${(Number(x) * 100).toFixed(1)}%`,
  /** 小时标签 "2026-04-23 14:00" → "14:00" */
  hourShort: (iso) => {
    const m = iso.match(/(\d{2}:\d{2})$/);
    return m ? m[1] : iso;
  },
  /** 日期 "2026-04-23" → "04-23" */
  dayShort: (iso) => iso.slice(5),
};
