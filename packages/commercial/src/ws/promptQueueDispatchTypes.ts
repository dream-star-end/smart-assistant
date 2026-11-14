import type { CursorContextTier } from "@openclaude/protocol";
import type { ServiceTier } from "@openclaude/protocol";

export const PROMPT_QUEUE_DISPATCH_REQUEST_TYPE = "outbound.prompt_queue.dispatch_request";
export const PROMPT_QUEUE_DISPATCH_RESULT_TYPE = "outbound.prompt_queue.dispatch_result";
export const PROMPT_QUEUE_DISPATCH_CANCEL_TYPE = "outbound.prompt_queue.dispatch_cancel";
export const PROMPT_QUEUE_DISPATCH_ACTIVATED_TYPE = "outbound.prompt_queue.dispatch_activated";
export const PROMPT_QUEUE_GRANT_FIELD = "__oc_prompt_queue_grant";

export interface PromptQueueDispatchRequest {
  type: typeof PROMPT_QUEUE_DISPATCH_REQUEST_TYPE;
  grantId: string;
  owner: {
    sessionKey: string;
    clientSessionId: string;
    agentId: string;
    peer: { id: string; kind: "dm" };
  };
  claim: { epoch: string; claimToken: string };
  item: {
    itemId: string;
    clientMessageId: string;
    contentHash: string;
    content: Record<string, unknown>;
    requestedExecution: {
      agentId: string;
      model?: string;
      modelSwitchId?: string;
      modelSwitchConsent?: string;
      effortLevel?: string | null;
      teamMode?: boolean;
      collabMode?: "solo" | "advisor" | "team";
      advisorModel?: string;
      collabConfigVersion?: string;
      contextTier?: CursorContextTier;
      serviceTier?: ServiceTier | null;
    };
  };
}

export interface PromptQueueDispatchResult {
  type: typeof PROMPT_QUEUE_DISPATCH_RESULT_TYPE;
  grantId: string;
  owner: PromptQueueDispatchRequest["owner"];
  itemId: string;
  contentHash: string;
  epoch: string;
  claimToken: string;
  outcome: "rejected";
  disposition: "retryable" | "user_action_required";
  reasonCode: string;
}

export interface PromptQueueDispatchCancel {
  type: typeof PROMPT_QUEUE_DISPATCH_CANCEL_TYPE;
  grantId: string;
  owner: PromptQueueDispatchRequest["owner"];
  itemId: string;
  contentHash: string;
  epoch: string;
  claimToken: string;
  reasonCode: string;
}

export interface PromptQueueDispatchActivated {
  type: typeof PROMPT_QUEUE_DISPATCH_ACTIVATED_TYPE;
  grantId: string;
  owner: PromptQueueDispatchRequest["owner"];
  itemId: string;
  contentHash: string;
  epoch: string;
  claimToken: string;
}

