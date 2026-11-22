/**
 * Intelligent UI 二期新增 6 类组件 schema 与校验（deliverables / citations / runbook / prompt_template / storyboard / flashcards）。
 */
import { needsSignedSrc } from "../../lib/chat/media";

type Sub = { subtitle?: string };
type Ctx = { notes: string[]; partial: boolean };

export type DeliverableItem = {
  name: string;
  path?: string;
  ext: string;
  size?: string;
  meta?: string;
  desc?: string;
  preview?: string;
};
export type DeliverablesSpec = Sub & { type: "deliverables"; title?: string; items: DeliverableItem[] };

export type CitationItem = {
  id: string;
  title: string;
  meta?: string;
  url?: string;
  tags: string[];
  conclusion?: string;
  abstract?: string;
  gbt?: string;
  bibtex?: string;
};
export type CitationsSpec = Sub & { type: "citations"; title?: string; items: CitationItem[] };

export type RunbookVar = { id: string; label: string; value: string; placeholder?: string };
export type RunbookStep = { title: string; command: string; detail?: string; danger: boolean };
export type RunbookSpec = Sub & { type: "runbook"; title?: string; vars: RunbookVar[]; steps: RunbookStep[] };

export type PromptSlot = { id: string; label: string; value: string; options: string[]; placeholder?: string };
export type PromptTemplateSpec = Sub & { type: "prompt_template"; title?: string; template: string; slots: PromptSlot[]; submit?: string };

export type StoryboardShot = { no: string; shotType?: string; line: string; prompt?: string; image?: string; duration?: number };
export type StoryboardSpec = Sub & { type: "storyboard"; title?: string; cps: number; shots: StoryboardShot[] };

export type FlashcardItem = { front: string; back: string; tag?: string; hint?: string };
export type FlashcardsSpec = Sub & { type: "flashcards"; title?: string; cards: FlashcardItem[] };

export type BrowserHandoffSpec = Sub & {
  type: "browser_handoff";
  title?: string;
  url?: string;
  reason?: string;
  action_label?: string;
  continue_label?: string;
  continue_prompt?: string;
};

export type V2Spec =
  | DeliverablesSpec
  | CitationsSpec
  | RunbookSpec
  | PromptTemplateSpec
  | StoryboardSpec
  | FlashcardsSpec
  | BrowserHandoffSpec;
export type V2Type = V2Spec["type"];

const V2_LIMITS = {
  deliverables: 20,
  citations: 15,
  runbookVars: 8,
  runbookSteps: 20,
  slots: 10,
  shots: 20,
  flashcards: 30,
  short: 300,
  text: 4000,
} as const;

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

function str(v: unknown, max: number = V2_LIMITS.short): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function cap<T>(items: T[], max: number, ctx: Ctx, what: string): T[] {
  if (items.length <= max) return items;
  ctx.notes.push(`${what}超过 ${max} 项,已省略其余`);
  return items.slice(0, max);
}

function strList(v: unknown, max: number, len = 60): string[] {
  const out: string[] = [];
  for (const item of arr(v)) {
    const s = str(item, len);
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function safeFilePath(v: unknown): string | undefined {
  const s = str(v, 2000);
  if (!s) return undefined;
  if (/^https:\/\/[^\s"'<>]+$/i.test(s)) return s;
  if (!s.includes("..") && needsSignedSrc(s)) return s;
  return undefined;
}

function httpUrl(v: unknown): string | undefined {
  const s = str(v, 2000);
  return s && /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : undefined;
}

function inferExt(rawExt: unknown, name: string, path?: string): string {
  const explicit = str(rawExt, 12)?.toLowerCase().replace(/^\./, "");
  if (explicit && /^[a-z0-9]+$/.test(explicit)) return explicit;
  const fromName = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase();
  if (fromName) return fromName;
  const fromPath = path ? /\.([a-z0-9]{1,8})(?:[?#]|$)/i.exec(path)?.[1]?.toLowerCase() : undefined;
  return fromPath ?? "file";
}

function deliverables(raw: Record<string, unknown>, ctx: Ctx): DeliverablesSpec | null {
  const items: DeliverableItem[] = [];
  for (const it of arr(raw.items ?? raw.files)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const path = safeFilePath(o.path ?? o.url ?? o.file);
    const name = str(o.name ?? o.filename ?? o.title, 200) ?? (path ? path.split(/[\\/]/).pop()?.split("?")[0] : undefined);
    if (!name) continue;
    items.push({
      name,
      ...optional("path", path),
      ext: inferExt(o.ext ?? o.format, name, path),
      ...optional("size", str(o.size, 32)),
      ...optional("meta", str(o.meta ?? o.pages, 80)),
      ...optional("desc", str(o.desc ?? o.description ?? o.summary, 300)),
      ...optional("preview", typeof o.preview === "string" && o.preview.trim() ? o.preview.slice(0, V2_LIMITS.text) : undefined),
    });
  }
  if (items.length === 0 && !ctx.partial) return null;
  return { type: "deliverables", ...optional("title", str(raw.title)), items: cap(items, V2_LIMITS.deliverables, ctx, "文件") };
}

function citations(raw: Record<string, unknown>, ctx: Ctx): CitationsSpec | null {
  const items: CitationItem[] = [];
  for (const it of arr(raw.items ?? raw.papers ?? raw.citations)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const title = str(o.title ?? o.name, 400);
    if (!title) continue;
    const meta =
      str(o.meta, 200) ??
      ([str(o.authors, 120), str(o.year ?? o.date, 24), str(o.venue ?? o.journal ?? o.source, 100)].filter(Boolean).join(" · ") || undefined);
    items.push({
      id: str(o.id, 16) ?? String(items.length + 1),
      title,
      ...optional("meta", meta),
      ...optional("url", httpUrl(o.url ?? o.link ?? o.doi_url)),
      tags: strList(o.tags, 4, 24),
      ...optional("conclusion", str(o.conclusion ?? o.finding ?? o.takeaway, 600)),
      ...optional("abstract", str(o.abstract ?? o.summary, 2000)),
      ...optional("gbt", str(o.gbt ?? o.gbt7714, 1000)),
      ...optional("bibtex", str(o.bibtex ?? o.bib, 1500)),
    });
  }
  if (items.length === 0 && !ctx.partial) return null;
  return { type: "citations", ...optional("title", str(raw.title)), items: cap(items, V2_LIMITS.citations, ctx, "文献") };
}

function runbook(raw: Record<string, unknown>, ctx: Ctx): RunbookSpec | null {
  const vars: RunbookVar[] = [];
  const seen = new Set<string>();
  const rawVars = raw.vars;
  if (Array.isArray(rawVars)) {
    for (const it of rawVars) {
      if (!it || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id.trim() : "";
      if (!ID_RE.test(id) || seen.has(id)) continue;
      seen.add(id);
      vars.push({
        id,
        label: str(o.label, 40) ?? id,
        value: str(o.value ?? o.default, 200) ?? "",
        ...optional("placeholder", str(o.placeholder, 80)),
      });
    }
  } else if (rawVars && typeof rawVars === "object") {
    for (const [k, v] of Object.entries(rawVars as Record<string, unknown>)) {
      if (!ID_RE.test(k) || seen.has(k)) continue;
      seen.add(k);
      vars.push({ id: k, label: k, value: str(v, 200) ?? "" });
    }
  }
  const steps: RunbookStep[] = [];
  for (const it of arr(raw.steps ?? raw.items)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const command = str(o.command ?? o.cmd, 2000);
    if (!command) continue;
    steps.push({
      title: str(o.title ?? o.label, 200) ?? `步骤 ${steps.length + 1}`,
      command,
      ...optional("detail", str(o.detail ?? o.note, 600)),
      danger: o.danger === true || o.risk === "high",
    });
  }
  for (const st of steps) {
    for (const m of st.command.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]{0,39})\}\}|\$\{([A-Za-z_][A-Za-z0-9_]{0,39})\}/g)) {
      const id = (m[1] ?? m[2])!;
      if (!seen.has(id)) {
        seen.add(id);
        vars.push({ id, label: id, value: id });
      }
    }
  }
  if (steps.length === 0 && !ctx.partial) return null;
  return {
    type: "runbook",
    ...optional("title", str(raw.title)),
    vars: cap(vars, V2_LIMITS.runbookVars, ctx, "变量"),
    steps: cap(steps, V2_LIMITS.runbookSteps, ctx, "命令步骤"),
  };
}

function promptTemplate(raw: Record<string, unknown>, ctx: Ctx): PromptTemplateSpec | null {
  const template = typeof raw.template === "string"
    ? raw.template.trim()
    : typeof raw.body === "string"
      ? raw.body.trim()
      : typeof raw.text === "string"
        ? raw.text.trim()
        : "";
  if (!template && !ctx.partial) return null;
  const slots: PromptSlot[] = [];
  const seen = new Set<string>();
  for (const it of arr(raw.slots ?? raw.fields)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const id = str(o.id ?? o.key ?? o.label, 40);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const options = strList(o.options ?? o.presets, 10, 80);
    const val = str(o.value ?? o.default, 200) ?? options[0] ?? "";
    slots.push({
      id,
      label: str(o.label, 40) ?? id,
      value: val,
      options,
      ...optional("placeholder", str(o.placeholder, 80)),
    });
  }
  for (const m of template.matchAll(/\{\{([A-Za-z0-9_\u4e00-\u9fff-]{1,40})\}\}/g)) {
    const id = m[1]!;
    if (!seen.has(id)) {
      seen.add(id);
      slots.push({ id, label: id, value: "", options: [] });
    }
  }
  return {
    type: "prompt_template",
    ...optional("title", str(raw.title)),
    template: template.slice(0, V2_LIMITS.text),
    slots: cap(slots, V2_LIMITS.slots, ctx, "槽位"),
    ...optional("submit", str(raw.submit, 24)),
  };
}

function storyboard(raw: Record<string, unknown>, ctx: Ctx): StoryboardSpec | null {
  const shots: StoryboardShot[] = [];
  for (const it of arr(raw.shots ?? raw.items)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const line = str(o.line ?? o.text ?? o.voiceover ?? o.narration, 1000);
    const prompt = str(o.prompt ?? o.visual_prompt ?? o.image_prompt, 1000);
    if (!line && !prompt) continue;
    const dur = num(o.duration);
    shots.push({
      no: str(o.no, 12) ?? String(shots.length + 1).padStart(2, "0"),
      ...optional("shotType", str(o.shotType ?? o.shot_type ?? o.camera ?? o.type, 40)),
      line: line ?? "",
      ...optional("prompt", prompt),
      ...optional("image", safeFilePath(o.image)),
      ...optional("duration", dur !== undefined && dur > 0 ? dur : undefined),
    });
  }
  if (shots.length === 0 && !ctx.partial) return null;
  const rawCps = num(raw.cps);
  return {
    type: "storyboard",
    ...optional("title", str(raw.title)),
    cps: rawCps !== undefined ? Math.max(2, Math.min(8, rawCps)) : 4.5,
    shots: cap(shots, V2_LIMITS.shots, ctx, "分镜"),
  };
}

function flashcards(raw: Record<string, unknown>, ctx: Ctx): FlashcardsSpec | null {
  const cards: FlashcardItem[] = [];
  for (const it of arr(raw.cards ?? raw.items)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const front = str(o.front ?? o.q ?? o.question, 1000);
    const back = str(o.back ?? o.a ?? o.answer, 2000);
    if (!front || !back) continue;
    cards.push({
      front,
      back,
      ...optional("tag", str(o.tag ?? o.topic, 30)),
      ...optional("hint", str(o.hint, 300)),
    });
  }
  if (cards.length === 0 && !ctx.partial) return null;
  return { type: "flashcards", ...optional("title", str(raw.title)), cards: cap(cards, V2_LIMITS.flashcards, ctx, "闪卡") };
}

function browserHandoff(raw: Record<string, unknown>, _ctx: Ctx): BrowserHandoffSpec {
  return {
    type: "browser_handoff",
    ...optional("title", str(raw.title, 120)),
    ...optional("url", httpUrl(raw.url ?? raw.page_url ?? raw.href)),
    ...optional("reason", str(raw.reason ?? raw.body ?? raw.message ?? raw.description, 600)),
    ...optional("action_label", str(raw.action_label ?? raw.cta, 40)),
    ...optional("continue_label", str(raw.continue_label, 40)),
    ...optional("continue_prompt", str(raw.continue_prompt ?? raw.prompt, 400)),
  };
}

export const V2_VALIDATORS: Record<V2Type, (raw: Record<string, unknown>, ctx: Ctx) => V2Spec | null> = {
  deliverables,
  citations,
  runbook,
  prompt_template: promptTemplate,
  storyboard,
  flashcards,
  browser_handoff: browserHandoff,
};

export const V2_ALIASES: Record<string, V2Type> = {
  files: "deliverables",
  artifacts: "deliverables",
  literature: "citations",
  papers: "citations",
  playbook: "runbook",
  template: "prompt_template",
  shots: "storyboard",
  script: "storyboard",
  flashcard: "flashcards",
  browser_takeover: "browser_handoff",
  browser_login: "browser_handoff",
  live_browser: "browser_handoff",
  takeover: "browser_handoff",
};
