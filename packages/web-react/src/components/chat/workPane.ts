/**
 * 详情面板(第三栏)的数据源 —— 纯函数,只从会话自己的消息里推导,不打后端。
 *
 *  - collectPaneSteps:会话里每一次顶层工具调用,按轮分组(user 消息开启新轮,与
 *    turnSegment.ts 的轮边界同源)。团队模式 agent-group 里的子工具不在顶层,不收。
 *  - collectFileChanges:会话里改过的文件(Edit / Write / codex apply_patch / 纯写文件的
 *    heredoc 命令),一个文件一行,带改动次数与 +/− 行数。同一会话里对同一文件的第二次
 *    Write 能拿到上一次写入的全文,于是按行 diff 计数,而不是把整份文件记成新增。
 *  - toolChangedFileCount:一组消息里改到的不同文件数(过程摘要上的「改动 N 个文件」)。
 */
import type { ChatMessage } from "../../lib/chat/model";
import { asArr, asStr, detectShellFileWrites, normalizeToolForDisplay, stripShellWrapperForDisplay } from "../tool/format";
import { diffLines } from "../tool/lineDiff";
import { resolveToolStatus } from "../tool/status";

export type PaneStep = { message: ChatMessage; turnIndex: number };

export type PaneTurn = {
  /** 本轮 user 消息的 id;会话开头没有 user 消息的那段为 "start"。 */
  key: string;
  title: string;
  steps: PaneStep[];
  /** 本轮 user 消息之后的全部行(含思考 / 叙述),供与过程时间轴同口径计算每步用时。 */
  rows: ChatMessage[];
  /** 本轮起点(user 消息时刻);开头那段没有。 */
  startedAt?: number;
};

export function collectPaneSteps(messages: readonly ChatMessage[]): { turns: PaneTurn[]; steps: PaneStep[] } {
  const turns: PaneTurn[] = [];
  const steps: PaneStep[] = [];
  let current: PaneTurn | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      if (m.status === "queued") continue;
      current = { key: m.id, title: turnTitle(m.text), steps: [], rows: [], startedAt: m.ts };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { key: "start", title: "会话开始", steps: [], rows: [] };
      turns.push(current);
    }
    current.rows.push(m);
    if (m.role !== "tool") continue;
    const step = { message: m, turnIndex: turns.length - 1 };
    current.steps.push(step);
    steps.push(step);
  }
  return { turns: turns.filter((t) => t.steps.length > 0), steps };
}

function turnTitle(text: string | undefined): string {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  if (!line) return "（无文字的消息）";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

export type FileChangeKind = "edit" | "write" | "patch" | "shell";

export type FileChangeEntry = {
  message: ChatMessage;
  kind: FileChangeKind;
  /** 行数统计;不可知(如 shell heredoc 外的形状)时为 null。 */
  added: number | null;
  removed: number | null;
  /** 同一会话里此前写入过全文时,本次 Write 相对上次的旧全文(供面板按 diff 展示)。 */
  previousContent?: string;
};

export type FileChange = {
  path: string;
  entries: FileChangeEntry[];
  added: number;
  removed: number;
  /** 任一条改动失败 / 仍在运行(行里如实标出,不把失败的写入算成已改)。 */
  hasError: boolean;
  running: boolean;
};

type RawChange = { path: string; kind: FileChangeKind; added: number | null; removed: number | null; content?: string; diff?: string };

function countLines(s: string): number {
  if (!s) return 0;
  return s.replace(/\n$/, "").split("\n").length;
}

function diffCounts(oldStr: string, newStr: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of diffLines(oldStr, newStr)) {
    if (row.sign === "+") added++;
    else if (row.sign === "-") removed++;
  }
  return { added, removed };
}

function unifiedCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** 一条工具消息改到的文件(零到多条)。不是改文件的工具 → []。 */
export function toolFileChanges(message: ChatMessage): RawChange[] {
  if (message.role !== "tool") return [];
  const { name, input } = normalizeToolForDisplay(message);
  if (name === "Edit" || name === "Write") {
    const patch = asArr(input?.changes).filter(
      (c): c is Record<string, unknown> => !!c && typeof c === "object" && !Array.isArray(c),
    );
    if (patch.length > 0) {
      return patch
        .map((c) => {
          const diff = asStr(c.diff);
          const kindRaw =
            c.kind && typeof c.kind === "object" && !Array.isArray(c.kind)
              ? asStr((c.kind as Record<string, unknown>).type)
              : asStr(c.kind) || asStr(input?.kind);
          // apply_patch:add 的 diff 字段是新文件全文(没有 +/- 前缀),update 才是 unified diff;
          // delete 不带旧内容,行数不可知。
          const kind = kindRaw.toLowerCase();
          const counts =
            kind === "add"
              ? { added: countLines(diff), removed: 0 }
              : kind === "delete"
                ? null
                : diff
                  ? unifiedCounts(diff)
                  : null;
          return {
            path: asStr(c.path) || asStr(input?.file_path),
            kind: "patch" as const,
            added: counts?.added ?? null,
            removed: counts?.removed ?? null,
            diff,
          };
        })
        .filter((c) => c.path);
    }
    const path = asStr(input?.file_path) || asStr(input?.path);
    if (!path) return [];
    if (name === "Write") {
      const content = asStr(input?.content);
      return [{ path, kind: "write", added: countLines(content), removed: 0, content }];
    }
    const counts = diffCounts(asStr(input?.old_string), asStr(input?.new_string));
    return [{ path, kind: "edit", ...counts }];
  }
  if (name === "Bash") {
    const writes = detectShellFileWrites(stripShellWrapperForDisplay(asStr(input?.command)));
    if (!writes) return [];
    return writes.paths.map((path) => ({ path, kind: "shell" as const, added: null, removed: null }));
  }
  return [];
}

/** 状态与卡片同源(resolveToolStatus):卡上「未成功 / 受阻」的写入,面板里也不算已改。 */
function isFailed(m: ChatMessage): boolean {
  const kind = resolveToolStatus(normalizeToolForDisplay(m)).kind;
  return kind === "error" || kind === "blocked";
}

function isRunning(m: ChatMessage): boolean {
  return resolveToolStatus(normalizeToolForDisplay(m)).kind === "running";
}

export function collectFileChanges(messages: readonly ChatMessage[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  const lastContent = new Map<string, string>();
  for (const m of messages) {
    const changes = toolFileChanges(m);
    if (changes.length === 0) continue;
    const failed = isFailed(m);
    const running = isRunning(m);
    for (const raw of changes) {
      let file = byPath.get(raw.path);
      if (!file) {
        file = { path: raw.path, entries: [], added: 0, removed: 0, hasError: false, running: false };
        byPath.set(raw.path, file);
      }
      const entry: FileChangeEntry = { message: m, kind: raw.kind, added: raw.added, removed: raw.removed };
      if (raw.kind === "write" && raw.content !== undefined) {
        const prev = lastContent.get(raw.path);
        if (prev !== undefined && !failed) {
          const counts = diffCounts(prev, raw.content);
          entry.added = counts.added;
          entry.removed = counts.removed;
          entry.previousContent = prev;
        }
        if (!failed) lastContent.set(raw.path, raw.content);
      } else if (raw.kind !== "write") {
        // 中间被别的方式改过,上次 Write 的全文不再是旧内容。
        lastContent.delete(raw.path);
      }
      file.entries.push(entry);
      if (failed) file.hasError = true;
      else {
        file.added += entry.added ?? 0;
        file.removed += entry.removed ?? 0;
      }
      if (running) file.running = true;
    }
  }
  return [...byPath.values()];
}

/** 一组消息里改到的不同文件数(失败的写入不算)。 */
export function toolChangedFileCount(messages: readonly ChatMessage[]): number {
  const paths = new Set<string>();
  for (const m of messages) {
    const changes = toolFileChanges(m);
    if (changes.length === 0 || isFailed(m)) continue;
    for (const c of changes) paths.add(c.path);
  }
  return paths.size;
}
