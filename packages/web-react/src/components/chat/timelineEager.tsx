import { createContext, useContext } from "react";

/** True only for the initial near-viewport tail so signed images may skip IO. */
export const TimelineEagerMediaContext = createContext(false);

export function useTimelineEagerMedia(): boolean {
  return useContext(TimelineEagerMediaContext);
}
