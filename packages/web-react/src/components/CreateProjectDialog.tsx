import { FileText, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { PROJECT_COLORS } from "../lib/projectColors";
import { cn } from "../lib/utils";
import { Button, Field, IconButton, Input, Modal, Textarea } from "./ui";

const NAME_MAX = 60;
const INSTRUCTIONS_MAX = 4000;
const FILES_MAX = 20;

export interface CreateProjectSubmit {
  name: string;
  instructions: string;
  color: string | null;
  files: File[];
}

/**
 * 一步新建项目:名称、项目指令、颜色、文件在同一个对话框里填完。
 * `fromSessionTitle` 有值时是「从此会话创建项目」:名称预填会话标题,创建后该会话移进新项目。
 * 真正的创建/上传/移动由调用方完成;这里只收集输入、展示进度与错误。
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
  fromSessionTitle,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fromSessionTitle?: string | null;
  onSubmit: (input: CreateProjectSubmit) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const fileInputId = useId();

  useEffect(() => {
    if (!open) return;
    setName((fromSessionTitle ?? "").slice(0, NAME_MAX));
    setInstructions("");
    setColor(null);
    setFiles([]);
    setSaving(false);
  }, [open, fromSessionTitle]);

  const nameTrim = name.trim();
  const nameInvalid = nameTrim.length < 1 || nameTrim.length > NAME_MAX;
  const instructionsOver = instructions.length > INSTRUCTIONS_MAX;
  const canSave = !nameInvalid && !instructionsOver && !saving;

  const addFiles = (incoming: File[]) => {
    setFiles((cur) => {
      const seen = new Set(cur.map((f) => `${f.name}:${f.size}`));
      const next = [...cur];
      for (const f of incoming) {
        if (next.length >= FILES_MAX) break;
        const key = `${f.name}:${f.size}`;
        if (!seen.has(key)) {
          seen.add(key);
          next.push(f);
        }
      }
      return next;
    });
  };

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const ok = await onSubmit({ name: nameTrim, instructions: instructions.trim(), color, files });
      if (ok) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!saving) onOpenChange(o);
      }}
      title={fromSessionTitle != null ? "从此会话创建项目" : "新建项目"}
      description={
        fromSessionTitle != null
          ? "创建后，这条会话会移进新项目。"
          : "项目里的会话会共用这里的指令和文件。都可以以后再改。"
      }
      size="lg"
      data-product-feature="create-project"
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        nameRef.current?.focus();
      }}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!canSave} loading={saving}>
            {fromSessionTitle != null ? "创建并移入" : "创建并开始"}
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
        <Field
          label="名称"
          required
          error={name.length > 0 && nameInvalid ? `名称需为 1–${NAME_MAX} 个字` : undefined}
        >
          <Input
            ref={nameRef}
            value={name}
            maxLength={NAME_MAX + 8}
            placeholder="例如：博士论文第三章"
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </Field>

        <Field
          label={
            <span className="flex items-center justify-between gap-2">
              <span>项目指令（可选）</span>
              <span className={cn("text-caption font-normal tabular-nums", instructionsOver ? "text-danger" : "text-faint")}>
                {instructions.length} / {INSTRUCTIONS_MAX}
              </span>
            </span>
          }
          hint="这个项目里的所有会话都会遵守；平台安全与产品规则始终优先。"
          error={instructionsOver ? `最多 ${INSTRUCTIONS_MAX} 字` : undefined}
        >
          <Textarea
            value={instructions}
            rows={4}
            placeholder="例如：用学术中文写作；引用格式用 GB/T 7714；不确定的结论标注「待核实」。"
            onChange={(e) => setInstructions(e.target.value)}
            aria-label="项目指令"
          />
        </Field>

        <Field label="文件（可选）" hint={`拖进来或点选，最多 ${FILES_MAX} 个。创建后会作为项目文件，智能体可以读取。`}>
          <div>
            <label
              htmlFor={fileInputId}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                addFiles(Array.from(e.dataTransfer.files));
              }}
              className={cn(
                "flex min-h-16 cursor-pointer items-center justify-center rounded-lg border border-dashed px-3 py-3 text-center text-meta text-muted transition-colors hover:border-border-strong hover:bg-hover",
                dragOver ? "border-accent bg-accent-soft" : "border-border-control",
              )}
            >
              点击或拖拽文件到这里
            </label>
            <input
              id={fileInputId}
              type="file"
              multiple
              className="sr-only"
              aria-label="选择项目文件"
              onChange={(e) => {
                addFiles(Array.from(e.currentTarget.files ?? []));
                e.currentTarget.value = "";
              }}
            />
            {files.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1" aria-label="待上传文件">
                {files.map((f) => (
                  <li key={`${f.name}:${f.size}`} className="flex items-center gap-2 rounded-md bg-surface px-2 py-1 text-meta">
                    <FileText size={14} aria-hidden className="shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    <IconButton
                      size="sm"
                      aria-label={`移除 ${f.name}`}
                      onClick={() => setFiles((cur) => cur.filter((x) => x !== f))}
                    >
                      <X size={14} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Field>

        <Field label="颜色（可选）">
          <div role="radiogroup" aria-label="项目颜色" className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              role="radio"
              aria-checked={color === null}
              aria-label="无颜色"
              title="无颜色"
              onClick={() => setColor(null)}
              className={cn(
                "flex size-8 items-center justify-center rounded-full border outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:size-11",
                color === null ? "border-accent ring-2 ring-ring" : "border-border-control hover:border-border-strong",
              )}
            >
              <span className="size-4 rounded-full border border-dashed border-muted bg-surface" />
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
                  "flex size-8 items-center justify-center rounded-full border outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:size-11",
                  color === c.key ? "border-accent ring-2 ring-ring" : "border-transparent hover:border-border-strong",
                )}
              >
                <span className={cn("size-5 rounded-full", c.dotClass)} />
              </button>
            ))}
          </div>
        </Field>
        <button type="submit" className="hidden" tabIndex={-1} aria-hidden />
      </form>
    </Modal>
  );
}
