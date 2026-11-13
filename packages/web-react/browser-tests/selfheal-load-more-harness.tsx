// INC-20261009-SELFHEAL-LOAD-MORE-400 harness: the real selfheal admin page and real adminApi.
// The fixture backend enforces the real cap (INCIDENTS_MAX_LIMIT = 200 in admin/selfhealOps.ts):
// a larger limit is answered 400, exactly as the backend does.
import { createRoot } from "react-dom/client";
import { adminSession } from "../src/admin/auth";
import SelfhealPage from "../src/admin/pages/selfheal";
import { ToastProvider, TooltipProvider } from "../src/components/ui";

const MAX = 200;
const probe = { limits: [] as number[], rejected: 0 };
(window as unknown as { __selfhealProbe: typeof probe }).__selfhealProbe = probe;
const epoch = adminSession.beginIdentity();
if (!adminSession.commitToken(epoch, "synthetic-admin-token")) throw new Error("fixture identity rejected");
const INC = { id: "9", status: "open", severity: "critical", surface: "chat", user_title: "服务不可用",
  opened_at: "2026-07-11T00:00:00Z", updated_at: "2026-07-11T00:10:00Z", latest_repair_status: null, latest_repair_at: null };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  const path = url.pathname.replace(/^\/api\/admin/, "");
  if (path === "/selfheal/incidents") {
    const limit = Number(url.searchParams.get("limit") ?? 50);
    probe.limits.push(limit);
    if (limit > MAX) { probe.rejected += 1; return json({ error: { code: "VALIDATION", message: `limit must be <= ${MAX}` } }, 400); }
    return json({ rows: [INC], next_before: "1", total: 999, open_total: 1, limit });
  }
  if (path === "/selfheal/conditions") return json({ rows: [] });
  if (path === "/selfheal/release-fuse") return json({ engaged: false });
  if (path === "/selfheal/user-notices") return json({ binding: { channelId: "5", bindingCode: "A1B2C3D4", active: false,
    boundIdentity: null, boundAt: null }, proposals: [] });
  return json({});
};
location.hash = "#tab=selfheal";
createRoot(document.getElementById("root")!).render(
  <ToastProvider><TooltipProvider><SelfhealPage /></TooltipProvider></ToastProvider>);
