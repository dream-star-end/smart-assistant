/** Reap one process group this run owns. A dead leader does not skip descendants. */

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch { return false; }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try { process.kill(-pgid, signal); return true; }
  catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitGone(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return true;
    await new Promise((done) => setTimeout(done, 40));
  }
  return !groupAlive(pgid);
}

export async function reapOwnedGroup(pgid: number, termMs = 400): Promise<"gone" | "killed" | "stuck"> {
  if (!Number.isInteger(pgid) || pgid <= 1) return "stuck";
  if (!groupAlive(pgid)) return "gone";
  signalGroup(pgid, "SIGTERM");
  if (await waitGone(pgid, termMs)) return "killed";
  signalGroup(pgid, "SIGKILL");
  return await waitGone(pgid, termMs) ? "killed" : "stuck";
}

export { groupAlive };
