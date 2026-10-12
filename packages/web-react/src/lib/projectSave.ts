import { ApiError, AuthEpochStaleError, api } from "./api";
import { taskboardApi } from "./taskboard";
import type { AuthSession } from "./types";

/**
 * P5b：把一条回答存到项目（「记住这条」→ 项目记忆；「存为项目技能」→ 用户技能 + 项目技能清单）。
 * 纯流程，不碰 React。两条流程都绑定发起时的身份：每次请求前后检查 identityChanged()，
 * 一旦换号/登出就停（返回 aborted），不把 A 账号里点的东西写进 B 账号（同 projectFileUpload）。
 */

/** 记忆正文上限：够放一段完整回答，又不会把整篇长文塞进每轮都要读的项目记忆。 */
export const MEMORY_CONTENT_MAX = 4000;
/** 技能名规则，与 storage/skillStore validateSkillName 一致。 */
export const SKILL_NAME_MAX = 64;
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const SKILL_DESCRIPTION_MAX = 1024;
/** 记忆文件名规则，与 storage/memoryFrontmatter MEMORY_FILE_RE 一致（不含 .md）。 */
export const MEMORY_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/;

/** 第一行有字的内容，去掉 Markdown 标题/列表/强调记号，最多 max 个字符。 */
export function firstLine(text: string, max = 60): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, "")
      .replace(/[*_`~]+/g, "")
      .trim();
    if (line) return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
  }
  return "";
}

/** 只留 ASCII 字母数字，其余合成单个连字符，小写，最长 max。中文标题会得到空串。 */
export function asciiSlug(text: string, max: number): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

function ymd(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
}

/**
 * 记忆文件名（不含 .md）：第一行的英文部分 + 日期 + 4 位随机后缀。同名不同内容的记忆
 * 会和已有那条冲突，所以默认名带随机后缀，基本不会撞上。
 */
export function memorySlugFor(text: string, now = new Date(), rand = Math.random): string {
  const base = asciiSlug(firstLine(text, 200), 40) || "note";
  const suffix = Math.floor(rand() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `${base}-${ymd(now)}-${suffix}`;
}

export function trimForMemory(text: string): string {
  const t = text.trim();
  return t.length > MEMORY_CONTENT_MAX ? `${t.slice(0, MEMORY_CONTENT_MAX).trimEnd()}\n…` : t;
}

export function validateMemorySlug(slug: string): string | null {
  const s = slug.trim();
  if (!s) return "请填写名称";
  if (!MEMORY_SLUG_RE.test(s)) return "名称只能用英文字母、数字、- 和 _，最长 61 个字符";
  if (s.toLowerCase() === "project" || s.toLowerCase() === "user") return "这个名称是保留的，换一个";
  return null;
}

export function skillNameFor(text: string, now = new Date()): string {
  return asciiSlug(firstLine(text, 200), 48) || `project-skill-${ymd(now)}`;
}

export function validateSkillName(name: string): string | null {
  if (!name) return "请填写技能名";
  if (name.length > SKILL_NAME_MAX) return `技能名最长 ${SKILL_NAME_MAX} 个字符`;
  if (!SKILL_NAME_RE.test(name)) return "技能名只能用小写英文字母、数字和 -，且不能以 - 开头";
  return null;
}

export function validateSkillDescription(description: string): string | null {
  const d = description.trim();
  if (!d) return "请写一句什么时候用这个技能";
  if (d.length > SKILL_DESCRIPTION_MAX) return `说明最长 ${SKILL_DESCRIPTION_MAX} 个字符`;
  return null;
}

export type SaveGuard = {
  auth: AuthSession;
  boardProjectId: string;
  /** 确保项目看板已在容器里建好（与项目主页同一条路径）；失败时自己提示，返回 false。 */
  prepareBoard: () => Promise<boolean>;
  /** 发起时的身份已经变了（换号 / 登出 / token epoch 推进）。 */
  identityChanged: () => boolean;
};

export type SaveOutcome =
  | { kind: "saved" }
  | { kind: "aborted" }
  | { kind: "board_unavailable" }
  | { kind: "name_taken" }
  /** 技能已建好，但两次都没能写进项目技能清单（项目设置被并发修改）。 */
  | { kind: "overlay_conflict" };

const ABORTED: SaveOutcome = { kind: "aborted" };

function stale(e: unknown, g: SaveGuard): boolean {
  return e instanceof AuthEpochStaleError || g.identityChanged();
}

async function prepare(g: SaveGuard): Promise<SaveOutcome | null> {
  if (g.identityChanged()) return ABORTED;
  const ok = await g.prepareBoard();
  if (g.identityChanged()) return ABORTED;
  return ok ? null : { kind: "board_unavailable" };
}

export async function saveMessageAsProjectMemory(
  g: SaveGuard,
  input: { slug: string; content: string; sessionId?: string | null },
): Promise<SaveOutcome> {
  const early = await prepare(g);
  if (early) return early;
  try {
    await taskboardApi.createProjectMemory(g.auth, g.boardProjectId, {
      slug: `${input.slug.trim()}.md`,
      content: input.content,
      ...(input.sessionId ? { sourceSession: input.sessionId } : {}),
    });
  } catch (e) {
    if (stale(e, g)) return ABORTED;
    throw e;
  }
  return g.identityChanged() ? ABORTED : { kind: "saved" };
}

export async function saveMessageAsProjectSkill(
  g: SaveGuard,
  input: { name: string; description: string; body: string },
): Promise<SaveOutcome> {
  const early = await prepare(g);
  if (early) return early;
  try {
    // 只建新的：服务端在同一把锁里查重并写入，同名（包括另一个标签页刚建的）返回 412。
    if (g.identityChanged()) return ABORTED;
    try {
      await api.createSkill(g.auth, input.name, {
        description: input.description.trim(),
        body: input.body,
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 412) return g.identityChanged() ? ABORTED : { kind: "name_taken" };
      throw e;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (g.identityChanged()) return ABORTED;
      const ctx = await taskboardApi.getProjectContext(g.auth, g.boardProjectId);
      if (g.identityChanged()) return ABORTED;
      const overlay = Array.isArray(ctx.skillOverlay)
        ? (ctx.skillOverlay as unknown[]).filter((n): n is string => typeof n === "string")
        : [];
      if (overlay.includes(input.name)) return { kind: "saved" };
      try {
        await taskboardApi.putProjectContext(g.auth, g.boardProjectId, {
          expectedVersion: typeof ctx.version === "number" ? ctx.version : 0,
          skillNames: [...overlay, input.name],
        });
        return g.identityChanged() ? ABORTED : { kind: "saved" };
      } catch (e) {
        // 版本冲突：别处刚改过项目设置。重新读一次再试，仍冲突就交给调用方说明。
        if (e instanceof ApiError && e.status === 409) continue;
        throw e;
      }
    }
    return { kind: "overlay_conflict" };
  } catch (e) {
    if (stale(e, g)) return ABORTED;
    throw e;
  }
}
