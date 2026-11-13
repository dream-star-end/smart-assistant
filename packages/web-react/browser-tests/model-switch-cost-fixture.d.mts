import type { ModelSwitchCostRequest, ModelSwitchCostQuote } from '@openclaude/protocol/browser'
export function fixtureExecutionModel(
  frame: { agentId?: string; teamMode?: boolean; model?: string } | null | undefined,
): string | null
export function fixtureSwitchQuote(
  input: ModelSwitchCostRequest,
  options?: { empty?: boolean; sourceModel?: string | null },
): ModelSwitchCostQuote
