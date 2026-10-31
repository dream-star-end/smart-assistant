/** Release-gate proof: a blocking screen fails before the ready budget. */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const driver = `
import importlib.util, os, sys, threading, time
spec = importlib.util.spec_from_file_location("oc_box_host", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
class Fake:
    def __init__(self):
        self.ready = threading.Event()
        self.print_mode = False
        self.fatal = None
        self.run_dir = "/tmp"
    def launch(self):
        return True
    def read_stdin(self):
        return None
    def alive(self):
        return True
    def pane(self):
        return os.environ.get("PANE", "")
start = time.monotonic()
code = mod.run(Fake(), None, threading.Event())
sys.stdout.write("%s %.3f\\n" % (code, time.monotonic() - start))
`;

function screen(hostPy: string, pane: string, readyMs: string) {
  const result = spawnSync("/usr/bin/python3", ["-I", "-c", driver, hostPy], {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PANE: pane, OC_BOX_READY_MS: readyMs },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`ONBOARDING_SCREEN_PROOF: ${result.error?.message ?? result.stderr}`);
  }
  const [code, seconds] = result.stdout.trim().split(" ");
  return { code, seconds: Number(seconds), err: result.stderr.trim() };
}

export function proveBoxOnboardingScreen(candidate: string): string {
  const hostPy = join(candidate, "packages/gateway/box-bridge-mod/host.py");
  const theme = screen(hostPy, "Choose a theme\ncolorblind-friendly\n", "2000");
  if (theme.code !== "1" || theme.seconds >= 0.8 || theme.err !== "BOX_INTERACTIVE_ONBOARDING") {
    throw new Error(`ONBOARDING_SCREEN_THEME: ${theme.code} ${theme.seconds} ${theme.err}`);
  }
  const login = screen(hostPy, "Not logged in \u00b7 Run /login\n", "2000");
  if (login.code !== "1" || login.seconds >= 0.8 || login.err !== "BOX_INTERACTIVE_LOGIN_REQUIRED") {
    throw new Error(`ONBOARDING_SCREEN_LOGIN: ${login.code} ${login.seconds} ${login.err}`);
  }
  const ordinary = screen(hostPy, "Claude Code\n", "600");
  if (ordinary.seconds < 0.5 || !ordinary.err.includes("BOX_INTERACTIVE_NOT_READY timeout")) {
    throw new Error(`ONBOARDING_SCREEN_TIMEOUT: ${ordinary.seconds} ${ordinary.err}`);
  }
  return "[ocv5-box-onboarding-screen] PASS — a theme page and a logged-out page fail immediately with BOX_INTERACTIVE_ONBOARDING or BOX_INTERACTIVE_LOGIN_REQUIRED";
}
