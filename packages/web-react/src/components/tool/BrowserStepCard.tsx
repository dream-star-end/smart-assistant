/**
 * 浏览器操作卡(OCV5-374,懒加载块):oc-browser 和 MCP browser_* 共用一张。
 *
 * 像一扇缩小的浏览器窗口:地址栏(主机 + 路径)、页面标题、这一步做了什么(打开 → 调整窗口 → 截图),
 * 截图按页面原样框起来;点截图在详情面板的「浏览器」里看大图和整轮的操作记录。
 * 失败给首个 Error 行和完整输出;取过页面结构的给「查看页面快照」。数据全部来自 browserSteps.ts。
 */
import { isContainerPreviewUrl } from "@openclaude/protocol/containerPreview";
import { ChevronRight, Globe, Lock, PanelRight } from "lucide-react";
import { Fragment, useState } from "react";
import { cn } from "../../lib/utils";
import { SignedImg, useSignedSrc } from "../chat/media";
import { type BrowserStep, displayAddress } from "./browserSteps";
import { useArtifactInspect } from "./context";
import type { ToolLike } from "./format";

/** 链接态地址栏:触屏 44px 命中(a11y-B tools#1),视觉不变。 */
const LINK_CLS =
  "outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11";

/** 地址:https 显示锁;公网地址新标签打开;容器回环地址交给全局「容器预览」监听;其余只显示。 */
export function AddressBar({ url, className }: { url: string; className?: string }) {
  const { host, path } = displayAddress(url);
  const secure = /^https:\/\//i.test(url);
  const Icon = secure ? Lock : Globe;
  const body = (
    <>
      <Icon size={12} aria-hidden className="shrink-0 text-faint" />
      <span className="min-w-0 truncate">
        <span className="text-fg">{host}</span>
        {path && <span className="text-faint">{path}</span>}
      </span>
    </>
  );
  const base = cn(
    "flex min-w-0 items-center gap-1.5 rounded-full bg-hover/80 px-3 py-1.5 font-mono text-[12px] leading-none",
    className,
  );
  if (isContainerPreviewUrl(url)) {
    return (
      <a href={url} title={url} className={cn(base, LINK_CLS)} data-testid="browser-address">
        {body}
      </a>
    );
  }
  if (/^https?:\/\//i.test(url)) {
    return (
      <a
        href={url}
        title={url}
        target="_blank"
        rel="noopener noreferrer"
        data-container-preview-ignore=""
        className={cn(base, LINK_CLS)}
        data-testid="browser-address"
      >
        {body}
      </a>
    );
  }
  return (
    <div title={url} className={base} data-testid="browser-address">
      {body}
    </div>
  );
}

/** 这一步做了什么:动作之间用细箭头串起来,带上元素 / 输入 / 尺寸。 */
export function ActionTrail({ step, className }: { step: BrowserStep; className?: string }) {
  return (
    <ol className={cn("flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-meta", className)} data-testid="browser-actions">
      {step.actions.map((a, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 同一动作可在一条命令里出现多次,顺序即身份
        <Fragment key={i}>
          {i > 0 && <ChevronRight size={12} aria-hidden className="shrink-0 text-faint/70" />}
          <li className="flex min-w-0 items-center gap-1">
            <span className="shrink-0 text-muted">{a.label}</span>
            {a.detail && !/^https?:\/\//i.test(a.detail) && (
              <span className="min-w-0 max-w-[16rem] truncate rounded bg-hover px-1 font-mono text-[11.5px] text-fg" title={a.detail}>
                {a.detail}
              </span>
            )}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

function OutputFold({ text, label }: { text: string; label: string }) {
  const clean = text.trim();
  if (!clean) return null;
  return (
    <details className="group/fold">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-caption text-faint outline-none hover:text-muted focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} aria-hidden className="transition-transform group-open/fold:rotate-90" />
        {label}
      </summary>
      <pre
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 有 max-h 的滚动区要能聚焦,键盘才能滚
        tabIndex={0}
        className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {clean.length > 12000 ? `${clean.slice(0, 12000)}\n…` : clean}
      </pre>
    </details>
  );
}

/** 签名后的普通 <img>:放在按钮里用(SignedImg 自带放大按钮,不能再套一层按钮)。 */
export function PlainSignedImg({ src, className }: { src: string; className?: string }) {
  const { url, onError } = useSignedSrc(src);
  return url ? <img src={url} alt="" onError={onError} className={className} /> : null;
}

/** 胶片条里的一格:普通 <img>(放大交给主图),按钮只负责换主图。 */
export function ShotThumb({ src, n, active, onPick }: { src: string; n: number; active: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`第 ${n} 张截图`}
      aria-pressed={active}
      onClick={onPick}
      className={cn(
        "h-12 w-20 shrink-0 overflow-hidden rounded-md border bg-hover outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-accent ring-1 ring-accent" : "border-border/70 opacity-75 hover:opacity-100",
      )}
      data-testid="browser-shot-thumb"
    >
      <PlainSignedImg src={src} className="h-full w-full object-cover object-top" />
    </button>
  );
}

export function BrowserStepCard({ step, tool }: { step: BrowserStep; tool: ToolLike }) {
  const inspect = useArtifactInspect();
  const shots = step.shots.length > 0 ? step.shots : step.requestedShots;
  const [picked, setPicked] = useState(0);
  const shot = shots[Math.min(picked, shots.length - 1)] ?? null;
  const openPane = inspect.open ? () => inspect.open?.({ kind: "tool", message: tool }) : null;
  return (
    <section
      className="group/card overflow-hidden rounded-xl border border-border/80 bg-surface shadow-soft"
      data-testid="browser-card"
    >
      <div className="space-y-2 px-3 pt-3 pb-2.5">
        {step.url && <AddressBar url={step.url} />}
        {step.title && (
          <p className="truncate px-1 text-body font-medium text-fg" title={step.title} data-testid="browser-title">
            {step.title}
          </p>
        )}
        <ActionTrail step={step} className="px-1" />
        {step.error && (
          <p className="break-words px-1 text-meta text-danger" data-testid="browser-error">
            {step.error.slice(0, 240)}
          </p>
        )}
        {step.running && <p className="animate-pulse px-1 text-meta text-faint">正在操作浏览器…</p>}
      </div>
      {shot && (
        <div className="border-t border-border/70 bg-hover/40 p-2.5">
          <div className="relative overflow-hidden rounded-lg border border-border/70 bg-surface [&_img]:max-h-80 [&_img]:w-full [&_img]:object-contain [&_img]:object-top" data-testid="browser-shot">
            {/* 点图放大(全局看图器);右上角进侧栏看这一轮的浏览器记录。 */}
            <SignedImg src={shot} alt="页面截图" className="block max-h-80 w-full object-contain object-top" />
            {openPane && (
              <button
                type="button"
                onClick={openPane}
                className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-black/55 px-2 py-1 text-caption text-white outline-none transition-opacity hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-ring [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/card:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
                data-testid="browser-open-pane"
              >
                <PanelRight size={11} aria-hidden />
                在侧栏查看
              </button>
            )}
          </div>
          {shots.length > 1 && (
            <fieldset className="m-0 mt-2 flex min-w-0 gap-1.5 overflow-x-auto border-0 p-0">
              <legend className="sr-only">这一步的截图</legend>
              {shots.map((s, i) => (
                <ShotThumb key={s} src={s} n={i + 1} active={s === shot} onPick={() => setPicked(i)} />
              ))}
            </fieldset>
          )}
        </div>
      )}
      {(step.error || step.snapshot) && (
        <div className="border-t border-border/70 px-4 py-2">
          <OutputFold text={step.output} label={step.error ? "错误详情" : "查看页面快照"} />
        </div>
      )}
    </section>
  );
}
