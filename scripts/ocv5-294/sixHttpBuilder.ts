/** Pure response text. The only input is the fifth tool_result text. */
const NONCE = /^[0-9a-f]{32}$/;

export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error("TOOL_RESULT_CONTENT_INVALID");
  const text = content.map((block) => {
    if (!block || typeof block !== "object" || (block as { type?: string }).type !== "text"
      || typeof (block as { text?: unknown }).text !== "string") {
      throw new Error("TOOL_RESULT_CONTENT_INVALID");
    }
    return (block as { text: string }).text;
  }).join("");
  return text;
}

export function buildFinalFromFifthResult(toolResultTextValue: string): string {
  if (!NONCE.test(toolResultTextValue)) throw new Error("FIFTH_RESULT_NOT_NONCE");
  return toolResultTextValue;
}

export function verifyFinal(cliResult: string, mcpNonce: string): boolean {
  return cliResult === mcpNonce;
}

export function chainCountOk(httpCount: number, toolUses: number, mcpExecs: number): boolean {
  return httpCount === 6 && toolUses === 5 && mcpExecs === 5;
}

export type RunFacts = {
  http: number;
  toolUses: number;
  mcpOk: number;
  mcpRejected: boolean;
  cliExit: number;
  cliFinal: string | null;
  expectedNonce: string;
  verifyStatus: number;
  toolsExact: boolean;
};

/** First hard failure of a finished run. Null only for the exact 5/5/6 success shape. */
export function decideRun(facts: RunFacts): string | null {
  if (!facts.toolsExact) return "TOOLS_NOT_EXACT";
  if (facts.mcpRejected) return "MCP_REJECT";
  if (!chainCountOk(facts.http, facts.toolUses, facts.mcpOk)) return "COUNT";
  if (facts.cliExit !== 0 || facts.cliFinal === null) return "CLI_FINAL_MISSING";
  if (!verifyFinal(facts.cliFinal, facts.expectedNonce)) return "CLI_NONCE_MISMATCH";
  if (facts.verifyStatus !== 0) return "VERIFY_FAILED";
  return null;
}
