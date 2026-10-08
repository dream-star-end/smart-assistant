import { CalendarClock } from "lucide-react";
import { useState } from "react";
import { AuthEpochStaleError, api, apiErrorMessage } from "../../lib/api";
import type { AuthSession } from "../../lib/types";
import { Alert, Button, Chip, Field, Modal, Textarea, useToast } from "../ui";
import { SCHEDULED_RECIPES, type ScheduledRecipe } from "./projectHomeModel";

/** 定时任务结果的去处：与定时任务页新建表单的默认一致。 */
const DELIVER = "webchat";

export type ScheduledRecipeChipsProps = {
  boardProjectId: string;
  authSession: AuthSession;
  /** 确保项目看板已在容器里建好；失败时自己提示，返回 false。 */
  onPrepareBoard: () => Promise<boolean>;
  /** 按本项目的看板范围打开定时任务页（项目主页的 useSurfaceOpener）。 */
  onOpenCron: () => void;
};

/**
 * P5c：项目主页上的定时快捷任务。点一下先确认（时间说人话、指令可改），再准备看板、
 * 建一个固定在本项目看板上的定时任务。这个项目里已经有同名的就直接说，不重复建。
 */
export function ScheduledRecipeChips(props: ScheduledRecipeChipsProps) {
  const [picked, setPicked] = useState<{ recipe: ScheduledRecipe; nonce: number } | null>(null);
  return (
    <>
      {SCHEDULED_RECIPES.map((r) => (
        <Chip key={r.key} onClick={() => setPicked({ recipe: r, nonce: Date.now() })} title={`定时：${r.when}`}>
          <CalendarClock size={13} aria-hidden />
          {r.label}
        </Chip>
      ))}
      {picked && (
        <ConfirmScheduledRecipe key={picked.nonce} recipe={picked.recipe} {...props} onClose={() => setPicked(null)} />
      )}
    </>
  );
}

function ConfirmScheduledRecipe({
  recipe,
  boardProjectId,
  authSession,
  onPrepareBoard,
  onOpenCron,
  onClose,
}: ScheduledRecipeChipsProps & { recipe: ScheduledRecipe; onClose: () => void }) {
  const toast = useToast();
  const [prompt, setPrompt] = useState<string>(recipe.prompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 绑定点开确认时的身份：中途换号/登出就停，不把任务建进另一个账号。
  const [startEpoch] = useState(() => authSession.snapshot().epoch);
  const identityChanged = () => authSession.snapshot().epoch !== startEpoch;

  const submit = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (identityChanged()) return onClose();
      if (!(await onPrepareBoard())) {
        setError("项目看板暂时打不开，请稍后再试");
        return;
      }
      if (identityChanged()) return onClose();
      const jobs = await api.listCron(authSession, { boardProjectId });
      if (identityChanged()) return onClose();
      // listCron 已按看板过滤（服务端 filterCronJobsForBoard），这里只比标签。
      if (jobs.some((j) => (j.label ?? "").trim() === recipe.label)) {
        onClose();
        toast(`这个项目已经有「${recipe.label}」定时任务了，没有重复创建`, "info", {
          actionLabel: "打开定时任务",
          onAction: onOpenCron,
        });
        return;
      }
      await api.createCron(authSession, {
        schedule: recipe.schedule,
        prompt: text,
        label: recipe.label,
        deliver: DELIVER,
        // 服务端缺省是一次性任务；这里要的是重复执行。
        oneshot: false,
        projectMode: "fixed",
        boardProjectId,
      });
      if (identityChanged()) return onClose();
      onClose();
      toast("已创建定时任务", "success", { actionLabel: "打开定时任务", onAction: onOpenCron });
    } catch (e) {
      if (e instanceof AuthEpochStaleError || identityChanged()) return onClose();
      setError(apiErrorMessage(e, "创建失败，请稍后再试"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      title={recipe.label}
      description="会在这个项目里定时运行，结果作为一条新消息出现在网页对话里。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!prompt.trim()} loading={busy}>
            创建定时任务
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
        <div className="flex flex-col gap-1">
          <span className="text-meta text-muted">什么时候</span>
          <span className="text-body text-fg" data-testid="scheduled-recipe-when">
            {recipe.when}
          </span>
        </div>
        <Field label="要做什么" error={prompt.trim() ? undefined : "请填写要做什么"}>
          <Textarea value={prompt} rows={5} onChange={(e) => setPrompt(e.target.value)} aria-label="定时任务指令" />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Modal>
  );
}
