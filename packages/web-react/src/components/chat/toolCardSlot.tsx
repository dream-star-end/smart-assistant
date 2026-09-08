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
import { createContext, useContext } from "react";
import type { ChatMessage, ChildBlock } from "../../lib/chat/model";
import { ToolCard } from "../ToolCard";
import type { DisplayTokenUsage } from "./tokenUsage";
import { reopenPermissionUi } from "../../lib/chat/permissionPopupCoordinator";
import { Button } from "../ui";

export const PermissionToolReopenContext = createContext<{
  requestIdByToolUseId: Map<string, string>;
} | null>(null);

/** tool 卡入参：一条 role==='tool' 的 ChatMessage，或 agent-group 的同形子块。 */
export type ToolCardProps = {
  message: ChatMessage | ChildBlock;
  tokenUsage?: DisplayTokenUsage;
};

export function ToolCardSlot({ message, tokenUsage }: ToolCardProps) {
  const reopen = useContext(PermissionToolReopenContext);
  const toolUseId =
    (message as ChatMessage).toolUseId ??
    (message as ChatMessage).blockId ??
    (message as { blockId?: string }).blockId;
  const requestId =
    typeof toolUseId === "string" && reopen
      ? reopen.requestIdByToolUseId.get(toolUseId)
      : undefined;
  return (
    <div className="space-y-1">
      <ToolCard message={message} tokenUsage={tokenUsage} />
      {requestId ? (
        <Button
          size="sm"
          variant="ghost"
          shape="pill"
          data-testid="permission-tool-reopen"
          onClick={() => {
            reopenPermissionUi(requestId);
            const safe = requestId.replace(/["\\]/g, "");
            document
              .querySelector(`[data-permission-request="${safe}"] button`)
              ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          }}
        >
          打开待答
        </Button>
      ) : null}
    </div>
  );
}
