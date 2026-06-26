import * as RT from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/** 挂在 App 根部一次,内部所有 Tooltip 共享延迟/分组。 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RT.Provider delayDuration={300} skipDelayDuration={150}>
      {children}
    </RT.Provider>
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
  if (!content) return <>{children}</>;
  return (
    <RT.Root>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          side={side}
          sideOffset={sideOffset}
          className={cn(
            "z-50 max-w-xs select-none rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-fg shadow-pop",
            "data-[state=delayed-open]:animate-fade",
          )}
        >
          {content}
          <RT.Arrow className="fill-primary" />
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}
