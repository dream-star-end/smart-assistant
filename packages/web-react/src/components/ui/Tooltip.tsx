import * as RT from "@radix-ui/react-tooltip";
import { createContext, useContext, type ReactNode } from "react";
import { cn } from "../../lib/utils";

const HasTooltipProviderContext = createContext(false);

/** 挂在 App 根部一次,内部所有 Tooltip 共享延迟/分组。 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <HasTooltipProviderContext.Provider value={true}>
      <RT.Provider delayDuration={300} skipDelayDuration={150}>
        {children}
      </RT.Provider>
    </HasTooltipProviderContext.Provider>
  );
}

export function Tooltip({
  content,
  children,
  side = "top",
  sideOffset = 6,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
}) {
  const hasProvider = useContext(HasTooltipProviderContext);
  if (!content) return <>{children}</>;
  const body = (
    <RT.Root>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          side={side}
          sideOffset={sideOffset}
          className={cn(
            "oc-tooltip-card z-[var(--z-tooltip)] max-w-xs select-none rounded-md px-2.5 py-1.5 text-meta font-medium leading-snug",
            "data-[state=delayed-open]:animate-pop data-[state=instant-open]:animate-pop data-[state=closed]:oc-pop-out",
          )}
        >
          {content}
          <RT.Arrow className="fill-primary" />
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
  return hasProvider ? body : <TooltipProvider>{body}</TooltipProvider>;
}
