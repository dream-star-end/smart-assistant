import { BOX_API_MODELS } from "@openclaude/protocol";

/** Cleanup, stop and probe paths resolve the account a journal row already
 * pins. The model they pass only selects the account family (any Claude
 * model), not what runs. */
export const BOX_API_RESOLVE_MODEL = BOX_API_MODELS[0].upstreamModel;
