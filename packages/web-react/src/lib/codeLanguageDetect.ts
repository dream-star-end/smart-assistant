/**
 * OCV5-422: 无语言标注代码块的语言探测,从渲染路径里拆出来。
 *
 * 探测要把候选语法逐个完整高亮一遍比 relevance(与 lowlight.highlightAuto 同一规则:按候选顺序,严格更高才换)。
 * 手机上一个 60 行的块就要 1–2 秒,以前在 Markdown 渲染里同步做:流式结束、重开会话时主线程一卡就是一两秒。
 * 现在:
 * - 结果按代码原文缓存(语言名或 null = 都不像),同一段代码只探测一次;
 * - 小块(≤ SYNC_DETECT_MAX_CHARS)仍在渲染时同步探测,不会先白后彩;
 * - 大块交给 detectCodeLanguageLater:只比开头约 3KB(DETECT_SAMPLE_CHARS),每个宏任务只跑一种语法,中间把
 *   主线程让给输入和绘制,跑完由调用方重渲一次上色。
 * 用的是独立的 highlight.js 实例,注册与 lowlight common 相同的候选语法及其嵌入语法(graphql、ruby),
 * relevance 与 rehype-highlight 自带探测一致。
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * 无标注代码块只在这些常见语言里自动探测(OCV5-421)。全量探测要逐个语法跑一遍;有标注的块不受影响。
 */
export const AUTO_DETECT_LANGUAGES = [
  "bash", "shell", "python", "javascript", "typescript", "json", "xml", "css",
  "sql", "go", "java", "c", "cpp", "rust", "yaml", "markdown",
] as const;

/** 不超过这个长度的块在渲染时同步探测(手机上也只是几十毫秒),更长的走分片探测。 */
export const SYNC_DETECT_MAX_CHARS = 1500;
/**
 * 更长的块只拿开头这么多字符(在换行处截断)比 relevance:语言特征在头几十行就够分辨,探测耗时因此有上限
 * (400 行的块不再要几秒才上色);选定语言后整块仍按该语言完整高亮。
 */
export const DETECT_SAMPLE_CHARS = 3000;
/** 超过这个长度的块以「长度 + 哈希」作缓存键,不让缓存常驻大字符串。所有结论都缓存(Codex r1:不缓存会让
 * 探测完的重渲再次未命中、再探测,无限循环)。 */
const CACHE_KEY_MAX_CHARS = 20_000;
const CACHE_MAX_ENTRIES = 300;

const engine = hljs.newInstance();
const GRAMMARS = { bash, c, cpp, css, go, graphql, java, javascript, json, markdown, python, ruby, rust, shell, sql, typescript, xml, yaml };
for (const [name, grammar] of Object.entries(GRAMMARS)) engine.registerLanguage(name, grammar);

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

/** FNV-1a 32 位;只用于超长块的缓存键(撞键的代价是某个超长块配错高亮语言)。 */
function hash32(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function cacheKey(text: string): string {
  return text.length <= CACHE_KEY_MAX_CHARS ? text : `\u0000${text.length}:${hash32(text)}`;
}

function remember(key: string, language: string | null): string | null {
  // 满了逐出最早的一条(Map 按插入顺序),不整表清空。
  if (cache.size >= CACHE_MAX_ENTRIES && !cache.has(key)) cache.delete(cache.keys().next().value as string);
  cache.set(key, language);
  return language;
}

function detectionSample(text: string): string {
  if (text.length <= DETECT_SAMPLE_CHARS) return text;
  const cut = text.lastIndexOf("\n", DETECT_SAMPLE_CHARS);
  return text.slice(0, cut > 0 ? cut : DETECT_SAMPLE_CHARS);
}

function relevance(language: string, text: string): number {
  try {
    return engine.highlight(text, { language, ignoreIllegals: true }).relevance;
  } catch {
    return 0;
  }
}

/** 已知结果:语言名、null(都不像),未探测过为 undefined。 */
export function cachedCodeLanguage(text: string): string | null | undefined {
  return cache.get(cacheKey(text));
}

/** 同步探测(小块用)。 */
export function detectCodeLanguageNow(text: string): string | null {
  const key = cacheKey(text);
  const known = cache.get(key);
  if (known !== undefined) return known;
  const sample = detectionSample(text);
  let best: string | null = null;
  let bestRelevance = 0;
  for (const language of AUTO_DETECT_LANGUAGES) {
    const score = relevance(language, sample);
    if (score > bestRelevance) {
      bestRelevance = score;
      best = language;
    }
  }
  return remember(key, best);
}

const yieldToMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 分片探测(大块用):每种语法一个宏任务。同一段代码并发请求共用一次探测。 */
export function detectCodeLanguageLater(text: string): Promise<string | null> {
  const key = cacheKey(text);
  const known = cache.get(key);
  if (known !== undefined) return Promise.resolve(known);
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      const sample = detectionSample(text);
      let best: string | null = null;
      let bestRelevance = 0;
      for (const language of AUTO_DETECT_LANGUAGES) {
        await yieldToMain();
        const score = relevance(language, sample);
        if (score > bestRelevance) {
          bestRelevance = score;
          best = language;
        }
      }
      return remember(key, best);
    })().finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}
