import { Copy, Download, FileDown, ImageIcon, Share2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { saveBlob } from "../lib/chat/download";
import type { ChatMessage } from "../lib/chat/model";
import {
  prepareShareMessages,
  renderShareCard,
  type ShareRange,
  selectShareMessages,
  shareImageFilename,
  shareText,
} from "../lib/chat/shareCard";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Spinner } from "./ui/Spinner";
import { useToast } from "./ui/Toast";

const RANGE_OPTIONS: { value: ShareRange; label: string }[] = [
  { value: "last", label: "最近一轮" },
  { value: "last3", label: "最近三轮" },
  { value: "all", label: "全部" },
];

type Card =
  | { state: "rendering" }
  | { state: "empty" }
  | { state: "ready"; blob: Blob; url: string; text: string }
  | { state: "error"; text: string };

function canShareFiles(file: File): boolean {
  try {
    return typeof navigator !== "undefined" && typeof navigator.share === "function" && !!navigator.canShare?.({ files: [file] });
  } catch {
    return false;
  }
}

function canCopyImage(): boolean {
  return typeof ClipboardItem !== "undefined" && typeof navigator !== "undefined" && typeof navigator.clipboard?.write === "function";
}

// 微信 / QQ / 微博 / 钉钉 / 飞书 / 支付宝 / 百度 App 的内置浏览器:下载 blob、系统分享、剪贴板图片都不可用,
// 只能长按图片保存或转发(OCV5-371)。
const IN_APP_UA = /MicroMessenger|\bQQ\/|Weibo|DingTalk|Lark|Feishu|AlipayClient|baiduboxapp/i;

/** 分享环境:是否 App 内置浏览器、是否触屏(决定系统分享和长按提示)。 */
export function shareEnv(): { inApp: boolean; touch: boolean } {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  let touch = false;
  try {
    touch = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  } catch {
    touch = false;
  }
  return { inApp: IN_APP_UA.test(ua), touch };
}

/** 预览用 data: URL:内置浏览器长按 blob: 图片常常存不下来,data: 可以。 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * 分享会话(OCV5-369):把会话画成一张长图,配一段文字版,可系统分享 / 保存 / 复制。
 * 打开时对消息拍一次快照,流式更新不会让预览反复重画。
 * 动作按环境取舍(OCV5-371):触屏给系统分享;App 内置浏览器只留长按图片和复制文字。
 */
export function ShareDialog({
  open,
  onOpenChange,
  messages,
  sending,
  title,
  agentName,
  onExportMarkdown,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messages: readonly ChatMessage[];
  /** 会话正在生成:进行中那一轮的回答不收。 */
  sending: boolean;
  title: string | null | undefined;
  agentName: string;
  /** 原「导出会话」Markdown 下载,保留为次要入口。 */
  onExportMarkdown?: () => void | Promise<void>;
}) {
  const toast = useToast();
  const env = useMemo(shareEnv, []);
  const [range, setRange] = useState<ShareRange>("last");
  const [card, setCard] = useState<Card>({ state: "rendering" });
  // 打开时的快照:逐行浅拷贝(消息数组和行对象会被就地更新),与同一时刻的 sending 一起冻结;
  // 关闭再打开才取新内容。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 有意只在 open 翻转时取快照
  const snapshot = useMemo(() => ({ messages: messages.map((m) => ({ ...m })), sending }), [open]);
  const picked = useMemo(
    () => selectShareMessages(snapshot.messages, range, snapshot.sending),
    [snapshot, range],
  );
  const filename = shareImageFilename(title);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    if (picked.length === 0) {
      setCard({ state: "empty" });
      return;
    }
    setCard({ state: "rendering" });
    void (async () => {
      const prepared = await prepareShareMessages(picked);
      const text = shareText(title, agentName, prepared);
      try {
        const { blob } = await renderShareCard({ title, agentName, messages: prepared, now: new Date() });
        const url = await blobToDataUrl(blob);
        if (!alive) return;
        setCard({ state: "ready", blob, url, text });
      } catch {
        if (alive) setCard({ state: "error", text });
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, picked, title, agentName]);

  const file = card.state === "ready" ? new File([card.blob], filename, { type: "image/png" }) : null;
  // 桌面上系统分享面板很少用来发图,保存 / 复制更直接;只在触屏上提供。
  const shareable = file && env.touch && !env.inApp ? canShareFiles(file) : false;
  const imageActions = !env.inApp;
  const text = card.state === "ready" || card.state === "error" ? card.text : "";
  const liveTurnSkipped = snapshot.sending && picked.length > 0 && picked[picked.length - 1].role === "user";

  const share = async () => {
    if (!file) return;
    try {
      await navigator.share({ files: [file], title: (title ?? "").trim() || "新对话" });
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") toast("系统分享没有成功，可以先保存图片再发送", "error");
    }
  };
  const save = () => {
    if (card.state !== "ready") return;
    saveBlob(card.blob, filename);
    toast("图片已保存", "success");
  };
  const copyImage = async () => {
    if (card.state !== "ready") return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": card.blob })]);
      toast("图片已复制，可直接粘贴发送", "success");
    } catch {
      toast("复制图片失败，请改用保存图片", "error");
    }
  };
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast("文字已复制", "success");
    } catch {
      toast("复制失败，请手动选中文本复制", "error");
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="分享会话"
      description="生成一张长图，发到微信、群聊或朋友圈都能直接看。只包含提问和最终回答，不含工具与思考过程。"
      size="md"
      mobile="sheet"
      footer={
        <>
          <Button variant="secondary" onClick={() => void copyText()} disabled={!text}>
            <Copy size={16} />
            复制文字
          </Button>
          {imageActions && canCopyImage() && (
            <Button variant="secondary" onClick={() => void copyImage()} disabled={card.state !== "ready"}>
              <ImageIcon size={16} />
              复制图片
            </Button>
          )}
          {imageActions && (
            <Button variant={shareable ? "secondary" : "primary"} onClick={save} disabled={card.state !== "ready"}>
              <Download size={16} />
              保存图片
            </Button>
          )}
          {shareable && (
            <Button variant="primary" onClick={() => void share()}>
              <Share2 size={16} />
              分享…
            </Button>
          )}
        </>
      }
    >
      <div data-share-body className="flex flex-col gap-3">
        <SegmentedControl aria-label="分享范围" size="sm" value={range} onValueChange={setRange} options={RANGE_OPTIONS} />
        {liveTurnSkipped && <p className="text-meta text-muted">这一轮还在生成，分享内容不含进行中的回答。</p>}
        {env.inApp && card.state === "ready" && (
          <p data-share-hint className="rounded-md bg-hover px-3 py-2 text-center text-body font-medium text-fg">
            {env.touch ? "长按下方图片，选择「保存图片」或「发送给朋友」" : "在图片上点右键，可以另存或复制"}
          </p>
        )}
        <div
          data-share-preview
          className="flex max-h-[min(55dvh,32rem)] min-h-40 justify-center overflow-y-auto rounded-lg border border-border bg-hover p-3"
        >
          {card.state === "rendering" && (
            <div className="flex items-center gap-2 self-center text-meta text-muted">
              <Spinner size={14} />
              正在生成长图…
            </div>
          )}
          {card.state === "empty" && <p className="self-center text-meta text-muted">这个会话还没有可以分享的内容。</p>}
          {card.state === "error" && (
            <p className="self-center text-center text-meta text-muted">当前浏览器无法生成图片，可以复制文字分享。</p>
          )}
          {card.state === "ready" && (
            <img src={card.url} alt="分享长图预览" className="h-auto w-full max-w-sm self-start rounded-md shadow-soft" />
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="text-meta text-muted">{env.touch && !env.inApp && card.state === "ready" ? "也可以长按图片直接保存或转发。" : ""}</p>
          {onExportMarkdown && (
            <button
              type="button"
              onClick={() => void onExportMarkdown()}
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1 text-meta text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
            >
              <FileDown size={14} />
              导出 Markdown
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
