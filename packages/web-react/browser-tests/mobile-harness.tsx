// 移动端拥挤顶栏 / 落地页导航的真浏览器壳。
// 只 stub 回调副作用；被测结构、Tailwind production CSS 与交互组件均为真实实现。
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Theme } from "../src/hooks/useTheme";
import { MAIN_AGENT } from "../src/lib/agents";
import type { PublicModel } from "../src/lib/types";
import { ChatHeader } from "../src/components/ChatHeader";
import { Landing } from "../src/components/Landing";

const MODELS: PublicModel[] = [
  { id: "glm-5.2", display_name: "GLM-5.2" },
  { id: "gpt-5.6-sol", display_name: "GPT-5.6-Sol" },
];

function record(action: string) {
  document.documentElement.dataset.mobileAction = action;
}

function MobileChromeProbe() {
  const [theme, setTheme] = useState<Theme>("light");
  const cycleTheme = () => {
    record("theme");
    setTheme((current) => current === "light" ? "dark" : "light");
  };

  return (
    <main>
      <section data-testid="crowded-chat-header">
        <ChatHeader
          agent={MAIN_AGENT}
          onAgentClick={() => record("agent")}
          models={MODELS}
          selectedModelId="glm-5.2"
          onSelectModel={(id) => record(`model:${id}`)}
          teamModeActive
          onDisableTeamMode={() => record("disable-team")}
          credits="12345678901234567890"
          onOpenBilling={() => record("billing")}
          onOpenMobileNav={() => record("menu")}
          onOpenInbox={() => record("inbox")}
          onOpenTutorial={() => record("tutorial")}
          unreadCount={128}
          theme={theme}
          onCycleTheme={cycleTheme}
        />
      </section>
      <Landing
        onStart={() => record("start")}
        onLogin={() => record("login")}
        onCreateOrg={() => record("create-org")}
        theme={theme}
        onCycleTheme={cycleTheme}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<MobileChromeProbe />);
