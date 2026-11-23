import { AlertTriangle, BookOpen, Check, ChevronDown, Copy, Download, Eye, EyeOff, Globe, Loader2, Lock, Maximize2, PanelRight, Play, RotateCcw } from "lucide-react";
import { useId, useState, useSyncExternalStore } from "react";
import { nativeDownload } from "../../lib/chat/download";
import { cn } from "../../lib/utils";
import { dispatchOpenInWorkbench } from "../../lib/workbenchOpen";
import {
  getLiveBrowserHandbackFor,
  getLiveBrowserHandbackVersion,
  getLiveBrowserHandoffPhaseFor,
  hasLiveBrowserHandbackHandler,
  notifyLiveBrowserHandoffPhase,
  requestLiveBrowserHandback,
  subscribeLiveBrowserHandback,
} from "../chat/inspectorState";
import { useMediaSigner } from "../chat/media";
import { chatInteractionUnavailableText, useArtifactInspect, useChatInteraction } from "../tool/context";
import { useToast } from "../ui";
import { BodyMarkdown, Frame, Inline, useCopiedFlag } from "./shell";
import { interpolateRunbookCommand, v2ToMarkdown } from "./v2Markdown";
import type { BrowserHandoffSpec, CitationsSpec, DeliverablesSpec, RunbookSpec } from "./v2Schema";
import "./browserHandoff.css";

type BlockProps<S> = { spec: S; notes: string[]; streaming: boolean; readOnly?: boolean; nested?: boolean };

function SmallCopy({ getText, label, idle }: { getText: () => string; label: string; idle: string }) {
  const [done, flash] = useCopiedFlag();
  const toast = useToast();
  return (
    <button
      type="button"
      className="oc-iui-text-btn"
      aria-label={done ? `已复制${label}` : `复制${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(getText());
          flash();
        } catch {
          toast("复制失败，请手动选中文本复制", "error");
        }
      }}
    >
      {done ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
      {done ? "已复制" : idle}
    </button>
  );
}

const BATCH_DOWNLOAD_DELAY_MS = 250;

// ── 10. Deliverables 工作台 ──────────────────────────────────────────────

export function DeliverablesBlock({ spec, notes, streaming, nested }: BlockProps<DeliverablesSpec>) {
  const { resolve } = useMediaSigner();
  const [previewIdx, setPreviewIdx] = useState<number | null>(() => {
    const first = spec.items.findIndex((x) => !!x.preview);
    return first >= 0 && spec.items.length <= 4 ? first : null;
  });
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const downloadable = spec.items.filter((x) => !!x.path);

  const downloadItem = async (item: DeliverablesSpec["items"][number]) => {
    if (!item.path) return;
    setStatusMsg(null);
    if (/^https:\/\//i.test(item.path)) {
      nativeDownload(item.path, item.name);
      return;
    }
    const url = await resolve(item.path);
    if (url) nativeDownload(url, item.name);
    else setStatusMsg(`未能签名下载 ${item.name}（预览或只读环境不支持容器取档）`);
  };

  const downloadAll = async () => {
    if (downloadingAll) return;
    setDownloadingAll(true);
    try {
      for (let i = 0; i < downloadable.length; i += 1) {
        if (i > 0) await new Promise((r) => window.setTimeout(r, BATCH_DOWNLOAD_DELAY_MS));
        await downloadItem(downloadable[i]!);
      }
    } finally {
      setDownloadingAll(false);
    }
  };

  const activePreview = previewIdx !== null ? spec.items[previewIdx] : undefined;
  return (
    <Frame
      kind="deliverables"
      title={spec.title ?? "交付物工作台"}
      subtitle={spec.subtitle ?? `共 ${spec.items.length} 个文件`}
      notes={notes}
      streaming={streaming}
      nested={nested}
      copyText={() => v2ToMarkdown(spec)}
      actions={
        downloadable.length >= 2 && !streaming ? (
          <button
            type="button"
            className="oc-iui-btn is-primary"
            disabled={downloadingAll}
            onClick={() => void downloadAll()}
          >
            {downloadingAll ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Download size={14} aria-hidden />}
            {downloadingAll ? "正在下载…" : `下载全部 (${downloadable.length})`}
          </button>
        ) : undefined
      }
    >
      <ul className="oc-iui-deliv-list" aria-label="交付文件列表">
        {spec.items.map((it, i) => {
          const open = previewIdx === i && !!it.preview;
          const info = [it.size, it.meta, it.desc].filter(Boolean).join(" · ");
          return (
            <li key={`${i}:${it.name}`} className="oc-iui-deliv-item">
              <span className={cn("oc-iui-file-ext", `is-${it.ext}`)}>{it.ext.toUpperCase()}</span>
              <div className="min-w-0 flex-1">
                <div className="oc-iui-deliv-name" title={it.name}>
                  {it.name}
                </div>
                {info && <div className="oc-iui-deliv-meta">{info}</div>}
              </div>
              <div className="oc-iui-deliv-actions">
                {it.path && !streaming && (
                  <button
                    type="button"
                    className="oc-iui-text-btn"
                    data-testid="deliverable-open-workbench"
                    onClick={() =>
                      dispatchOpenInWorkbench({
                        path: it.path,
                        title: it.name,
                        tab: "outputs",
                      })
                    }
                  >
                    <PanelRight size={13} aria-hidden />
                    工作台预览
                  </button>
                )}
                {it.preview && (
                  <button
                    type="button"
                    className="oc-iui-text-btn"
                    aria-expanded={open}
                    disabled={streaming}
                    onClick={() => setPreviewIdx(open ? null : i)}
                  >
                    {open ? <EyeOff size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
                    {open ? "收起速览" : "速览"}
                  </button>
                )}
                {it.path && <SmallCopy getText={() => it.path!} label={`路径 ${it.name}`} idle="路径" />}
                {it.path && (
                  <button type="button" className="oc-iui-text-btn" disabled={streaming} onClick={() => void downloadItem(it)}>
                    <Download size={13} aria-hidden />
                    下载
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {activePreview?.preview && (
        <div className="oc-iui-deliv-preview">
          <div className="oc-iui-deliv-preview-head">
            <span>页内速览：{activePreview.name}</span>
            <SmallCopy getText={() => activePreview.preview ?? ""} label="预览内容" idle="复制" />
          </div>
          {activePreview.ext === "md" ? (
            <BodyMarkdown text={activePreview.preview} />
          ) : (
            <pre className="oc-iui-deliv-pre">{activePreview.preview}</pre>
          )}
        </div>
      )}
      {statusMsg && <p className="oc-iui-deliv-status">{statusMsg}</p>}
    </Frame>
  );
}

// ── 11. Citations 科研文献卡 ─────────────────────────────────────────────

function defaultGbt(it: CitationsSpec["items"][number]): string {
  return `[${it.id}] ${it.title}${it.meta ? `. ${it.meta}` : ""}${it.url ? `. ${it.url}` : ""}.`;
}

function defaultBibtex(it: CitationsSpec["items"][number]): string {
  const key = `ref${it.id.replace(/[^A-Za-z0-9]/g, "") || "1"}`;
  return `@article{${key},\n  title={${it.title}}${it.meta ? `,\n  note={${it.meta}}` : ""}${it.url ? `,\n  url={${it.url}}` : ""}\n}`;
}

export function CitationsBlock({ spec, notes, streaming, readOnly, nested }: BlockProps<CitationsSpec>) {
  const { sendUserText, busy } = useChatInteraction();
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(spec.items.length <= 3 ? [0] : []));
  const canAsk = !readOnly && !streaming && !!sendUserText;

  const toggle = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <Frame kind="citations" title={spec.title ?? "文献精读卡"} subtitle={spec.subtitle} notes={notes} streaming={streaming} nested={nested} copyText={() => v2ToMarkdown(spec)}>
      <ul className="oc-iui-cite-list" aria-label="文献列表">
        {spec.items.map((it, i) => {
          const open = expanded.has(i);
          return (
            <li key={`${it.id}:${i}`} className="oc-iui-cite-item">
              <div className="oc-iui-cite-head">
                <div className="min-w-0 flex-1">
                  <div className="oc-iui-cite-title">
                    <span className="oc-iui-cite-num">[{it.id}]</span>
                    {it.url ? (
                      <a href={it.url} target="_blank" rel="noreferrer">
                        <Inline text={it.title} />
                      </a>
                    ) : (
                      <Inline text={it.title} />
                    )}
                  </div>
                  {it.meta && <div className="oc-iui-cite-meta">{it.meta}</div>}
                </div>
                {it.tags.length > 0 && (
                  <div className="oc-iui-cite-tags">
                    {it.tags.map((t) => (
                      <span key={t} className="oc-iui-chip">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {it.conclusion && (
                <p className="oc-iui-cite-conclusion">
                  <strong>核心结论</strong> <Inline text={it.conclusion} />
                </p>
              )}
              {open && it.abstract && <p className="oc-iui-cite-abstract">{it.abstract}</p>}
              <div className="oc-iui-cite-actions">
                {it.abstract && (
                  <button type="button" className="oc-iui-text-btn" aria-expanded={open} onClick={() => toggle(i)}>
                    <ChevronDown size={13} aria-hidden className={cn("transition-transform", open && "rotate-180")} />
                    {open ? "收起摘要" : "展开摘要"}
                  </button>
                )}
                <SmallCopy getText={() => it.gbt ?? defaultGbt(it)} label={`[${it.id}] GB/T 7714`} idle="复制 GB/T 7714" />
                <SmallCopy getText={() => it.bibtex ?? defaultBibtex(it)} label={`[${it.id}] BibTeX`} idle="复制 BibTeX" />
                {canAsk && (
                  <button
                    type="button"
                    className="oc-iui-text-btn"
                    disabled={!!busy}
                    onClick={() => sendUserText(`请帮我精读文献 [${it.id}]《${it.title}》，梳理核心方法、实验结论与局限。`)}
                  >
                    <BookOpen size={13} aria-hidden />
                    让助手精读
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Frame>
  );
}

// ── 12. Runbook 参数化命令流卡 ──────────────────────────────────────────

export function RunbookBlock({ spec, notes, streaming, readOnly, nested }: BlockProps<RunbookSpec>) {
  const { sendUserText, busy } = useChatInteraction();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(spec.vars.map((v) => [v.id, v.value])));
  const dirty = spec.vars.some((v) => values[v.id] !== v.value);
  const canRun = !readOnly && !streaming && !!sendUserText;

  const renderCommand = (cmd: string) => {
    const parts = cmd.split(/(\{\{[A-Za-z_][A-Za-z0-9_]*\}\}|\$\{[A-Za-z_][A-Za-z0-9_]*\})/g);
    return parts.map((p, idx) => {
      const m = /^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}$|^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(p);
      if (!m) return p;
      const k = (m[1] ?? m[2])!;
      return (
        <mark key={`${idx}:${k}`} className="oc-iui-var-hl">
          {values[k] ? values[k] : p}
        </mark>
      );
    });
  };

  return (
    <Frame
      kind="runbook"
      title={spec.title ?? "操作命令流"}
      subtitle={spec.subtitle ?? (spec.vars.length ? "修改变量后下方命令实时同步替换" : undefined)}
      notes={notes}
      streaming={streaming}
      nested={nested}
      copyText={() => v2ToMarkdown(spec, values)}
      actions={
        !streaming ? (
          <>
            {dirty && (
              <button
                type="button"
                className="oc-iui-text-btn"
                onClick={() => setValues(Object.fromEntries(spec.vars.map((v) => [v.id, v.value])))}
              >
                <RotateCcw size={13} aria-hidden />
                还原变量
              </button>
            )}
            {spec.steps.length >= 2 && (
              <SmallCopy
                getText={() => spec.steps.map((s) => `# ${s.title}\n${interpolateRunbookCommand(s.command, values)}`).join("\n\n")}
                label="全部命令"
                idle="复制全部"
              />
            )}
          </>
        ) : undefined
      }
    >
      {spec.vars.length > 0 && (
        // biome-ignore lint/a11y/useSemanticElements: div avoids fieldset default UA border and min-content layout
        <div className="oc-iui-runbook-vars" role="group" aria-label="参数变量">
          {spec.vars.map((v) => (
            <label key={v.id} className="oc-iui-runbook-var">
              <span>{v.label}</span>
              <input
                type="text"
                value={values[v.id] ?? ""}
                placeholder={v.placeholder ?? v.id}
                disabled={streaming}
                onChange={(e) => setValues((s) => ({ ...s, [v.id]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      )}
      <ol className="oc-iui-runbook-steps">
        {spec.steps.map((st, i) => (
          <li key={`${i}:${st.title}`} className={cn("oc-iui-runbook-step", st.danger && "is-danger")}>
            <div className="oc-iui-runbook-step-head">
              <span className="oc-iui-step-num" aria-hidden>
                {i + 1}
              </span>
              <span className="oc-iui-runbook-step-title">{st.title}</span>
              {st.danger && (
                <span className="oc-iui-runbook-danger">
                  <AlertTriangle size={12} aria-hidden />
                  变更操作
                </span>
              )}
              {!streaming && <SmallCopy getText={() => interpolateRunbookCommand(st.command, values)} label={`第 ${i + 1} 步命令`} idle="复制" />}
              {canRun && (
                <button
                  type="button"
                  className="oc-iui-text-btn"
                  data-testid={`runbook-run-step-${i}`}
                  disabled={!!busy}
                  onClick={() => {
                    const cmd = interpolateRunbookCommand(st.command, values);
                    sendUserText?.(`请执行操作步骤「${st.title}」：\n\`\`\`bash\n${cmd}\n\`\`\``);
                  }}
                >
                  <Play size={12} aria-hidden />
                  执行
                </button>
              )}
            </div>
            {st.detail && <p className="oc-iui-runbook-detail">{st.detail}</p>}
            <pre className="oc-iui-cmd-pre">
              <code>{renderCommand(st.command)}</code>
            </pre>
          </li>
        ))}
      </ol>
    </Frame>
  );
}

// ── 13. BrowserHandoff 云端浏览器人工接管卡（OCV5-816） ────────────────────────

function parseHandoffUrl(url: string): { isHttps: boolean; host: string; path: string } {
  try {
    const u = new URL(url);
    return {
      isHttps: u.protocol === "https:",
      host: u.host,
      path: `${u.pathname === "/" ? "" : u.pathname}${u.search}`,
    };
  } catch {
    return { isHttps: url.startsWith("https://"), host: url, path: "" };
  }
}

export function BrowserHandoffBlock({ spec, notes, streaming, readOnly, nested }: BlockProps<BrowserHandoffSpec>) {
  const { openLiveBrowser } = useArtifactInspect();
  const { sendUserText, busy, reason, sessionId } = useChatInteraction();
  const [opened, setOpened] = useState(false);
  const [sent, setSent] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const instanceId = useId();
  const handoffId = spec.decisionId || `bh:${instanceId}`;
  useSyncExternalStore(
    subscribeLiveBrowserHandback,
    getLiveBrowserHandbackVersion,
    getLiveBrowserHandbackVersion,
  );
  const matchedHandback = getLiveBrowserHandbackFor(sessionId ?? null, handoffId);
  const matchedPhase = getLiveBrowserHandoffPhaseFor(sessionId ?? null, handoffId);

  const parsedUrl = spec.url ? parseHandoffUrl(spec.url) : null;
  const handedBack = Boolean(matchedHandback);
  const effectiveSent = sent || Boolean(matchedHandback?.autoSent);

  // Secondary button auto-sends immediately: strictly send transparent user-visible copy,
  // never an unshown model-authored prompt. Custom `continue_prompt` is only prefilled into
  // Composer on browser handback so the user can review/edit before sending.
  const visibleContinueMessage = parsedUrl
    ? `我已完成 ${parsedUrl.host} 的浏览器操作，请继续。`
    : "我已完成云端浏览器操作，请继续。";
  const handbackDraft = spec.continue_prompt ?? visibleContinueMessage;
  const canTakeover = !readOnly && !streaming && Boolean(openLiveBrowser);
  const canContinue = !readOnly && !streaming && Boolean(sendUserText) && !busy && !effectiveSent && !continuing;
  const activePhase = matchedPhase?.phase ?? (opened ? "opening" : null);

  return (
    <Frame
      kind="browser_handoff"
      title={spec.title ?? "需要你接管云端浏览器"}
      subtitle={spec.subtitle ?? "云端浏览器与助手共享同一会话与登录态，完成验证后即可无缝交还"}
      notes={notes}
      streaming={streaming}
      nested={nested}
      copyText={() => v2ToMarkdown(spec)}
    >
      <div className="oc-iui-bh" data-testid="iui-browser-handoff" data-completed={handedBack ? "true" : "false"}>
        {handedBack && (
          <div
            className="inline-flex w-fit items-center gap-1.5 rounded-full bg-success-soft px-2.5 py-0.5 text-caption font-medium text-success"
            data-testid="iui-browser-handoff-completed"
          >
            <Check size={12} aria-hidden />
            已完成接管
          </div>
        )}
        {parsedUrl && (
          <div className="oc-iui-bh-url" title={spec.url}>
            <span className="oc-iui-bh-url-icon" aria-hidden>
              {parsedUrl.isHttps ? <Lock size={13} /> : <Globe size={13} />}
            </span>
            <span className="oc-iui-bh-url-text">
              <span className="oc-iui-bh-url-host">{parsedUrl.host}</span>
              {parsedUrl.path}
            </span>
          </div>
        )}
        <p className="oc-iui-bh-reason">
          <Inline text={spec.reason ?? "当前页面需要人工完成登录、二次验证或确认操作。点击下方按钮将为你放大云端浏览器并开启直接操控。"} />
        </p>
        <div className="oc-iui-bh-actions">
          <button
            type="button"
            className="oc-iui-btn is-primary"
            disabled={!canTakeover}
            data-testid="iui-browser-handoff-open"
            onClick={() => {
              if (!canTakeover) return;
              setOpened(true);
              notifyLiveBrowserHandoffPhase({
                sessionId: sessionId ?? null,
                handoffId,
                phase: "opening",
              });
              openLiveBrowser?.({
                takeover: true,
                expand: true,
                url: spec.url,
                continuePrompt: handbackDraft,
                handoffId,
                ...(spec.resume_when ? { resumeWhen: spec.resume_when } : {}),
              });
            }}
          >
            <Maximize2 size={14} aria-hidden />
            {handedBack ? "再次接管浏览器" : (spec.action_label ?? "放大并接管浏览器")}
          </button>
          <button
            type="button"
            className="oc-iui-btn"
            disabled={!canContinue}
            data-testid="iui-browser-handoff-continue"
            onClick={() => {
              if (!canContinue) return;
              if (!hasLiveBrowserHandbackHandler()) {
                setSent(true);
                sendUserText?.(visibleContinueMessage);
                return;
              }
              setContinuing(true);
              void requestLiveBrowserHandback({
                sessionId: sessionId ?? null,
                handoffId,
                continueMessage: visibleContinueMessage,
              })
                .then((res) => {
                  if (!res.handled && !res.blocked && !res.failed) {
                    setSent(true);
                    sendUserText?.(visibleContinueMessage);
                  }
                })
                .finally(() => {
                  setContinuing(false);
                });
            }}
          >
            <Check size={14} aria-hidden />
            {effectiveSent ? "已通知助手继续" : continuing ? "正在交还并继续…" : (spec.continue_label ?? "我已完成，继续任务")}
          </button>
        </div>
        {handedBack ? (
          <p className="oc-iui-bh-note" role="status">
            {effectiveSent
              ? "已完成接管并已通知助手继续任务。"
              : "已完成接管并交还浏览器控制权；如需继续任务请点击上方按钮。"}
          </p>
        ) : activePhase && !effectiveSent ? (
          <p className="oc-iui-bh-note" role="status" data-phase={activePhase}>
            {activePhase === "active"
              ? "实时浏览器已就绪，请完成操作后点击下方「我已完成，继续任务」或浏览器顶栏「完成并继续」。"
              : activePhase === "blocked"
                ? matchedPhase?.reason || "助手正在执行浏览器步骤，稍候即可在右侧接管操作。"
                : activePhase === "error"
                  ? `${matchedPhase?.reason ? `${matchedPhase.reason}，` : "打开实时浏览器失败，"}请重新点击上方按钮重试。`
                  : "正在为你打开实时浏览器…"}
          </p>
        ) : null}
        {!readOnly && !streaming && !openLiveBrowser && (
          <p className="oc-iui-bh-note">{chatInteractionUnavailableText(reason)}</p>
        )}
      </div>
    </Frame>
  );
}
