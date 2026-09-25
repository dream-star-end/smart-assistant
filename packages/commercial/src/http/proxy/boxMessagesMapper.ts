/** OCV5-289: compile a completed Anthropic history into one isolated Claude CLI turn.
 *
 * This is a protocol experiment, not a routed production model. A current
 * tool_result is deliberately rejected: an in-flight tool call must be
 * delivered to the *same live CLI/MCP rendezvous*, not a resumed process.
 */
import { randomUUID } from "node:crypto";
import type { ProxyBody } from "./shared.js";
import { BoxCacheAnnotationError, normalizeBoxSemanticBody } from "./boxCacheAnnotations.js";

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

function systemText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new BoxMessagesShapeError("BOX_SYSTEM_UNSUPPORTED");
  return content.map((part) => {
    if (part === null || typeof part !== "object" || Array.isArray(part)
      || (part as { type?: unknown }).type !== "text"
      || typeof (part as { text?: unknown }).text !== "string") {
      throw new BoxMessagesShapeError("BOX_SYSTEM_UNSUPPORTED");
    }
    return (part as { text: string }).text;
  }).join("\n\n");
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
            && !Array.isArray(part) && part.type === "text" && typeof part.text === "string")))) continue;
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

export function compileBoxCliSyntheticTurn(body: ProxyBody, args: {
  cwd: string;
  cliVersion: string;
  sessionId?: string;
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
  const messages = semantic.messages.map(readMessage);
  let currentIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") { currentIndex = index; break; }
  }
  if (currentIndex < 0 || messages.slice(currentIndex + 1).some((message) => message.role !== "system")) {
    throw new BoxMessagesShapeError("BOX_CURRENT_USER_REQUIRED");
  }
  const current = messages[currentIndex]!;
  if (blocks(current.content).some((block) => block.type === "tool_result")) {
    throw new BoxMessagesShapeError("BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION");
  }
  const promptParts: string[] = [];
  if (semantic.system !== undefined) promptParts.push(systemText(semantic.system));
  for (const message of messages) {
    if (message.role === "system") promptParts.push(systemText(message.content));
  }
  const history = messages.slice(0, currentIndex).filter((message) => message.role !== "system");
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

  const timestamp = new Date().toISOString();
  let parentUuid: string | null = null;
  const records = history.map((message) => {
    const uuid = randomUUID();
    const base = { parentUuid, isSidechain: false, type: message.role, uuid,
      timestamp, cwd: args.cwd, sessionId, version: args.cliVersion };
    parentUuid = uuid;
    return message.role === "user"
      ? { ...base, message: { role: "user", content: message.content } }
      : { ...base, message: { id: `msg_${uuid.replaceAll("-", "")}`, type: "message",
        role: "assistant", model: semantic.model, content: message.content,
        stop_reason: blocks(message.content).some((block) => block.type === "tool_use")
          ? "tool_use" : "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 } } };
  });
  return {
    sessionId,
    snapshotJsonl: records.length ? records.map((record) => JSON.stringify(record)).join("\n") + "\n" : "",
    stdinJsonl: JSON.stringify({ type: "user", message: { role: "user", content: current.content } }) + "\n",
    systemPrompt: promptParts.filter(Boolean).join("\n\n"),
  };
}
