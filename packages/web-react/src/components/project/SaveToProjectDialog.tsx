import { useState } from "react";
import { useProjectScope } from "../../hooks/useProjectScope";
import { ApiError, apiErrorMessage } from "../../lib/api";
import {
  MEMORY_CONTENT_MAX,
  type SaveGuard,
  type SaveOutcome,
  firstLine,
  memorySlugFor,
  saveMessageAsProjectMemory,
  saveMessageAsProjectSkill,
  skillNameFor,
  trimForMemory,
  validateMemorySlug,
  validateSkillDescription,
  validateSkillName,
} from "../../lib/projectSave";
import type { AuthSession } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Alert, Button, Field, Input, Modal, Textarea, useToast } from "../ui";

/** App 在点「记住这条 / 存为项目技能」时生成；auth + epoch 是发起时的身份。 */
export type SaveToProjectRequest = {
  kind: "memory" | "skill";
  text: string;
  sessionId: string;
  boardProjectId: string;
  projectName: string;
  auth: AuthSession;
  epoch: number;
  nonce: number;
};

export type SaveToProjectDialogProps = {
  request: SaveToProjectRequest | null;
  onClose: () => void;
  /** 当前登录身份（App 的 authRef.current）。与 request.auth / epoch 不一致即视为换号。 */
  currentAuth: () => AuthSession;
  /** 与项目主页同一条「准备看板」路径；失败时自己提示，返回 false。 */
  prepareBoard: (boardProjectId: string) => Promise<boolean>;
  /** 打开管理中心的记忆 / 技能页（项目范围由本组件先切好）。 */
  onShowSurface: (surface: "memory" | "skills") => void;
};

/**
 * P5b：把一条回答存到所在项目。「记住这条」写项目记忆；「存为项目技能」先建用户技能，
 * 再加进项目技能清单。成功后 toast 带一个直达记忆 / 技能页的入口。
 */
export function SaveToProjectDialog(props: SaveToProjectDialogProps) {
  const { request, onClose, currentAuth, prepareBoard, onShowSurface } = props;
  const scope = useProjectScope();
  const toast = useToast();

  const identityChangedFor = (req: SaveToProjectRequest) => () =>
    currentAuth() !== req.auth || req.auth.snapshot().epoch !== req.epoch;

  const openSurface = async (req: SaveToProjectRequest, surface: "memory" | "skills") => {
    if (identityChangedFor(req)()) return;
    // 和项目主页一样：刷新后的列表里确实有这块看板才切范围，否则会落到「全部项目」。
    const boards = await scope.refreshWorkProjects();
    if (identityChangedFor(req)()) return;
    if (!boards.some((b) => b.id === req.boardProjectId)) {
      toast("项目看板暂时没有加载出来，请稍后再试", "error");
      return;
    }
    scope.setToken(req.boardProjectId);
    onShowSurface(surface);
  };

  const onOutcome = (req: SaveToProjectRequest, outcome: SaveOutcome): string | null => {
    switch (outcome.kind) {
      case "saved":
        onClose();
        if (req.kind === "memory") {
          toast("已记到项目记忆", "success", {
            actionLabel: "打开记忆",
            onAction: () => void openSurface(req, "memory"),
          });
        } else {
          toast("已存为项目技能", "success", {
            actionLabel: "打开技能",
            onAction: () => void openSurface(req, "skills"),
          });
        }
        return null;
      case "aborted":
        onClose();
        return null;
      case "overlay_conflict":
        onClose();
        toast("技能已保存，但没能加进项目：项目设置刚被别处修改，请到「技能」里手动加入", "error", {
          actionLabel: "打开技能",
          onAction: () => void openSurface(req, "skills"),
        });
        return null;
      case "board_unavailable":
        return "项目看板暂时打不开，请稍后再试";
      case "name_taken":
        return "name_taken";
    }
  };

  if (!request) return null;
  const guard: SaveGuard = {
    auth: request.auth,
    boardProjectId: request.boardProjectId,
    prepareBoard: () => prepareBoard(request.boardProjectId),
    identityChanged: identityChangedFor(request),
  };
  return request.kind === "memory" ? (
    <MemoryForm key={request.nonce} request={request} guard={guard} onClose={onClose} onOutcome={onOutcome} />
  ) : (
    <SkillForm key={request.nonce} request={request} guard={guard} onClose={onClose} onOutcome={onOutcome} />
  );
}

type FormProps = {
  request: SaveToProjectRequest;
  guard: SaveGuard;
  onClose: () => void;
  /** 处理结果；返回需要留在弹窗里的错误（"name_taken" 由技能表单自己翻译）。 */
  onOutcome: (req: SaveToProjectRequest, outcome: SaveOutcome) => string | null;
};

function MemoryForm({ request, guard, onClose, onOutcome }: FormProps) {
  const [slug, setSlug] = useState(() => memorySlugFor(request.text));
  const [content, setContent] = useState(() => trimForMemory(request.text));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slugError = validateMemorySlug(slug);
  const over = content.length > MEMORY_CONTENT_MAX;
  const canSave = !slugError && content.trim().length > 0 && !over && !saving;

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const outcome = await saveMessageAsProjectMemory(guard, {
        slug: slug.trim(),
        content: content.trim(),
        sessionId: request.sessionId,
      });
      const msg = onOutcome(request, outcome);
      if (msg) setError(msg);
    } catch (e) {
      setError(apiErrorMessage(e, "没有记住，请稍后再试"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o && !saving) onClose();
      }}
      title="记住这条"
      description={`存进「${request.projectName}」的项目记忆，之后这个项目里的会话都能用到。`}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!canSave} loading={saving}>
            记住
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="名称" required hint={`保存为 ${slug.trim() || "…"}.md；只能用英文字母、数字、- 和 _。`} error={slugError ?? undefined}>
          <Input value={slug} onChange={(e) => setSlug(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <Field
          label={
            <span className="flex items-center justify-between gap-2">
              <span>内容</span>
              <span className={cn("text-caption font-normal tabular-nums", over ? "text-danger" : "text-faint")}>
                {content.length} / {MEMORY_CONTENT_MAX}
              </span>
            </span>
          }
          hint="可以删掉不需要记住的部分。"
          error={over ? `最多 ${MEMORY_CONTENT_MAX} 字` : undefined}
        >
          <Textarea value={content} rows={10} onChange={(e) => setContent(e.target.value)} aria-label="记忆内容" />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Modal>
  );
}

function SkillForm({ request, guard, onClose, onOutcome }: FormProps) {
  const [name, setName] = useState(() => skillNameFor(request.text));
  const [description, setDescription] = useState(() => firstLine(request.text, 200));
  const [body, setBody] = useState(() => request.text.trim());
  const [nameTaken, setNameTaken] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameError = validateSkillName(name) ?? (nameTaken === name ? "已有同名技能，换一个名字" : null);
  const descriptionError = validateSkillDescription(description);
  const canSave = !nameError && !descriptionError && body.trim().length > 0 && !saving;

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const outcome = await saveMessageAsProjectSkill(guard, { name, description, body: body.trim() });
      const msg = onOutcome(request, outcome);
      if (msg === "name_taken") setNameTaken(name);
      else if (msg) setError(msg);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400 && /reserved/i.test(e.message)) {
        setError("这个技能名是平台保留的，换一个名字");
      } else {
        setError(apiErrorMessage(e, "没有保存成功，请稍后再试"));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o && !saving) onClose();
      }}
      title="存为项目技能"
      description={`存成一个技能，并加进「${request.projectName}」的项目技能。`}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!canSave} loading={saving}>
            保存
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="技能名" required hint="小写英文字母、数字和 -，例如 weekly-report。" error={nameError ?? undefined}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            maxLength={80}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="什么时候用" required hint="一句话说明，智能体靠它判断要不要用这个技能。" error={descriptionError ?? undefined}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="技能内容" error={body.trim() ? undefined : "请填写技能内容"}>
          <Textarea value={body} rows={10} onChange={(e) => setBody(e.target.value)} aria-label="技能内容" />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Modal>
  );
}
