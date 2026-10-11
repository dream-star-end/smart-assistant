// INC-20261009-UPLOAD-RETRY-ACCOUNT-SWITCH harness: real useAuth login/logout, real Composer,
// and the App's own onUpload path (api.uploadFile). Network is stubbed only at fetch, with
// synthetic identities; every /api/uploads request is recorded with the bearer it carried.
import { createRoot } from "react-dom/client";
import { Composer } from "../src/components/Composer";
import { ToastProvider, TooltipProvider } from "../src/components/ui";
import { useAuth } from "../src/hooks/useAuth";
import { api } from "../src/lib/api";

type Upload = { authorization: string; filename: string; status: number };
type Probe = { uploads: Upload[]; outcomes: string[]; coldStarts: number };
const probe: Probe = { uploads: [], outcomes: [], coldStarts: 1 };
(window as unknown as { __uploadProbe: Probe }).__uploadProbe = probe;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = urlOf(input);
  if (url.includes("/api/auth/login")) {
    const email = (JSON.parse(String(init?.body ?? "{}")) as { email?: string }).email ?? "";
    const id = email.startsWith("a@") ? "user-a" : "user-b";
    return json({ user: { id, email, display_name: email, role: "user", email_verified: true, credits: "0" },
      access_token: `synthetic-access-${id}`, access_exp: Math.floor(Date.now() / 1000) + 3600,
      refresh_exp: Math.floor(Date.now() / 1000) + 86400, remember: true, lane: null });
  }
  if (url.includes("/api/auth/logout")) return new Response(null, { status: 204 });
  if (url.includes("/api/uploads")) {
    const headers = new Headers(init?.headers);
    // The container is cold for the first attempt: 503 + Retry-After, as handleUpload answers.
    const status = probe.coldStarts > 0 ? 503 : 200;
    if (status === 503) probe.coldStarts -= 1;
    probe.uploads.push({ authorization: headers.get("authorization") ?? "",
      filename: decodeURIComponent(headers.get("x-filename") ?? ""), status });
    if (status === 503) return json({ error: { code: "CONTAINER_STARTING", message: "starting" } }, 503, { "retry-after": "1" });
    return json({ url: "/api/media/aaaa.png", mimeType: "image/png", size: 4 });
  }
  return json({}, 200);
};

function Harness() {
  const auth = useAuth({ demo: false, initialUser: null, onClearAuth: () => {} });
  // The App's uploadMedia: the Composer attachment goes through api.uploadFile with the live session.
  const onUpload = async (file: File) => {
    try {
      const r = await api.uploadFile(auth.authRef.current, file);
      probe.outcomes.push("uploaded");
      return { kind: "image", url: r.url, mimeType: r.mimeType, filename: file.name } as never;
    } catch (error) {
      probe.outcomes.push((error as Error).name || "Error");
      throw error;
    }
  };
  return (
    <TooltipProvider>
      <ToastProvider>
        <button type="button" onClick={() => void auth.login("a@example.test", "synthetic-password-a", "bypass")}>login A</button>
        <button type="button" onClick={() => void auth.login("b@example.test", "synthetic-password-b", "bypass")}>login B</button>
        <button type="button" onClick={() => auth.logout()}>logout</button>
        <output data-testid="account">{auth.user?.id ?? ""}</output>
        {auth.authed && auth.user ? <Composer key={auth.user.id} onSend={() => {}} onUpload={onUpload} /> : null}
      </ToastProvider>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
