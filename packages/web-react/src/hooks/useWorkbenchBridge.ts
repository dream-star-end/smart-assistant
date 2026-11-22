import type { ServiceTier } from "@openclaude/protocol/browser";
import { useEffect, useRef } from "react";
import type { PaneRequest, PaneTab } from "../components/chat/inspectorState";
import { subscribeSessionServiceTier } from "../lib/sessionServiceTier";
import { subscribeOpenInWorkbench, type WorkbenchOpenRequest } from "../lib/workbenchOpen";

function resolveWorkbenchTab(tab: WorkbenchOpenRequest["tab"]): PaneTab | "changes" {
  switch (tab) {
    case "browser":
      return "browser";
    case "changes":
      return "changes";
    case "details":
      return "steps";
    case "summary":
    case "team":
      return "plan";
    default:
      return "outputs";
  }
}

/**
 * Bridges cross-surface runtime events into App workspace state:
 *  1. `oc:open-workbench` events (from Deliverables / SignedFileCard / research cards)
 *     open the right-hand InspectorPanel focused on the requested target artifact.
 *  2. Cross-tab `storage` events on `oc_v5_service_tier:<activeId>` keep the active
 *     session's speed tier (Fast / Ultrafast) synchronized across tabs.
 */
export function useWorkbenchBridge(opts: {
  demo: boolean;
  activeId: string | undefined;
  activeIdRef: React.RefObject<string | null>;
  isWideRef: React.RefObject<boolean>;
  setPaneRequest: React.Dispatch<React.SetStateAction<PaneRequest | null>>;
  setPaneOpen: (open: boolean) => void;
  setPaneSheetOpen: React.Dispatch<React.SetStateAction<boolean>>;
  serviceTier: ServiceTier | null;
  setServiceTier: (tier: ServiceTier | null) => void;
}): void {
  const {
    demo,
    activeId,
    activeIdRef,
    isWideRef,
    setPaneRequest,
    setPaneOpen,
    setPaneSheetOpen,
    serviceTier,
    setServiceTier,
  } = opts;

  const serviceTierRef = useRef(serviceTier);
  serviceTierRef.current = serviceTier;

  useEffect(() => {
    return subscribeOpenInWorkbench((req) => {
      setPaneRequest({
        tab: resolveWorkbenchTab(req.tab),
        nonce: Date.now(),
        sessionId: activeIdRef.current,
        targetPath: req.path,
        targetTitle: req.title,
        manifestSrc: req.manifestSrc,
        previewUrl: req.previewUrl,
      });
      if (isWideRef.current) setPaneOpen(true);
      else setPaneSheetOpen(true);
    });
  }, [activeIdRef, isWideRef, setPaneOpen, setPaneRequest, setPaneSheetOpen]);

  useEffect(() => {
    if (demo || !activeId) return;
    return subscribeSessionServiceTier(activeId, (next) => {
      if (next !== serviceTierRef.current) setServiceTier(next);
    });
  }, [demo, activeId, setServiceTier]);
}
