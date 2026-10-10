/**
 * 详情面板「产出」页的数据源 —— 纯函数,只从会话自己的消息推导,不打后端(OCV5-372)。
 *
 *  - collectWorkTurns:会话按轮切分(user 消息开启新轮,与 collectPaneSteps 同口径),**不**像
 *    步骤页那样丢掉没有工具的轮:只回答了一段话的轮也是一轮,产出页要能翻到它。
 *  - collectTurnOutputs:一轮的产出 —— 改过的文件、回答里引用的图片 / 容器内文件、本机预览
 *    链接、查过的网页来源。
 *  - fileSnapshot:按会话里的 Write / Edit / apply_patch(add)回放出文件在某轮结束时的全文;
 *    回放不出来(中间有 shell 改写、Edit 对不上、只有 update diff)→ null,界面改读容器里的当前文件。
 */
import { isContainerPreviewUrl } from "@openclaude/protocol/containerPreview";
import type { ChatMessage } from "../../lib/chat/model";
import { asArr, asStr, normalizeToolForDisplay } from "../tool/format";
import { parseWebSearchSources } from "../tool/webSearchHits";
import { resolveToolStatus } from "../tool/status";
import { type FileChange, collectFileChanges } from "./workPane";
import type { WorkTurn } from "./workTurns";

export { type WorkTurn, collectWorkTurns, turnIndexOf } from "./workTurns";

// ── 产出 ────────────────────────────────────────────────────────────────

export type OutputKind = "html" | "markdown" | "image" | "code" | "text" | "file";

export type OutputFile = {
  path: string;
  name: string;
  kind: OutputKind;
  /** 本轮对它的改动;只在回答里被提到(脚本生成的文件等)时为 undefined。 */
  change?: FileChange;
};

export type OutputMedia = { src: string; kind: "image" | "video" | "audio"; name: string };
export type OutputLink = { url: string; label: string };
export type OutputSource = { url: string; title: string; domain: string };

export type TurnOutputs = {
  files: OutputFile[];
  media: OutputMedia[];
  links: OutputLink[];
  sources: OutputSource[];
};

const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "mkv"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac"]);
const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);
const TEXT_EXT = new Set(["txt", "log", "csv", "tsv", "text", "rst", "ini", "conf", "srt", "vtt"]);
const CODE_EXT = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp",
  "cs", "php", "sh", "bash", "zsh", "sql", "json", "yaml", "yml", "toml", "xml", "css", "scss", "less", "vue", "svelte",
  "lua", "r", "dart", "scala", "ex", "exs", "erl", "hs", "ml", "pl", "ps1", "dockerfile", "makefile", "gradle", "proto",
]);

export function extOf(path: string): string {
  const name = baseName(path).toLowerCase();
  if (name === "dockerfile" || name === "makefile") return name;
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1) : "";
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

export function dirName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i > 0 ? trimmed.slice(0, i) : "";
}

// 会话工作区前缀:/home/agent/.openclaude/workspace[/sessions/<id>]/… → 「工作区/…」。
const WORKSPACE_RE = /^\/(?:home\/agent|root)\/\.openclaude\/workspace(?:\/sessions\/[^/]+)?(?=\/|$)/;

/** 给人看的目录:会话工作区里的文件显示成相对工作区的目录;其它绝对路径原样。 */
export function displayDir(path: string): string {
  const dir = dirName(path);
  const m = WORKSPACE_RE.exec(dir);
  if (!m) return dir;
  const rest = dir.slice(m[0].length).replace(/^\//, "");
  return rest ? `工作区/${rest}` : "工作区";
}

export function outputKindOf(path: string): OutputKind {
  const ext = extOf(path);
  if (ext === "html" || ext === "htm") return "html";
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (IMG_EXT.has(ext)) return "image";
  if (CODE_EXT.has(ext)) return "code";
  if (TEXT_EXT.has(ext)) return "text";
  return "file";
}

function mediaKindOf(path: string): OutputMedia["kind"] | null {
  const ext = extOf(path.replace(/[?#].*$/, ""));
  if (IMG_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return null;
}

// 回答里的容器文件路径:与聊天区 MarkdownImpl 同口径 —— 行内 code 里的任意容器绝对路径,
// 纯文本只认 openclaude 生成 / 上传目录(避免句子里普通 "/x" 误判)。
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const TEXT_PATH_RE = /(?:\/(?:home\/agent|root)\/\.openclaude)\/[^\s"'`<>，。、；：）)】」]+\.[A-Za-z0-9]{1,10}/g;
const URL_RE = /https?:\/\/[^\s"'`<>)\]）】」，。]+/g;

function answerRefs(text: string): { paths: string[]; urls: string[] } {
  const paths: string[] = [];
  const urls: string[] = [];
  for (const m of text.matchAll(INLINE_CODE_RE)) {
    const s = m[1].trim();
    if (/^https?:\/\//i.test(s)) urls.push(s);
    else if (s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/api/") && !/\s/.test(s) && /\.[A-Za-z0-9]{1,10}$/.test(s)) paths.push(s);
  }
  for (const m of text.matchAll(TEXT_PATH_RE)) paths.push(m[0]);
  for (const m of text.matchAll(URL_RE)) urls.push(m[0].replace(/[.,;:!?]+$/, ""));
  return { paths, urls };
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function toolOutputText(m: ChatMessage): string {
  if (typeof m.output === "string" && m.output.trim()) return m.output;
  const tail = m.bashTail?.tail;
  return typeof tail === "string" ? tail : "";
}

function failed(m: ChatMessage): boolean {
  const kind = resolveToolStatus(normalizeToolForDisplay(m)).kind;
  return kind === "error" || kind === "blocked";
}

export function collectTurnOutputs(turn: WorkTurn): TurnOutputs {
  const files: OutputFile[] = collectFileChanges(turn.rows).map((change) => ({
    path: change.path,
    name: baseName(change.path),
    kind: outputKindOf(change.path),
    change,
  }));
  const seenFiles = new Set(files.map((f) => f.path));
  const media: OutputMedia[] = [];
  const seenMedia = new Set<string>();
  const links: OutputLink[] = [];
  const seenLinks = new Set<string>();
  const sources: OutputSource[] = [];
  const seenSources = new Set<string>();

  const addSource = (url: string, title: string) => {
    if (!/^https?:\/\//i.test(url) || seenSources.has(url) || isContainerPreviewUrl(url)) return;
    seenSources.add(url);
    sources.push({ url, title: title || domainOf(url), domain: domainOf(url) });
  };

  for (const m of turn.rows) {
    if (m.role === "tool") {
      const { name, input } = normalizeToolForDisplay(m);
      if (failed(m)) continue;
      if (name === "WebSearch") {
        for (const hit of parseWebSearchSources(toolOutputText(m))) addSource(hit.url, hit.title);
      } else if (name === "WebFetch") {
        addSource(asStr(input?.url), "");
      }
      continue;
    }
    if (m.role !== "assistant" || !m.text) continue;
    const { paths, urls } = answerRefs(m.text);
    for (const p of paths) {
      const kind = mediaKindOf(p);
      if (kind) {
        if (seenMedia.has(p)) continue;
        seenMedia.add(p);
        media.push({ src: p, kind, name: baseName(p) });
      } else if (!seenFiles.has(p)) {
        seenFiles.add(p);
        files.push({ path: p, name: baseName(p), kind: outputKindOf(p) });
      }
    }
    for (const u of urls) {
      if (isContainerPreviewUrl(u)) {
        if (seenLinks.has(u)) continue;
        seenLinks.add(u);
        links.push({ url: u, label: u.replace(/^https?:\/\//i, "") });
      } else {
        const kind = mediaKindOf(u);
        if (kind === "image" && !seenMedia.has(u)) {
          seenMedia.add(u);
          media.push({ src: u, kind, name: baseName(u.replace(/[?#].*$/, "")) });
        }
      }
    }
  }
  // 图片文件直接进图片区,不在文件区重复出现。
  const imageFiles = files.filter((f) => f.kind === "image");
  for (const f of imageFiles) {
    if (!seenMedia.has(f.path)) {
      seenMedia.add(f.path);
      media.push({ src: f.path, kind: "image", name: f.name });
    }
  }
  return { files: files.filter((f) => f.kind !== "image"), media, links, sources };
}

export function outputCount(o: TurnOutputs): number {
  return o.files.length + o.media.length + o.links.length;
}

// ── 主产物 ──────────────────────────────────────────────────────────────

export type HeroRef = { type: "file"; path: string } | { type: "media"; src: string };

const HERO_RANK: Record<OutputKind, number> = { html: 0, markdown: 1, image: 2, code: 3, text: 4, file: 5 };

/** 默认主产物:网页 > 文档 > 图片 > 改动最多的代码 / 文本 > 其余文件。失败的写入不选。 */
export function pickHero(o: TurnOutputs): HeroRef | null {
  const candidates = o.files.filter((f) => !f.change?.hasError || f.change.added + f.change.removed > 0);
  const ranked = [...candidates].sort((a, b) => {
    const r = HERO_RANK[a.kind] - HERO_RANK[b.kind];
    if (r !== 0) return r;
    const size = (f: OutputFile) => (f.change ? f.change.added + f.change.removed : 0);
    return size(b) - size(a);
  });
  const best = ranked[0];
  if (best && HERO_RANK[best.kind] < HERO_RANK.image) return { type: "file", path: best.path };
  const image = o.media.find((m) => m.kind === "image") ?? o.media[0];
  if (image) return { type: "media", src: image.src };
  return best ? { type: "file", path: best.path } : null;
}

// ── 文件全文回放 ────────────────────────────────────────────────────────

/**
 * 按会话消息回放某个文件在 `upTo`(含)这条消息之后的全文。宁缺毋错:回放不出**确定**结果就返回
 * null,界面改读容器里的当前文件。
 *  - 只认成功完成(status done)的 Write 全文、apply_patch add 全文、能精确对上的 Edit / MultiEdit;
 *    失败 / 受阻 / 取消的写入没有落盘,跳过;还在运行的写入结果未定 → 不可知。
 *  - 其它工具(Bash、脚本、子任务…)只要输入里提到这个文件(全路径或文件名),不论成败都可能
 *    改过它 → 不可知。命令不提文件名却改了它(脚本内部写)识别不了,这是剩余盲区。
 *  - 大记录定位桩(_payloadDeferred)看不到输入 → 不可知。
 */
export function fileSnapshot(messages: readonly ChatMessage[], path: string, upTo?: ChatMessage): string | null {
  let content: string | null = null;
  let known = false;
  const forget = () => {
    content = null;
    known = false;
  };
  const name0 = baseName(path);
  for (const m of messages) {
    if (m.role === "tool") {
      if (m._payloadDeferred === true) forget();
      else {
        const display = normalizeToolForDisplay(m);
        const { name, input } = display;
        const status = resolveToolStatus(display).kind;
        if (name === "Write" || name === "Edit" || name === "MultiEdit") {
          const patch = asArr(input?.changes).filter(
            (c): c is Record<string, unknown> => !!c && typeof c === "object" && !Array.isArray(c),
          );
          const touches =
            patch.length > 0
              ? patch.some((c) => (asStr(c.path) || asStr(input?.file_path)) === path)
              : (asStr(input?.file_path) || asStr(input?.path)) === path;
          if (touches && status === "running") forget();
          else if (touches && status === "done") {
            if (patch.length > 0) {
              for (const c of patch) {
                if ((asStr(c.path) || asStr(input?.file_path)) !== path) continue;
                const kind =
                  c.kind && typeof c.kind === "object" && !Array.isArray(c.kind)
                    ? asStr((c.kind as Record<string, unknown>).type)
                    : asStr(c.kind) || asStr(input?.kind);
                if (kind.toLowerCase() === "add") {
                  content = asStr(c.diff);
                  known = true;
                } else forget();
              }
            } else if (name === "Write") {
              content = asStr(input?.content);
              known = true;
            } else {
              const edits =
                name === "MultiEdit"
                  ? asArr(input?.edits).filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
                  : [input ?? {}];
              for (const e of edits) {
                if (!known || content === null) break;
                const oldStr = asStr(e.old_string);
                const newStr = asStr(e.new_string);
                if (!oldStr || !content.includes(oldStr)) {
                  forget();
                  break;
                }
                content = e.replace_all === true ? content.split(oldStr).join(newStr) : content.replace(oldStr, () => newStr);
              }
            }
          }
          // 失败 / 受阻 / 取消:没有落盘,不影响回放。
        } else if (known) {
          const text = typeof m.inputJson === "string" ? m.inputJson : JSON.stringify(input ?? m.inputJson ?? {});
          if (text.includes(path) || text.includes(name0)) forget();
        }
      }
    }
    if (upTo && (m === upTo || (!!upTo.id && m.id === upTo.id))) break;
  }
  return known ? content : null;
}

/**
 * 「读容器文件」回落的重读信号:会话里所有可能动过这个文件的工具行 —— 对它的写入、输入里提到它
 * 的任何命令(脚本可能在命令返回时才写)、看不到输入的大记录定位桩 —— 各自的 id 与完成 / 出错
 * 状态拼在一起。任何一行出现或跑完,指纹就变,卡片重读当前文件。
 */
export function fileTouchFingerprint(messages: readonly ChatMessage[], path: string): string {
  const name0 = baseName(path);
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== "tool") continue;
    let touches = m._payloadDeferred === true;
    if (!touches) {
      const { input } = normalizeToolForDisplay(m);
      const text = typeof m.inputJson === "string" ? m.inputJson : JSON.stringify(input ?? m.inputJson ?? {});
      touches = text.includes(path) || text.includes(name0);
    }
    if (touches) parts.push(`${m.id}:${m._completed ? 1 : 0}${m.error ? 1 : 0}`);
  }
  return parts.join("|");
}

// ── 摘要 ────────────────────────────────────────────────────────────────

export type TurnSummary = {
  status: "running" | "error" | "done";
  durationMs: number | null;
  steps: number;
  failedSteps: number;
};

export function turnSummary(turn: WorkTurn, running: boolean): TurnSummary {
  let end = turn.startedAt ?? null;
  for (const r of turn.rows) {
    const t = r.completedAt ?? r.ts;
    if (typeof t === "number" && (end === null || t > end)) end = t;
  }
  const failedSteps = turn.steps.filter(failed).length;
  const errored = turn.rows.some((r) => r.role === "assistant" && !!r._errorCode);
  return {
    status: running ? "running" : errored ? "error" : "done",
    durationMs: turn.startedAt !== undefined && end !== null && end >= turn.startedAt ? end - turn.startedAt : null,
    steps: turn.steps.length,
    failedSteps,
  };
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
