import { lazy, useState, type ComponentProps } from "react";
import { LazyBoundary } from "./ChunkErrorBoundary";
import { DialogFallback } from "./DialogFallback";

const AgentPicker = lazy(() => import("./AgentPicker").then((m) => ({ default: m.AgentPicker })));

/** Download on first open, then keep the picker's state across close/reopen. */
export function LazyAgentPicker(props: ComponentProps<typeof AgentPicker>) {
  const [mounted, setMounted] = useState(props.open);
  if (props.open && !mounted) setMounted(true);
  if (!props.open && !mounted) return null;
  return (
    <LazyBoundary fallback={props.open ? <DialogFallback /> : null}>
      <AgentPicker {...props} />
    </LazyBoundary>
  );
}
