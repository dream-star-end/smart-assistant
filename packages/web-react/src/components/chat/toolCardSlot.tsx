/**
 * 与并行 ToolCard agent 的 props 契约（单一权威）。
 *
 * 约定：工具卡消费**一条 role==='tool' 的 ChatMessage**，或 agent-group 的同形子块
 * （ChildBlock，kind==='tool_use'），读取其 tool 专属字段（toolName / inputJson /
 * partialJson / inputPreview / _partial / _completed / output / error / bashTail）
 * 自行渲染二级工具体。ToolCard.tsx 由并行 agent 实现，其入参 `ToolLike` 是
 * `ChatMessage | ChildBlock` 的结构超集（更宽容），故二者可直接赋值、无需 cast。
 *
 * 本 P5 子树**不改 ToolCard.tsx，只 import**。MessageRenderer / AgentGroupCard 统一经
 * 本文件的 ToolCardSlot 调用 ToolCard —— 单一接缝，便于后续契约演进只改一处。
 */
import type { ChatMessage, ChildBlock } from "../../lib/chat/model";
import { ToolCard } from "../ToolCard";

/** tool 卡入参：一条 role==='tool' 的 ChatMessage，或 agent-group 的同形子块。 */
export type ToolCardProps = { message: ChatMessage | ChildBlock };

export const ToolCardSlot = ToolCard;
