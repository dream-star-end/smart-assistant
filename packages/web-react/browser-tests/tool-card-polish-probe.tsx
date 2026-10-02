// Shared exact production ToolCard fixture for desktop and isolated touch proof.
import { StrictMode } from "react";
import { ToolCard } from "../src/components/ToolCard";

const marketItems = Array.from({ length: 10 }, (_, index) => ({
  slug: `browser-skill-${index + 1}`,
  name: `浏览器能力 ${index + 1}`,
  kind: "skill",
  description: `适合场景 ${index + 1}`,
}));
export function ToolCardPolishProbe() {
  return (
  <StrictMode>
    <div style={{ width: 360, maxWidth: "100%" }}>
      <ToolCard
        message={{
          toolName: "Bash",
          inputJson: { command: "oc-market search browser" },
          output: JSON.stringify(marketItems),
          _completed: true,
        }}
      />
    </div>
  </StrictMode>
  );
}
