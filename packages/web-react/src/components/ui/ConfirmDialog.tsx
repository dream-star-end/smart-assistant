/**
 * Promise 式确认/输入对话框原语 —— 取代散落各处的原生 window.confirm/prompt
 * (原生对话框与 Aurora 设计语言割裂、不可主题化、移动端体验差,且共 8 处各写各的)。
 *
 * 用法(hook 返回 [fn, element],element 挂在组件树任意处):
 *   const [confirm, confirmEl] = useConfirm();
 *   ... await confirm({ title: "删除该会话？", danger: true }) → boolean
 *   ... await confirm({ title: "切换模型？", altText: "直接切换" }) → true | false | "alt"
 *
 *   const [promptText, promptEl] = usePrompt();
 *   ... await promptText({ title: "重命名会话", initial: s.title }) → string | null
 *
 * 基于 Modal(Radix Dialog):焦点陷阱/Escape/aria 免费获得。Escape/遮罩关闭=取消。
 *
 * 初始焦点自己定(UI-SPEC §6 #29):Radix 默认聚焦第一个可聚焦元素 —— 标题行的 ×,
 * 重命名时焦点落在 ×、Ctrl+A 选中整页。确认框:危险操作聚焦「取消」(回车不误删),
 * 其余聚焦主按钮;输入框:聚焦并全选。
 */
import { type ReactNode, useCallback, useRef, useState } from "react";
import { Button } from "./Button";
import { Input } from "./Input";
import { Modal } from "./Modal";

export type ConfirmChoice = boolean | "alt";

const ZH_PUNCT: Record<string, string> = { ",": "，", "?": "？", "!": "！", ":": "：", ";": "；" };
/** 紧跟在汉字或中文右括号/引号后面的半角标点。数字、英文后的不动(12:30、a,b.txt)。 */
const HALF_PUNCT_AFTER_CJK = /([\u3400-\u9fff\uf900-\ufaff」』）》】])([,?!:;])/g;

/**
 * 对话框文案统一用中文标点(UI-SPEC §6 #22:「删除,不可恢复」中英标点混用)。
 * 调用方散在几十处,收在原语里一处做,只改字符串文案;ReactNode 正文原样渲染。
 */
export function zhPunct<T>(text: T): T {
  if (typeof text !== "string") return text;
  return text.replace(HALF_PUNCT_AFTER_CJK, (_, c: string, p: string) => c + ZH_PUNCT[p]) as T;
}

export type ConfirmOpts = {
  title: string;
  body?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** Optional third action (e.g. skip compact and switch immediately). */
  altText?: string;
  /** 危险操作(删除类):确认钮红色。 */
  danger?: boolean;
  confirmDisabled?: boolean;
};

export function useConfirm(): [(opts: ConfirmOpts) => Promise<ConfirmChoice>, ReactNode] {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null);
  const resolverRef = useRef<((v: ConfirmChoice) => void) | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback((o: ConfirmOpts) => {
    return new Promise<ConfirmChoice>((resolve) => {
      // 罕见重入(上一个未决时再开):先取消上一个,防 resolver 悬挂泄漏。
      resolverRef.current?.(false);
      resolverRef.current = resolve;
      setOpts(o);
    });
  }, []);

  const settle = (v: ConfirmChoice) => {
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
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        const target = opts?.danger || opts?.confirmDisabled ? cancelRef : confirmRef;
        target.current?.focus();
      }}
      title={zhPunct(opts?.title)}
      footer={
        <>
          <Button ref={cancelRef} variant="ghost" onClick={() => settle(false)}>
            {zhPunct(opts?.cancelText) ?? "取消"}
          </Button>
          {opts?.altText ? (
            <Button variant="secondary" disabled={opts.confirmDisabled} onClick={() => settle("alt")}>
              {zhPunct(opts.altText)}
            </Button>
          ) : null}
          <Button
            ref={confirmRef}
            variant={opts?.danger ? "danger" : "primary"}
            disabled={opts?.confirmDisabled}
            onClick={() => settle(true)}
          >
            {zhPunct(opts?.confirmText) ?? "确定"}
          </Button>
        </>
      }
    >
      {zhPunct(opts?.body) ?? null}
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
  const inputRef = useRef<HTMLInputElement>(null);

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
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }}
      title={zhPunct(opts?.title)}
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
      {zhPunct(opts?.body)}
      <Input
        ref={inputRef}
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
      />
    </Modal>
  );

  return [promptText, element];
}
