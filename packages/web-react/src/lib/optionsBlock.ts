/**
 * ```options 交互式选择卡的纯解析与顶层围栏检测（F1 共享单源）。
 * 同时服务 RichBlocks.tsx 渲染器与 sessionStatus.ts 待回答状态判定，消除重复实现与口径漂移。
 */

export interface OptionItem {
  label: string;
  desc?: string;
}

export interface ParsedOptionsItem {
  question?: string;
  multi: boolean;
  options: OptionItem[];
}

const MAX_QUESTIONS_PER_BLOCK = 8;
const MAX_OPTIONS_PER_QUESTION = 12;

function extractFirstJsonValue(source: string): { json: string; rest: string } | null {
  const start = source.search(/\S/);
  if (start < 0) return null;
  const open = source[start];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let isEscaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === "\\") {
        isEscaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) return { json: source.slice(start, i + 1), rest: source.slice(i + 1) };
    }
  }
  return null;
}

function parseStringOption(raw: string): OptionItem | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const split = /^(.{1,120}?)\s+—\s+(.+)$/s.exec(trimmed);
  if (split) {
    const label = split[1]!.trim();
    const desc = split[2]!.trim();
    if (label && desc) return { label, desc };
  }
  return { label: trimmed };
}

function pickNonEmptyField(
  rec: Record<string, unknown>,
  keys: readonly string[],
  trimResult: boolean,
): string {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) {
      return trimResult ? v.trim() : v;
    }
  }
  return "";
}

function normalizeOptionEntry(o: unknown): OptionItem | null {
  if (typeof o === "string") return parseStringOption(o);
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const oo = o as Record<string, unknown>;
  if (Array.isArray(oo.options) || Array.isArray(oo.choices) || Array.isArray(oo.items)) {
    return null;
  }
  const label =
    typeof oo.label === "string" && oo.label.trim()
      ? oo.label
      : pickNonEmptyField(oo, ["title", "text"], true);
  if (!label) return null;
  const desc = pickNonEmptyField(oo, ["desc", "description", "detail", "sublabel"], false);
  return desc ? { label, desc } : { label };
}

function pickRawOptionArray(rec: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(rec.options)) return rec.options;
  if (Array.isArray(rec.choices)) return rec.choices;
  if (Array.isArray(rec.items)) return rec.items;
  return null;
}

function isMultiSelectRecord(rec: Record<string, unknown>): boolean {
  return (
    rec.multi === true ||
    rec.multiSelect === true ||
    rec.is_multi_select === true ||
    rec.allowMultiple === true
  );
}

function normalizeSingleOptionsItem(raw: unknown): ParsedOptionsItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const rawList = pickRawOptionArray(rec);
  if (!rawList) return null;
  const options: OptionItem[] = [];
  for (const o of rawList) {
    const parsed = normalizeOptionEntry(o);
    if (parsed) options.push(parsed);
  }
  if (options.length === 0 || options.length > MAX_OPTIONS_PER_QUESTION) return null;
  const q = pickNonEmptyField(rec, ["question", "prompt", "header", "title"], false);
  return {
    question: q || undefined,
    multi: isMultiSelectRecord(rec),
    options,
  };
}

function normalizeQuestionArray(arr: readonly unknown[]): ParsedOptionsItem[] | null {
  if (arr.length === 0 || arr.length > MAX_QUESTIONS_PER_BLOCK) return null;
  const out: ParsedOptionsItem[] = [];
  for (const item of arr) {
    const norm = normalizeSingleOptionsItem(item);
    if (!norm) return null;
    out.push(norm);
  }
  return out;
}

function normalizeBareOptionsArray(arr: readonly unknown[]): ParsedOptionsItem[] | null {
  if (arr.length === 0 || arr.length > MAX_OPTIONS_PER_QUESTION) return null;
  const bareOptions: OptionItem[] = [];
  for (const entry of arr) {
    const norm = normalizeOptionEntry(entry);
    if (!norm) return null;
    bareOptions.push(norm);
  }
  return [{ question: undefined, multi: false, options: bareOptions }];
}

function expandOptionsPayload(val: unknown): ParsedOptionsItem[] | null {
  if (Array.isArray(val)) {
    return normalizeQuestionArray(val) ?? normalizeBareOptionsArray(val);
  }
  if (val && typeof val === "object") {
    const rec = val as Record<string, unknown>;
    if (Array.isArray(rec.questions)) {
      return normalizeQuestionArray(rec.questions);
    }
  }
  const one = normalizeSingleOptionsItem(val);
  return one ? [one] : null;
}

export function parseOptionsBlocks(
  code: string,
): { items: ParsedOptionsItem[]; trailing: string } | null {
  try {
    const first = extractFirstJsonValue(code);
    if (!first) return null;
    const items = expandOptionsPayload(JSON.parse(first.json));
    if (!items || items.length === 0) return null;
    let rest = first.rest;
    while (items.length < MAX_QUESTIONS_PER_BLOCK) {
      const trimmed = rest.trimStart();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) break;
      const next = extractFirstJsonValue(trimmed);
      if (!next) break;
      const more = expandOptionsPayload(JSON.parse(next.json));
      if (!more || items.length + more.length > MAX_QUESTIONS_PER_BLOCK) break;
      items.push(...more);
      rest = next.rest;
    }
    return { items, trailing: rest.trim() ? rest.trim() : "" };
  } catch {
    return null;
  }
}

type OpenFenceState = { ch: string; len: number; isOptions: boolean; bodyLines: string[] };

function tryOpenFence(line: string): OpenFenceState | null {
  const openMatch = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
  if (!openMatch) return null;
  const seq = openMatch[1]!;
  const ch = seq[0]!;
  const info = openMatch[2]!;
  if (ch === "`" && info.includes("`")) return null;
  return {
    ch,
    len: seq.length,
    isOptions: /^options(?:\s|$)/i.test(info.trim()),
    bodyLines: [],
  };
}

function isClosingFenceFor(line: string, fence: OpenFenceState): boolean {
  const closeMatch = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
  return Boolean(closeMatch && closeMatch[1]![0] === fence.ch && closeMatch[1]!.length >= fence.len);
}

export function hasUnansweredOptionsFence(
  text: string | undefined | null,
  opts?: { allowTruncated?: boolean },
): boolean {
  if (typeof text !== "string" || !text) return false;
  let openFence: OpenFenceState | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!openFence) {
      openFence = tryOpenFence(line);
      continue;
    }
    if (isClosingFenceFor(line, openFence)) {
      if (openFence.isOptions && parseOptionsBlocks(openFence.bodyLines.join("\n")) !== null) {
        return true;
      }
      openFence = null;
      continue;
    }
    if (openFence.isOptions) openFence.bodyLines.push(line);
  }
  if (openFence?.isOptions && opts?.allowTruncated === true) {
    const trimmed = openFence.bodyLines.join("\n").trimStart();
    return trimmed.startsWith("{") || trimmed.startsWith("[");
  }
  return false;
}
