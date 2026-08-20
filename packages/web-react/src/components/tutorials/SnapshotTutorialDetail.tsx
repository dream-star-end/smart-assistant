import { ArrowLeft, Copy, ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import {
  HTML_EMBED_SANDBOX,
  artifactKind,
  communityTutorialShareUrl,
  deriveTutorialArtifacts,
  fetchSnapshotPageMessages,
  isSafeTutorialMediaUrl,
  snapshotMessagesFromUnknown,
  snapshotPageBlobUrls,
} from "../../lib/tutorialStudio";
import type { CommunityTutorialDetail, TutorialArtifact } from "../../lib/types";
import { Markdown } from "../Markdown";
import { MessageList } from "../MessageRenderer";
import { Alert, Badge, Button } from "../ui";

function snapshotChatMessages(item: CommunityTutorialDetail): ChatMessage[] {
  const snapshot = item.snapshot;
  if (!snapshot) return [];
  if (Array.isArray(snapshot.messages) && snapshot.messages.length > 0) {
    return snapshotMessagesFromUnknown(snapshot.messages);
  }
  if (Array.isArray(snapshot.inlinePages) && snapshot.inlinePages.length > 0) {
    return snapshotMessagesFromUnknown(snapshot.inlinePages);
  }
  return [];
}

export function SnapshotTutorialDetail({
  item,
  onBack,
}: {
  item: CommunityTutorialDetail;
  onBack: () => void;
}) {
  const inlineMessages = useMemo(() => snapshotChatMessages(item), [item]);
  const [pageMessages, setPageMessages] = useState<ChatMessage[]>([]);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageRetry, setPageRetry] = useState(0);
  const [copied, setCopied] = useState(false);
  const shareUrl = communityTutorialShareUrl(item.id);
  const artifacts = useMemo(() => deriveTutorialArtifacts(item), [item]);
  const messages = inlineMessages.length > 0 ? inlineMessages : pageMessages;
  const pageUrls = snapshotPageBlobUrls(item.snapshot);

  useEffect(() => {
    if (inlineMessages.length > 0 || pageUrls.length === 0) {
      setPageMessages([]);
      setPageError(null);
      setPageLoading(false);
      return;
    }
    let cancelled = false;
    setPageLoading(true);
    setPageError(null);
    void fetchSnapshotPageMessages(pageUrls)
      .then((loaded) => {
        if (cancelled) return;
        setPageMessages(loaded);
        setPageLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setPageMessages([]);
        setPageError("脱敏轨迹分页加载失败，请重试。不会假装当前没有轨迹。");
        setPageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item.snapshot, inlineMessages.length, pageRetry, pageUrls.join("|")]);

  const copyShare = () => {
    void navigator.clipboard?.writeText(shareUrl).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <article className="mx-auto mt-5 w-full max-w-5xl rounded-3xl border border-border bg-surface p-5 shadow-sm sm:p-8">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-meta text-muted hover:text-fg"
      >
        <ArrowLeft size={14} /> 返回探索教程
      </button>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Badge tone="accent">会话快照</Badge>
        <Badge tone="neutral">{item.category}</Badge>
        <span className="text-caption text-faint">
          {item.authorName} · {new Date(item.publishedAt).toLocaleDateString("zh-CN")}
        </span>
      </div>
      <h1 className="mt-3 text-heading font-bold leading-tight text-fg">{item.title}</h1>
      <p className="mt-3 text-body leading-6 text-muted">{item.summary}</p>
      <Alert tone="warning" className="mt-4" title="作者真实会话快照 / 未经平台三次复跑">
        这是作者一次真实会话的脱敏快照，不是平台三次独立复跑后的官方验证案例。
      </Alert>
      <div className="mt-4">
        <Button variant="secondary" size="sm" onClick={copyShare}>
          <Copy size={14} /> {copied ? "已复制分享链接" : "复制分享链接"}
        </Button>
      </div>

      {item.bodyMarkdown.trim() && (
        <div className="mt-7 border-t border-border pt-7">
          <h2 className="text-section font-semibold text-fg">作者说明</h2>
          <div className="mt-3">
            <Markdown readOnly blockImages>
              {item.bodyMarkdown}
            </Markdown>
          </div>
        </div>
      )}

      <section className="mt-7 border-t border-border pt-7">
        <h2 className="text-section font-semibold text-fg">脱敏会话轨迹</h2>
        <p className="mt-1 text-meta text-muted">只读回放，不会执行操作或加载外部页面。</p>
        {pageError ? (
          <Alert tone="danger" className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{pageError}</span>
              <Button variant="secondary" size="sm" onClick={() => setPageRetry((value) => value + 1)}>
                重试
              </Button>
            </div>
          </Alert>
        ) : pageLoading ? (
          <p className="mt-4 text-meta text-faint">正在按清单顺序加载脱敏轨迹…</p>
        ) : messages.length === 0 ? (
          <p className="mt-4 text-meta text-faint">没有可展示的公开轨迹。</p>
        ) : (
          <div className="mt-4 rounded-2xl border border-border bg-bg p-3">
            <MessageList
              messages={messages}
              sending={false}
              readOnly
              cb={{}}
              onRespondPermission={() => {}}
            />
          </div>
        )}
      </section>

      <section className="mt-7 border-t border-border pt-7">
        <h2 className="text-section font-semibold text-fg">成果</h2>
        {(item.artifacts ?? artifacts).length === 0 ? (
          <p className="mt-3 text-meta text-faint">这份快照没有附带成果。</p>
        ) : (
          <div className="mt-4 grid gap-4">
            {(item.artifacts ?? artifacts).map((artifact) => (
              <TutorialArtifactView key={`${artifact.sha256}-${artifact.name}`} artifact={artifact} />
            ))}
          </div>
        )}
      </section>
    </article>
  );
}

function TutorialArtifactView({ artifact }: { artifact: TutorialArtifact }) {
  const kind = artifactKind(artifact.mime);
  const safeEmbed = isSafeTutorialMediaUrl(artifact.embedUrl);
  const safeDownload = isSafeTutorialMediaUrl(artifact.downloadUrl);

  return (
    <article className="rounded-2xl border border-border bg-bg p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-body font-semibold text-fg">{artifact.name}</h3>
          <p className="text-caption text-faint">
            {artifact.mime} · {artifact.bytes} B
          </p>
        </div>
        {safeDownload && (
          <a
            href={artifact.downloadUrl!}
            className="text-meta font-medium text-accent hover:underline"
            download={artifact.name}
          >
            下载
          </a>
        )}
      </div>
      <div className="mt-3">
        {kind === "html" && safeEmbed ? (
          <iframe
            title={artifact.name}
            src={artifact.embedUrl!}
            sandbox={HTML_EMBED_SANDBOX}
            className="h-80 w-full rounded-xl border border-border bg-white"
          />
        ) : kind === "image" && safeEmbed ? (
          <img src={artifact.embedUrl!} alt={artifact.name} className="max-h-96 rounded-xl" />
        ) : kind === "audio" && safeEmbed ? (
          <audio controls src={artifact.embedUrl!} className="w-full">
            浏览器不支持音频播放
          </audio>
        ) : kind === "video" && safeEmbed ? (
          <video controls src={artifact.embedUrl!} className="max-h-96 w-full rounded-xl">
            浏览器不支持视频播放
          </video>
        ) : kind === "pdf" && safeEmbed ? (
          <object data={artifact.embedUrl!} type="application/pdf" className="h-80 w-full rounded-xl border border-border">
            <a href={artifact.embedUrl!}>打开 PDF</a>
          </object>
        ) : kind === "text" && safeDownload ? (
          <ReadonlyTextArtifact url={artifact.downloadUrl!} />
        ) : (
          <p className="inline-flex items-center gap-1.5 text-meta text-faint">
            <ExternalLink size={13} /> 外部链接未自动加载
          </p>
        )}
      </div>
    </article>
  );
}

function ReadonlyTextArtifact({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error("load failed");
        return res.text();
      })
      .then((value) => {
        if (!cancelled) setText(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (failed) return <p className="text-meta text-faint">文本成果暂时无法内嵌预览。</p>;
  if (text == null) return <p className="text-meta text-faint">正在加载文本成果…</p>;
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-sidebar p-3 text-meta text-muted">
      {text}
    </pre>
  );
}
