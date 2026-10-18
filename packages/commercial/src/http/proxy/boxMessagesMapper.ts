/** OCV5-289: compile a completed Anthropic history into one isolated Claude CLI turn.
 *
 * This is a protocol experiment, not a routed production model. A current
 * tool_result is deliberately rejected: an in-flight tool call must be
 * delivered to the *same live CLI/MCP rendezvous*, not a resumed process.
 */
import { BOX_PROMPT_LAYOUT_STATIC_FIRST } from "./boxNativePointer.js";
import { createHash, randomUUID } from "node:crypto";
import type { ProxyBody } from "./shared.js";
import { BoxCacheAnnotationError, normalizeBoxSemanticBody,
  strictBoxImageBlock } from "./boxCacheAnnotations.js";

export class BoxMessagesShapeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BoxMessagesShapeError";
  }
}

type Message = { role: "user" | "assistant" | "system"; content: unknown };
type Block = Record<string, unknown> & { type: string };

function blocks(content: unknown): Block[] {
  if (!Array.isArray(content)) return [];
  return content.filter((item): item is Block =>
    item !== null && typeof item === "object" && !Array.isArray(item)
    && typeof (item as { type?: unknown }).type === "string");
}

/** OCV5-381: CCB sends `x-anthropic-billing-header: …` as system block 0.
 * The Box CLI reads `--system-prompt-file` as one block, sees that prefix and
 * discards the whole file as an attribution header, so every OpenClaude
 * instruction after it was lost. Drop the header; keep everything else. */
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header";

function withoutBillingHeader(text: string): string {
  if (!text.startsWith(BILLING_HEADER_PREFIX)) return text;
  const newline = text.indexOf("\n");
  return newline < 0 ? "" : text.slice(newline + 1).replace(/^\n+/, "");
}

/** OCV5-383: OpenClaude marks where the per-session part of its system prompt
 * starts (gateway promptSlots cacheLayout 'static-first'). The text before it is
 * the same for every session, so it alone becomes the Box system prompt and the
 * Box CLI can read it from cache across sessions; the rest rides in the first
 * user message, where Claude Code keeps its own per-session context too. */
export const BOX_SESSION_CONTEXT_MARKER = "<!-- oc:session-context -->";

/** OCV5-383: the prompt layout a request will be staged with. */
export function boxPromptLayoutOf(body: ProxyBody): typeof BOX_PROMPT_LAYOUT_STATIC_FIRST | null {
  const parts: unknown[] = [body.system];
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (message && typeof message === "object" && (message as { role?: unknown }).role === "system") {
        parts.push((message as { content?: unknown }).content);
      }
    }
  }
  for (const part of parts) {
    if (part === undefined) continue;
    try {
      if (systemText(part).includes(BOX_SESSION_CONTEXT_MARKER)) return BOX_PROMPT_LAYOUT_STATIC_FIRST;
    } catch { /* shape errors surface from compileBoxCliSyntheticTurn */ }
  }
  return null;
}

function splitSessionContext(prompt: string): { system: string; context: string | null } {
  const at = prompt.indexOf(BOX_SESSION_CONTEXT_MARKER);
  if (at < 0) return { system: prompt, context: null };
  const context = prompt.slice(at + BOX_SESSION_CONTEXT_MARKER.length).replace(/^\s*(?:---\s*)?/, "").trim();
  return { system: prompt.slice(0, at).replace(/\s*(?:---\s*)?$/, "").trimEnd(),
    context: context || null };
}

function withSessionContext(content: unknown, context: string): unknown[] {
  const reminder = { type: "text", text: `<system-reminder>\n${context}\n</system-reminder>` };
  if (typeof content === "string") return [reminder, { type: "text", text: content }];
  return [reminder, ...(Array.isArray(content) ? content : [])];
}

function systemText(content: unknown): string {
  if (typeof content === "string") return withoutBillingHeader(content);
  if (!Array.isArray(content)) throw new BoxMessagesShapeError("BOX_SYSTEM_UNSUPPORTED");
  return content.map((part) => {
    if (part === null || typeof part !== "object" || Array.isArray(part)
      || (part as { type?: unknown }).type !== "text"
      || typeof (part as { text?: unknown }).text !== "string") {
      throw new BoxMessagesShapeError("BOX_SYSTEM_UNSUPPORTED");
    }
    return withoutBillingHeader((part as { text: string }).text);
  }).filter(Boolean).join("\n\n");
}

/** OCV5-337: completed history written by another model (e.g. k3 `tool_…`,
 * OpenAI `call_…`) carries tool ids the Box CLI history never had, so a
 * session switched to Box Claude failed with BOX_BLOCK_UNSUPPORTED. Such
 * ids in history before the current user message are renamed, pair by pair,
 * to a stable toolu_ id derived from the original. The current message is
 * not touched: a live exchange always has the Box CLI's own ids. */
const BOX_TOOL_ID = /^toolu_[A-Za-z0-9_-]{1,120}$/;
const FOREIGN_TOOL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
function boxHistoryToolId(id: string): string {
  return `toolu_oc${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}
function remapForeignToolIds(messages: unknown[], currentIndex: number): unknown[] {
  const used = new Set<string>();
  const foreign = new Set<string>();
  messages.forEach((message, index) => {
    for (const block of blocks((message as { content?: unknown } | null)?.content)) {
      const id = block.type === "tool_use" ? block.id : block.type === "tool_result" ? block.tool_use_id : undefined;
      if (typeof id !== "string") continue;
      if (BOX_TOOL_ID.test(id)) used.add(id);
      else if (index < currentIndex && FOREIGN_TOOL_ID.test(id)) foreign.add(id);
    }
  });
  if (foreign.size === 0) return messages;
  const renamed = new Map([...foreign].map((id) => [id, boxHistoryToolId(id)]));
  if ([...renamed.values()].some((id) => used.has(id))) throw new BoxMessagesShapeError("BOX_TOOL_HISTORY_INVALID");
  return messages.map((message, index) => {
    if (index >= currentIndex || !Array.isArray((message as { content?: unknown } | null)?.content)) return message;
    const content = (message as { content: unknown[] }).content.map((part) => {
      if (part === null || typeof part !== "object" || Array.isArray(part)) return part;
      const block = part as Record<string, unknown>;
      if (block.type === "tool_use" && typeof block.id === "string" && renamed.has(block.id)) {
        return { ...block, id: renamed.get(block.id) };
      }
      if (block.type === "tool_result" && typeof block.tool_use_id === "string" && renamed.has(block.tool_use_id)) {
        return { ...block, tool_use_id: renamed.get(block.tool_use_id) };
      }
      return part;
    });
    return { ...(message as Record<string, unknown>), content };
  });
}

function validateContent(content: unknown, role: "user" | "assistant"): void {
  if (typeof content === "string") return;
  if (!Array.isArray(content) || content.length === 0 || blocks(content).length !== content.length) {
    throw new BoxMessagesShapeError("BOX_CONTENT_INVALID");
  }
  for (const block of blocks(content)) {
    if (block.type === "text" && typeof block.text === "string") continue;
    if (block.type === "tool_use" && role === "assistant"
      && typeof block.id === "string" && /^toolu_[A-Za-z0-9_-]{1,120}$/.test(block.id)
      && typeof block.name === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(block.name)
      && block.input !== null && typeof block.input === "object" && !Array.isArray(block.input)) continue;
    if (block.type === "tool_result" && role === "user"
      && typeof block.tool_use_id === "string"
      && /^toolu_[A-Za-z0-9_-]{1,120}$/.test(block.tool_use_id)
      && (block.is_error === undefined || typeof block.is_error === "boolean")
      && (typeof block.content === "string"
        || (Array.isArray(block.content) && block.content.length > 0
          && block.content.every((part) => part !== null && typeof part === "object"
            && !Array.isArray(part)
            && ((part.type === "text" && typeof part.text === "string")
              || strictBoxImageBlock(part) !== null))))) continue;
    // Preserve signed completed thinking history exactly. It is not rendered
    // as plaintext or treated as a new model request; malformed signatures
    // and unsupported extra fields still fail closed.
    if (role === "assistant" && block.type === "thinking"
      && Object.keys(block).sort().join(",") === "signature,thinking,type"
      && typeof block.thinking === "string"
      && typeof block.signature === "string" && block.signature.length > 0) continue;
    if (role === "assistant" && block.type === "redacted_thinking"
      && Object.keys(block).sort().join(",") === "data,type"
      && typeof block.data === "string" && block.data.length > 0) continue;
    // OCV5-377: Claude Code's own images after tool results (staged inside
    // the last result for the Box CLI, see compileBoxCliSyntheticTurn).
    if (role === "user" && block.type === "image" && strictBoxImageBlock(block) !== null
      && blocks(content).some((item) => item.type === "tool_result")) continue;
    // No silent multimodal or unknown thinking downgrade.
    throw new BoxMessagesShapeError("BOX_BLOCK_UNSUPPORTED");
  }
}

function readMessage(raw: unknown): Message {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BoxMessagesShapeError("BOX_MESSAGE_INVALID");
  }
  const item = raw as Record<string, unknown>;
  if (item.role !== "user" && item.role !== "assistant" && item.role !== "system") {
    throw new BoxMessagesShapeError("BOX_ROLE_UNSUPPORTED");
  }
  if (item.role === "system") systemText(item.content);
  else validateContent(item.content, item.role);
  return { role: item.role, content: item.content };
}

export interface BoxCliSyntheticTurn {
  sessionId: string;
  /** Stage this JSONL as projects/<CLI cwd key>/<sessionId>.jsonl. */
  snapshotJsonl: string;
  stdinJsonl: string;
  systemPrompt: string;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    const item = part as { type?: unknown; text?: unknown };
    return item?.type === "text" && typeof item.text === "string" ? item.text : "[image]";
  }).join("\n");
}

/**
 * OCV5-299: the CLI only exposes this invocation's virtual-MCP aliases
 * (mcp__ocbridge__tN). Completed history arrives with the OpenClaude client
 * names (Bash, Read, …). Staged verbatim, the model imitates those names on a
 * continued session, the CLI answers "No such tool available", and the run is
 * lost. Rename every historical call to the alias of the same client tool in
 * this catalog; a call whose tool is absent from this catalog (or any call in
 * a tool-less text turn) becomes plain text together with its result, so no
 * uncallable name remains in the transcript. Only the staged snapshot changes;
 * the canonical body, fingerprints and hashes are untouched.
 */
function aliasHistory(history: Message[], aliases: ReadonlyMap<string, string>): Message[] {
  const demoted = new Map<string, string>();
  return history.map((message) => {
    if (typeof message.content === "string") return message;
    const content = blocks(message.content).map((block): Block => {
      if (message.role === "assistant" && block.type === "tool_use") {
        const name = block.name as string;
        const alias = aliases.get(name);
        if (alias) return { ...block, name: alias };
        demoted.set(block.id as string, name);
        // Full fidelity: nothing is truncated; the snapshot byte ceiling still applies.
        return { type: "text", text: `[Earlier call to tool "${name}", not available in this turn. `
          + `Input: ${JSON.stringify(block.input)}]` };
      }
      if (message.role === "user" && block.type === "tool_result"
        && demoted.has(block.tool_use_id as string)) {
        const name = demoted.get(block.tool_use_id as string)!;
        return { type: "text", text: `[Result of earlier "${name}" call${block.is_error === true ? " (error)" : ""}: `
          + `${resultText(block.content)}]` };
      }
      return block;
    });
    return { ...message, content };
  });
}

/** Claude Code's own sentence for resuming an interrupted turn. */
export const BOX_CLI_RESUME_PROMPT = "Continue from where you left off.";

export function compileBoxCliSyntheticTurn(body: ProxyBody, args: {
  cwd: string;
  cliVersion: string;
  sessionId?: string;
  /** Client tool name -> CLI-visible alias for this invocation. When given,
   * history is staged with callable names only (see aliasHistory). */
  toolAliases?: ReadonlyMap<string, string>;
  /** OCV5-304: allow the current user message to be only the results of the
   * previous assistant's tool calls (a tool exchange whose live Box owner is
   * gone, e.g. a recovered dispatch). */
  resumeToolResults?: boolean;
  /** OCV5-384: context records of the session's previous native transcript, staged right
   * after the first user message where the CLI keeps them (see boxTranscriptAttachments). */
  stagedAttachments?: readonly Record<string, unknown>[];
}): BoxCliSyntheticTurn {
  if (!/^\/tmp\/ocv5-289-run-[a-f0-9]{24}$/.test(args.cwd)
    || args.cliVersion !== "2.1.280") {
    throw new BoxMessagesShapeError("BOX_RUN_IDENTITY_INVALID");
  }
  const sessionId = args.sessionId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sessionId)) {
    throw new BoxMessagesShapeError("BOX_SESSION_ID_INVALID");
  }
  let semantic: ProxyBody;
  try { semantic = normalizeBoxSemanticBody(body, { collapseSingleText: false }); }
  catch (error) {
    if (error instanceof BoxCacheAnnotationError) {
      throw new BoxMessagesShapeError(error.code);
    }
    throw error;
  }
  let lastUser = -1;
  semantic.messages.forEach((message, index) => {
    if ((message as { role?: unknown } | null)?.role === "user") lastUser = index;
  });
  // CCB may append a separate deferred-tools reminder after normalizing user
  // messages. Keep the current text-only user tail together: staging its goal
  // as unanswered history makes Claude's resume loader insert "No response
  // requested." before the reminder. A completed tool result is a history
  // boundary; merging it into a fresh prompt would require a live continuation.
  const isTextUser = (raw: unknown): boolean => {
    const message = raw as { role?: unknown; content?: unknown } | null;
    if (message?.role !== "user") return false;
    if (typeof message.content === "string") return true;
    return Array.isArray(message.content) && message.content.length > 0
      && message.content.every((block) => block !== null && typeof block === "object"
        && !Array.isArray(block) && block.type === "text" && typeof block.text === "string");
  };
  let currentStart = lastUser;
  if (isTextUser(semantic.messages[lastUser])) {
    for (let index = lastUser - 1; index >= 0; index--) {
      const message = semantic.messages[index] as { role?: unknown; content?: unknown } | null;
      if (message?.role === "system") continue;
      if (!isTextUser(message)) break;
      currentStart = index;
    }
  }
  const messages = remapForeignToolIds(semantic.messages, currentStart).map(readMessage);
  let currentIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") { currentIndex = index; break; }
  }
  if (currentIndex < 0 || messages.slice(currentIndex + 1).some((message) => message.role !== "system")) {
    throw new BoxMessagesShapeError("BOX_CURRENT_USER_REQUIRED");
  }
  let current = messages[currentIndex]!;
  if (currentStart < currentIndex) {
    current = { ...current, content: messages.slice(currentStart, currentIndex + 1)
      .filter((message) => message.role === "user")
      .flatMap((message) => typeof message.content === "string"
        ? [{ type: "text", text: message.content }] : blocks(message.content)) };
  }
  let resumed = false;
  let prompt: Block[] | null = null;
  if (blocks(current.content).some((block) => block.type === "tool_result")) {
    // OCV5-304: Claude Code 2.1.280 drops a stdin tool_result that answers a
    // snapshot's dangling tool_use. Stage the complete exchange as history and
    // continue with Claude Code's own resume sentence; the pairing check below
    // still requires every tool_use to be answered exactly once.
    // OCV5-322: results followed only by text are that exchange plus a new
    // prompt (Claude Code merged them); the text becomes the stdin prompt.
    // OCV5-377: images may follow too (e.g. Claude Code's own resized-image
    // blocks). The Box CLI takes images only inside tool results, so they
    // join the last result, beside the images that Read already returned.
    const all = Array.isArray(current.content) ? current.content : [];
    const cut = all.findIndex((block) => blocks([block])[0]?.type !== "tool_result");
    const tail = cut < 0 ? [] : all.slice(cut);
    const isText = (block: unknown): boolean => {
      const [item] = blocks([block]);
      return item?.type === "text" && typeof item.text === "string" && item.text.trim().length > 0;
    };
    const isImage = (block: unknown): boolean => blocks([block])[0]?.type === "image";
    const answeredTail = tail.length > 0 && tail.every((block) => isText(block) || isImage(block));
    if (!args.resumeToolResults || cut === 0 || (tail.length > 0 && !answeredTail)) {
      throw new BoxMessagesShapeError("BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION");
    }
    if (answeredTail) {
      const results = all.slice(0, cut) as Block[];
      const images = tail.filter(isImage) as Block[];
      if (images.length > 0) {
        const last = results[results.length - 1]!;
        const prior = typeof last.content === "string"
          ? (last.content.length > 0 ? [{ type: "text", text: last.content }] : [])
          : Array.isArray(last.content) ? last.content : [];
        results[results.length - 1] = { ...last, content: [...prior, ...images] };
      }
      const texts = tail.filter(isText) as Block[];
      if (texts.length > 0) prompt = texts;
      current = { ...current, content: results };
    }
    resumed = true;
  }
  const promptParts: string[] = [];
  if (semantic.system !== undefined) promptParts.push(systemText(semantic.system));
  for (const message of messages) {
    if (message.role === "system") promptParts.push(systemText(message.content));
  }
  const history = messages.slice(0, currentStart).filter((message) => message.role !== "system");
  if (resumed) {
    history.push(current);
    current = { ...current, content: prompt ?? BOX_CLI_RESUME_PROMPT };
  }
  const pending = new Set<string>();
  for (const message of history) {
    for (const block of blocks(message.content)) {
      if (block.type === "tool_use") {
        const id = block.id as string;
        if (message.role !== "assistant" || pending.has(id)) {
          throw new BoxMessagesShapeError("BOX_TOOL_HISTORY_INVALID");
        }
        pending.add(id);
      }
      if (block.type === "tool_result") {
        if (message.role !== "user" || !pending.delete(block.tool_use_id as string)) {
          throw new BoxMessagesShapeError("BOX_TOOL_HISTORY_INVALID");
        }
      }
    }
  }
  if (pending.size) throw new BoxMessagesShapeError("BOX_PENDING_TOOL_REQUIRES_LIVE_INVOCATION");
  const aliased = args.toolAliases ? aliasHistory(history, args.toolAliases) : history;
  const split = splitSessionContext(promptParts.filter(Boolean).join("\n\n"));
  const staged = split.context && aliased[0]?.role === "user"
    ? [{ ...aliased[0], content: withSessionContext(aliased[0].content, split.context) },
      ...aliased.slice(1)]
    : aliased;
  const currentContent = split.context && staged === aliased
    ? withSessionContext(current.content, split.context) : current.content;

  const timestamp = new Date().toISOString();
  let parentUuid: string | null = null;
  let pendingAttachments = args.stagedAttachments ?? [];
  const records: Record<string, unknown>[] = [];
  for (const message of staged) {
    const uuid = randomUUID();
    const base = { parentUuid, isSidechain: false, type: message.role, uuid,
      timestamp, cwd: args.cwd, sessionId, version: args.cliVersion };
    parentUuid = uuid;
    records.push(message.role === "user"
      ? { ...base, message: { role: "user", content: message.content } }
      : { ...base, message: { id: `msg_${uuid.replaceAll("-", "")}`, type: "message",
        role: "assistant", model: semantic.model, content: message.content,
        stop_reason: blocks(message.content).some((block) => block.type === "tool_use")
          ? "tool_use" : "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 } } });
    if (message.role === "user" && pendingAttachments.length > 0) {
      for (const record of pendingAttachments) {
        const recordUuid = randomUUID();
        records.push({ ...record, parentUuid, uuid: recordUuid, sessionId, cwd: args.cwd,
          isSidechain: false, ...("session_id" in record ? { session_id: sessionId } : {}) });
        parentUuid = recordUuid;
      }
      pendingAttachments = [];
    }
  }
  return {
    sessionId,
    snapshotJsonl: records.length ? records.map((record) => JSON.stringify(record)).join("\n") + "\n" : "",
    stdinJsonl: JSON.stringify({ type: "user", message: { role: "user", content: currentContent } }) + "\n",
    systemPrompt: split.system,
  };
}
