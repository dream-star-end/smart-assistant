import * as RS from "@radix-ui/react-switch";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/utils";

export function Switch({ className, ...props }: ComponentPropsWithoutRef<typeof RS.Root>) {
  return (
    <RS.Root
      className={cn(
        "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent outline-none transition-colors duration-150 ease-standard focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent data-[state=unchecked]:bg-border-strong",
        className,
      )}
      {...props}
    >
      <RS.Thumb className="pointer-events-none block size-5 rounded-full bg-white shadow-sm ring-0 transition-transform duration-150 ease-standard data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0" />
    </RS.Root>
  );
}
