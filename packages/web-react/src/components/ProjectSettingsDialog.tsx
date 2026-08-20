import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { apiErrorMessage } from "../lib/api";
import type { ChatProject } from "../lib/types";
import { cn } from "../lib/utils";
import { Alert, Button, Field, Input, Modal, Textarea } from "./ui";

const NAME_MAX = 60;
const INSTRUCTIONS_MAX = 4000;

/** 项目色板：key 写入 ChatProject.color，dotClass 用设计 token 背景色。 */
export const PROJECT_COLORS: { key: string; label: string; dotClass: string }[] = [
  { key: "accent", label: "靛紫", dotClass: "bg-accent" },
  { key: "info", label: "蓝", dotClass: "bg-info" },
  { key: "success", label: "绿", dotClass: "bg-success" },
  { key: "warning", label: "琥珀", dotClass: "bg-warning" },
  { key: "danger", label: "红", dotClass: "bg-danger" },
  { key: "accent-strong", label: "深紫", dotClass: "bg-accent-strong" },
  { key: "primary", label: "墨", dotClass: "bg-primary" },
  { key: "muted", label: "灰", dotClass: "bg-muted" },
];

export function ProjectSettingsDialog(props: {
  open: boolean;
  project: ChatProject | null;
  onClose: () => void;
  onSave: (patch: {
    name?: string;
    color?: string | null;
    instructions?: string | null;
  }) => Promise<void>;
}): ReactElement | null {
  const { open, project, onClose, onSave } = props;
  const titleId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !project) return;
    setName(project.name);
    setColor(project.color ?? null);
    setInstructions(project.instructions ?? "");
    setError("");
    setSaving(false);
  }, [open, project]);

  if (!project) return null;

  const nameTrim = name.trim();
  const nameInvalid = nameTrim.length < 1 || nameTrim.length > NAME_MAX;
  const instructionsOver = instructions.length > INSTRUCTIONS_MAX;
  const canSave = !nameInvalid && !instructionsOver && !saving;

  const handleOpenChange = (next: boolean) => {
    if (!next && !saving) onClose();
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError("");
    try {
      await onSave({
        name: nameTrim,
        color,
        instructions: instructions.trim() === "" ? null : instructions,
      });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, "保存项目设置失败"));
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={handleOpenChange}
      title={<span id={titleId}>项目设置</span>}
      description="项目指令会在该项目下的会话里作为额外偏好生效，不会覆盖平台规则。"
      size="md"
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        nameRef.current?.focus();
      }}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={!canSave} loading={saving}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="名称"
          required
          error={
            name.length > 0 && nameInvalid
              ? `名称需为 1–${NAME_MAX} 个字`
              : undefined
          }
        >
          <Input
            ref={nameRef}
            value={name}
            maxLength={NAME_MAX + 8}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </Field>

        <Field label="颜色" hint="可选。无颜色时侧栏只显示名称。">
          <div role="radiogroup" aria-label="项目颜色" className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              role="radio"
              aria-checked={color === null}
              aria-label="无颜色"
              onClick={() => setColor(null)}
              className={cn(
                "flex size-8 items-center justify-center rounded-full border outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
                color === null ? "border-accent ring-2 ring-ring" : "border-border-control hover:border-border-strong",
              )}
            >
              <span className="size-4 rounded-full border border-dashed border-border-strong bg-surface" />
            </button>
            {PROJECT_COLORS.map((c) => (
              <button
                key={c.key}
                type="button"
                role="radio"
                aria-checked={color === c.key}
                aria-label={c.label}
                title={c.label}
                onClick={() => setColor(c.key)}
                className={cn(
                  "flex size-8 items-center justify-center rounded-full border outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
                  color === c.key ? "border-accent ring-2 ring-ring" : "border-transparent hover:border-border-strong",
                )}
              >
                <span className={cn("size-5 rounded-full", c.dotClass)} />
              </button>
            ))}
          </div>
        </Field>

        <Field
          label="自定义指令"
          hint="写入后，该项目下新建与已有会话都会带上这段偏好；平台安全与产品规则始终优先。"
          error={instructionsOver ? `最多 ${INSTRUCTIONS_MAX} 字` : undefined}
        >
          <Textarea
            value={instructions}
            rows={6}
            onChange={(e) => setInstructions(e.target.value)}
            aria-label="自定义指令"
          />
        </Field>
        <p
          className={cn(
            "text-caption tabular-nums",
            instructionsOver ? "text-danger" : "text-faint",
          )}
        >
          {instructions.length} / {INSTRUCTIONS_MAX}
        </p>

        {error ? (
          <Alert tone="danger" density="compact">
            {error}
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}
