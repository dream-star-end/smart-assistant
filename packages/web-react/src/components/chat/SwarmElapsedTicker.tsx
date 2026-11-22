/**
 * SwarmElapsedTicker — Isolated 1-second timer leaf component.
 *
 * Keeps elapsed time updates strictly inside this leaf so parent trees
 * (SwarmBoardDrawer with up to 120 Markdown posts, SwarmInlineCard,
 * PinnedSwarmDock, LiveAgentCapsule) never re-render every second.
 * For terminal swarms (`active === false`), renders static total duration
 * (`startedAt` → `endedAt`) with zero active intervals.
 */
import { memo, useEffect, useState } from "react";
import { formatSwarmElapsed } from "./swarmUtils";

export const SwarmElapsedTicker = memo(function SwarmElapsedTicker({
  startedAt,
  endedAt,
  active,
  prefix,
  className,
  title,
  "data-testid": testId,
}: {
  startedAt?: number;
  endedAt?: number;
  active: boolean;
  prefix?: string;
  className?: string;
  title?: string;
  "data-testid"?: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active || !startedAt || startedAt <= 0) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active, startedAt]);

  if (!startedAt || startedAt <= 0) return null;
  const endRef = active ? now : endedAt;
  if (!active && (!endRef || endRef < startedAt)) return null;

  const text = formatSwarmElapsed(startedAt, endRef);
  if (!text) return null;

  return (
    <span data-testid={testId} title={title} className={className}>
      {prefix ? `${prefix}${text}` : text}
    </span>
  );
});
