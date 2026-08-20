import { useEffect, useMemo, useState } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import { api, apiErrorMessage } from "../../lib/api";
import {
  TUTORIAL_STRIPPED_ROLE_LABELS,
  TUTORIAL_STRIPPED_ROLES,
  blobToBase64,
  inferTutorialArtifactMime,
  mediaSignPathForAsset,
  publicSnapshotMessages,
  sessionOutputAssets,
  tutorialArtifactGuardError,
  tutorialArtifactGuardMessage,
  tutorialPublishErrorMessage,
} from "../../lib/tutorialStudio";
import type {
  AuthSession,
  CommunityTutorialCategory,
  ProjectAsset,
  TutorialLeakReport,
} from "../../lib/types";
import { MessageList } from "../MessageRenderer";
import { Alert, Button, Field, Input, Modal, Select, Textarea } from "../ui";

const CATEGORY_OPTIONS = [
  { value: "research", label: "科研" },
  { value: "coding", label: "编码" },
  { value: "general", label: "通用" },
];

export function PublishFromSessionDialog({
  open,
  onOpenChange,
  auth,
  sessionId,
  sessionTitle,
  projectId,
  messages,
  onSubmitted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  auth: AuthSession;
  sessionId: string;
  sessionTitle: string;
  projectId?: string | null;
  messages: ChatMessage[];
  onSubmitted: (leakReport?: TutorialLeakReport | null) => void;
}) {
  const publicMessages = useMemo(() => publicSnapshotMessages(messages), [messages]);
  const [title, setTitle] = useState(sessionTitle.trim() || "");
  const [summary, setSummary] = useState("");
  const [category, setCategory] = useState<CommunityTutorialCategory>("general");
  const [bodyMarkdown, setBodyMarkdown] = useState("");
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [assetError, setAssetError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(sessionTitle.trim() || "");
    setSummary("");
    setCategory("general");
    setBodyMarkdown("");
    setSelected({});
    setAssetError(null);
    setError(null);
    let cancelled = false;
    void api
      .listProjectAssets(auth, projectId)
      .then((list) => {
        if (!cancelled) setAssets(sessionOutputAssets(list, sessionId));
      })
      .catch((cause) => {
        if (!cancelled) setAssetError(apiErrorMessage(cause, "加载会话成果失败"));
      });
    return () => {
      cancelled = true;
    };
  }, [open, auth, projectId, sessionId, sessionTitle]);

  const toggleAsset = (asset: ProjectAsset, checked: boolean) => {
    const mime = inferTutorialArtifactMime(asset);
    const bytes = asset.sizeBytes ?? 0;
    const currentlySelected = assets.filter((item) => selected[item.id] && item.id !== asset.id);
    const selectedBytes = currentlySelected.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
    if (checked) {
      const guard = tutorialArtifactGuardError(mime, bytes, {
        selectedBytes,
        selectedCount: currentlySelected.length,
      });
      if (guard) {
        setAssetError(tutorialArtifactGuardMessage(guard));
        return;
      }
    }
    setAssetError(null);
    setSelected((current) => ({ ...current, [asset.id]: checked }));
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const chosen = assets.filter((asset) => selected[asset.id]);
      const selectedBytes = chosen.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
      for (const [index, asset] of chosen.entries()) {
        const guard = tutorialArtifactGuardError(inferTutorialArtifactMime(asset), asset.sizeBytes ?? 0, {
          selectedBytes: selectedBytes - (asset.sizeBytes ?? 0),
          selectedCount: index,
        });
        if (guard) throw new Error(tutorialArtifactGuardMessage(guard));
      }
      const packed: Array<{ name: string; mimeType: string; contentBase64: string }> = [];
      let packedBytes = 0;
      for (const asset of chosen) {
        const path = mediaSignPathForAsset(asset);
        if (!path) throw new Error(`成果「${asset.name}」没有可读取路径`);
        const signed = await api.mediaSign(auth, [path]);
        const signedUrl = signed.urls[path];
        if (!signedUrl) throw new Error(`成果「${asset.name}」无法签名读取`);
        const blob = await api.fetchSignedMedia(signedUrl);
        const mime = inferTutorialArtifactMime({ name: asset.name, mime: asset.mime || blob.type });
        const guard = tutorialArtifactGuardError(mime, blob.size, {
          selectedBytes: packedBytes,
          selectedCount: packed.length,
        });
        if (guard) throw new Error(tutorialArtifactGuardMessage(guard));
        packed.push({
          name: asset.name,
          mimeType: mime,
          contentBase64: await blobToBase64(blob),
        });
        packedBytes += blob.size;
      }
      const result = await api.submitTutorialSnapshot(auth, {
        sourceSessionId: sessionId,
        title: title.trim(),
        summary: summary.trim(),
        category,
        bodyMarkdown: bodyMarkdown.trim(),
        selectedArtifacts: packed,
      });
      onSubmitted(result.leakReport);
      onOpenChange(false);
    } catch (cause) {
      setError(tutorialPublishErrorMessage(cause, "发布快照失败"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title="从当前会话生成教程"
      description="会做隐私扫描并剥离内部角色，提交后进入「我的发布」等待审核。"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={submitting}
            disabled={!title.trim() || summary.trim().length < 10 || publicMessages.length === 0}
            onClick={() => void submit()}
          >
            提交快照审核
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <div className="grid gap-5">
        <Field label="标题" required hint={`${title.length}/100`}>
          <Input
            value={title}
            maxLength={100}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="给这次真实会话起一个可复用的标题"
          />
        </Field>
        <Field label="摘要" required hint={`${summary.length}/280`}>
          <Textarea
            value={summary}
            maxLength={280}
            rows={3}
            onChange={(event) => setSummary(event.target.value)}
            placeholder="说明适合谁、能看到什么过程、能拿走什么成果"
          />
        </Field>
        <Field label="分类" required>
          <Select
            value={category}
            onValueChange={(value) => setCategory(value as CommunityTutorialCategory)}
            options={CATEGORY_OPTIONS}
          />
        </Field>
        <Field label="补充说明（Markdown）" hint="可选；公开页仍按只读 Markdown 渲染，不会执行 htmlpreview">
          <Textarea
            value={bodyMarkdown}
            rows={6}
            className="font-mono"
            onChange={(event) => setBodyMarkdown(event.target.value)}
            placeholder="写清任务背景、验收方式和注意事项"
          />
        </Field>

        <section className="rounded-2xl border border-border bg-sidebar p-4">
          <h3 className="text-section font-semibold text-fg">隐私扫描</h3>
          <p className="mt-1 text-meta text-muted">
            提交后由服务端再做一次脱敏。前端会先去掉内部角色，并提示你不要勾选含密钥、账号或私人材料的成果。
          </p>
          <p className="mt-3 text-meta font-medium text-fg">会剥离的内部角色</p>
          <ul className="mt-2 grid gap-1.5 text-meta text-muted">
            {TUTORIAL_STRIPPED_ROLES.map((role) => (
              <li key={role}>
                <code className="text-fg">{role}</code>
                {" — "}
                {TUTORIAL_STRIPPED_ROLE_LABELS[role]}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="text-section font-semibold text-fg">轨迹预览</h3>
          <p className="mt-1 text-meta text-muted">
            只读展示脱敏后的公开角色，共 {publicMessages.length} 条；内部角色不会进入教程。
          </p>
          <div className="mt-3 max-h-72 overflow-y-auto rounded-2xl border border-border bg-bg p-3">
            {publicMessages.length === 0 ? (
              <p className="text-meta text-faint">剥离内部角色后没有可公开的消息。</p>
            ) : (
              <MessageList
                messages={publicMessages}
                sending={false}
                readOnly
                cb={{}}
                onRespondPermission={() => {}}
              />
            )}
          </div>
        </section>

        <section>
          <h3 className="text-section font-semibold text-fg">会话成果</h3>
          <p className="mt-1 text-meta text-muted">
            仅列出当前会话的 output 成果，默认全不勾选。SVG 禁止；单件 8MB、合计 32MB。
          </p>
          {assetError && (
            <Alert tone="warning" className="mt-3">
              {assetError}
            </Alert>
          )}
          {assets.length === 0 ? (
            <p className="mt-3 text-meta text-faint">当前会话没有可勾选的成果。</p>
          ) : (
            <ul className="mt-3 grid gap-2">
              {assets.map((asset) => {
                const mime = inferTutorialArtifactMime(asset);
                return (
                  <li key={asset.id}>
                    <label className="flex items-start gap-3 rounded-xl border border-border bg-surface px-3 py-3">
                      <input
                        type="checkbox"
                        checked={!!selected[asset.id]}
                        onChange={(event) => toggleAsset(asset, event.target.checked)}
                        aria-label={`勾选成果 ${asset.name}`}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-body font-medium text-fg">{asset.name}</span>
                        <span className="mt-0.5 block text-caption text-faint">
                          {mime || "未知类型"} · {asset.sizeBytes ?? 0} B
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}
