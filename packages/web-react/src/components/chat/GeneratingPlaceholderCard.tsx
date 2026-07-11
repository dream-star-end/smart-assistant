/**
 * 生成占位卡（需求 C）—— 图片生成期间在对话流内占位的「粒子特效框」。
 *
 * 触发面（三处，见 image-ux 规格 §6）：
 *  ① imageEdit（编辑/评论/调整大小）提交 → socket 注入本地占位行（_genPlaceholder），
 *     MessageList 拦截渲染本卡；turn final 由 reducer 按 jobId 消解、error 转 failed。
 *  ② 模型原生 imagegen（codex:imageGeneration，running）→ MessageRenderer case "tool"
 *     前置分支直接渲染本卡（complete/failed 回落 ToolCardSlot）。
 *
 * 动效纪律（贴 OC 质感、低调）：
 *  - 深色卡内 canvas rAF 浮游发光粒子（星尘缓慢漂移 + 微弱明灭）；
 *  - `prefers-reduced-motion` → **不启 rAF**，降级为 CSS 柔和脉冲（无障碍）；
 *  - 组件卸载必 cancelAnimationFrame（防泄漏）；jsdom 无 canvas（getContext→null）时
 *    直接短路，测试环境零 rAF、零抛错。
 *
 * 形态：按目标宽高比定框（aspect 数字比值或 "16:9" 枚举，默认 1:1），max-h 对齐现图片卡
 * （media.tsx 的 max-h-72 = 18rem）；角标「正在生成 · 约几十秒」；startedAt + 3 分钟无
 * 事件 → 转「仍在处理，稍后回来看」（纯前端超时兜底，不改 reducer 态）；failed → danger
 * 边 + 原因（+ 可选重试）。
 */
import { ImageIcon, RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";

/** 「仍在处理」超时兜底阈值（3 分钟）。 */
const STILL_PROCESSING_MS = 3 * 60_000;

export type GeneratingPlaceholderCardProps = {
  /** 目标宽高比：数字比值（w/h）或比例枚举字符串（"16:9" / "9:16"…）；默认 1:1。 */
  aspect: number | string;
  status: "running" | "failed";
  /** 生成开始时刻（client mint）；超时兜底与稳定 rAF 依赖此稳定值。 */
  startedAt: number;
  /** 失败友好文案（契约外可选附加项）。 */
  reason?: string;
  /** 失败重试入口（如适用）。 */
  onRetry?: () => void;
};

/** 读「减少动态效果」系统偏好：true 时关 rAF、降级为 CSS 脉冲。 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/** aspect（数字比值 / "16:9" / "9/16" 等）→ 归一化正数比值（w/h），无法解析回退 1。 */
export function parseAspectRatio(aspect: number | string): number {
  if (typeof aspect === "number") return Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:/xX×]\s*(\d+(?:\.\d+)?)\s*$/.exec(aspect);
  if (m) {
    const w = Number.parseFloat(m[1]);
    const h = Number.parseFloat(m[2]);
    if (w > 0 && h > 0) return w / h;
  }
  const n = Number.parseFloat(aspect);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

type Particle = { x: number; y: number; r: number; a: number; vx: number; vy: number; tw: number; ph: number };

export function GeneratingPlaceholderCard({
  aspect,
  status,
  startedAt,
  reason,
  onRetry,
}: GeneratingPlaceholderCardProps) {
  const reduced = usePrefersReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const ratio = parseAspectRatio(aspect);
  const failed = status === "failed";

  // ── 超时兜底：startedAt + 3min 无消解/失败 → 展示「仍在处理，稍后回来看」──
  const [overtime, setOvertime] = useState(() => Date.now() - startedAt >= STILL_PROCESSING_MS);
  useEffect(() => {
    if (failed) return; // 失败态不再计超时
    const remaining = STILL_PROCESSING_MS - (Date.now() - startedAt);
    if (remaining <= 0) {
      setOvertime(true);
      return;
    }
    setOvertime(false);
    const t = setTimeout(() => setOvertime(true), remaining);
    return () => clearTimeout(t);
  }, [startedAt, failed]);

  // ── canvas 粒子 rAF（reduced-motion / 失败态 / 无 2d 上下文 时不启动）──
  useEffect(() => {
    if (reduced || failed) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null; // 某些环境(旧 jsdom/受限浏览器)getContext 抛错：视同不支持
    }
    if (!ctx) return; // jsdom / 不支持 canvas：短路，零 rAF

    const dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    let particles: Particle[] = [];
    let w = 0;
    let h = 0;

    const seed = () => {
      const rect = canvas.getBoundingClientRect();
      w = Math.max(1, rect.width);
      h = Math.max(1, rect.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // 粒子密度随面积（低调、不铺满）：约每 9000px² 一颗，钳在 [14, 60]。
      const count = Math.max(14, Math.min(60, Math.round((w * h) / 9000)));
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 0.6 + Math.random() * 1.6,
        a: 0.2 + Math.random() * 0.5,
        vx: (Math.random() - 0.5) * 0.12,
        vy: -(0.05 + Math.random() * 0.18), // 整体缓慢上浮（星尘漂移）
        tw: 0.6 + Math.random() * 1.4, // 明灭速度
        ph: Math.random() * Math.PI * 2,
      }));
    };
    seed();

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        // 环绕重生（离顶/边界回收到底部对侧），维持恒定密度。
        if (p.y < -4) {
          p.y = h + 4;
          p.x = Math.random() * w;
        }
        if (p.x < -4) p.x = w + 4;
        else if (p.x > w + 4) p.x = -4;
        const twinkle = 0.55 + 0.45 * Math.sin(t / 1000 * p.tw + p.ph);
        const alpha = Math.max(0, Math.min(1, p.a * twinkle));
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 3);
        g.addColorStop(0, `rgba(190, 210, 255, ${alpha})`);
        g.addColorStop(1, "rgba(190, 210, 255, 0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 3, 0, Math.PI * 2);
        ctx.fill();
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);

    // 尺寸变化重播种（jsdom ResizeObserver 为 no-op 桩，不影响）。
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => seed());
      ro.observe(canvas);
    }

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      ro?.disconnect();
    };
  }, [reduced, failed]);

  const badge = failed ? null : overtime ? "仍在处理，稍后回来看" : "正在生成 · 约几十秒";

  return (
    <div className="flex gap-4 animate-in" data-testid="generating-placeholder">
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "relative overflow-hidden rounded-lg border",
            failed ? "border-danger/60" : "border-border",
          )}
          style={{
            width: `min(100%, calc(18rem * ${ratio}))`,
            aspectRatio: String(ratio),
            // 深色底：粒子发光基面（贴 image viewer 黑底质感，明暗主题一致）。
            background: "radial-gradient(120% 120% at 50% 30%, #12151d 0%, #0a0c11 100%)",
          }}
          role="img"
          aria-label={failed ? "图片生成失败" : "图片生成中"}
          aria-busy={!failed}
        >
          {!failed && !reduced && (
            // 纯装饰粒子层：无 aria/role（canvas 被 a11y 规则视为交互元素，加 aria-hidden /
            // 非交互 role 都会触发规则）；可访问名由外层 role="img" + aria-label 提供，canvas
            // 无文本内容，屏幕阅读器本就跳过。
            <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
          )}
          {!failed && reduced && (
            // reduced-motion 降级：柔和脉冲（无 rAF）。
            <div
              className="absolute inset-0 animate-pulse"
              aria-hidden="true"
              style={{ background: "radial-gradient(60% 60% at 50% 50%, rgba(190,210,255,0.10), transparent)" }}
            />
          )}

          {/* 失败态：danger 图标 + 原因 + 可选重试。 */}
          {failed && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
              <TriangleAlert size={22} className="text-danger" aria-hidden="true" />
              <div className="text-[13px] font-medium text-danger">图片生成失败</div>
              {reason && <div className="max-w-full truncate text-[11.5px] text-muted">{reason}</div>}
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="mt-1 inline-flex items-center gap-1 rounded-full bg-hover px-2.5 py-1 text-[11.5px] text-fg hover:opacity-90"
                >
                  <RotateCcw size={12} /> 重试
                </button>
              )}
            </div>
          )}

          {/* 生成中角标（左下小字胶囊）。 */}
          {badge && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 p-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-black/45 px-2 py-1 text-[11px] font-medium text-white/90 backdrop-blur-sm">
                <ImageIcon size={12} className="opacity-80" aria-hidden="true" />
                {badge}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
