/**
 * Promise 式确认/输入对话框原语 —— 取代散落各处的原生 window.confirm/prompt
 * (原生对话框与 Aurora 设计语言割裂、不可主题化、移动端体验差,且共 8 处各写各的)。
 *
 * 用法(hook 返回 [fn, element],element 挂在组件树任意处):
 *   const [confirm, confirmEl] = useConfirm();
 *   ... await confirm({ title: "删除该会话?", danger: true }) → boolean
 *
 *   const [promptText, promptEl] = usePrompt();
 *   ... await promptText({ title: "重命名会话", initial: s.title }) → string | null
 *
 * 基于 Modal(Radix Dialog):焦点陷阱/Escape/aria 免费获得。Escape/遮罩关闭=取消。
 */
import { type ReactNode, useCallback, useRef, useState } from "react";
import { Button } from "./Button";
import { Input } from "./Input";
import { Modal } from "./Modal";

type ConfirmOpts = {
  title: string;
  body?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作(删除类):确认钮红色。 */
  danger?: boolean;
};

export function useConfirm(): [(opts: ConfirmOpts) => Promise<boolean>, ReactNode] {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null);
  const resolverRef = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((o: ConfirmOpts) => {
    return new Promise<boolean>((resolve) => {
      // 罕见重入(上一个未决时再开):先取消上一个,防 resolver 悬挂泄漏。
      resolverRef.current?.(false);
      resolverRef.current = resolve;
      setOpts(o);
    });
  }, []);

  const settle = (v: boolean) => {
    resolverRef.current?.(v);
    resolverRef.current = null;
    setOpts(null);
  };

  const element = (
    <Modal
      open={opts !== null}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
      title={opts?.title}
      footer={
        <>
          <Button variant="ghost" onClick={() => settle(false)}>
            {opts?.cancelText ?? "取消"}
          </Button>
          <Button variant={opts?.danger ? "danger" : "primary"} onClick={() => settle(true)}>
            {opts?.confirmText ?? "确定"}
          </Button>
        </>
      }
    >
      {opts?.body ?? null}
    </Modal>
  );

  return [confirm, element];
}

type PromptOpts = {
  title: string;
  body?: ReactNode;
  initial?: string;
  placeholder?: string;
  confirmText?: string;
  maxLength?: number;
};

export function usePrompt(): [(opts: PromptOpts) => Promise<string | null>, ReactNode] {
  const [opts, setOpts] = useState<PromptOpts | null>(null);
  const [value, setValue] = useState("");
  const resolverRef = useRef<((v: string | null) => void) | null>(null);

  const promptText = useCallback((o: PromptOpts) => {
    return new Promise<string | null>((resolve) => {
      resolverRef.current?.(null);
      resolverRef.current = resolve;
      setValue(o.initial ?? "");
      setOpts(o);
    });
  }, []);

  const settle = (v: string | null) => {
    resolverRef.current?.(v);
    resolverRef.current = null;
    setOpts(null);
  };

  const submit = () => {
    const t = value.trim();
    settle(t.length > 0 ? t : null);
  };

  const element = (
    <Modal
      open={opts !== null}
      onOpenChange={(open) => {
        if (!open) settle(null);
      }}
      title={opts?.title}
      footer={
        <>
          <Button variant="ghost" onClick={() => settle(null)}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={value.trim().length === 0}>
            {opts?.confirmText ?? "确定"}
          </Button>
        </>
      }
    >
      {opts?.body}
      <Input
        value={value}
        maxLength={opts?.maxLength ?? 120}
        placeholder={opts?.placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        // biome-ignore lint/a11y/noAutofocus: 输入对话框打开即聚焦是预期交互
        autoFocus
      />
    </Modal>
  );

  return [promptText, element];
}
