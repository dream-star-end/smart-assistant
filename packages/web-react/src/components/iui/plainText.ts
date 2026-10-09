/**
 * Intelligent UI 组件的 Markdown 版本按需加载。
 *
 * 入口里用到它的地方(消息动作条的复制 / 朗读、会话导出)只引这个小模块,不静态引
 * toMarkdown(它带着 schema 和公式解析器,会进首屏预算)。不含 ```ui / ~~~ui 的文本原样返回、
 * 不触发加载;含的时候组件本身正由懒加载的 Markdown 渲染,转换器在同一批懒块里,几乎是现成的。
 */
import { useEffect, useState } from "react";

type ToMarkdown = (text: string) => string;

let loaded: ToMarkdown | null = null;
let loading: Promise<ToMarkdown> | null = null;

/** 与 uiFencesToMarkdown 的快速路径同一判定。 */
export function hasUiFence(text: string): boolean {
  return text.includes("```ui") || text.includes("~~~ui");
}

export function loadUiToMarkdown(): Promise<ToMarkdown> {
  loading ??= import("./toMarkdown").then(
    (m) => {
      const fn: ToMarkdown = (t) => m.uiFencesToMarkdown(t);
      loaded = fn;
      return fn;
    },
    (err: unknown) => {
      // 懒块加载失败(断网 / 发版换了 chunk 名):下次再试,不把失败缓存住。
      loading = null;
      throw err;
    },
  );
  return loading;
}

/** 同步取值:转换器还没加载到时返回原文。 */
export function uiPlainTextNow(text: string): string {
  if (!hasUiFence(text)) return text;
  return loaded ? loaded(text) : text;
}

/** 异步取值(导出用):等转换器加载;加载失败时退回原文,导出不因此失败。 */
export async function uiPlainText(text: string): Promise<string> {
  if (!hasUiFence(text)) return text;
  try {
    return (await loadUiToMarkdown())(text);
  } catch {
    return text;
  }
}

/** 组件里用:含组件块时触发加载,到了之后重渲染一次拿到 Markdown 版本。 */
export function useUiPlainText(text: string): string {
  const needs = hasUiFence(text);
  const [, setReady] = useState(0);
  useEffect(() => {
    if (!needs || loaded) return;
    let alive = true;
    loadUiToMarkdown().then(
      () => {
        if (alive) setReady((n) => n + 1);
      },
      () => {
        /* 留在原文;下次渲染会重试 */
      },
    );
    return () => {
      alive = false;
    };
  }, [needs]);
  return uiPlainTextNow(text);
}
